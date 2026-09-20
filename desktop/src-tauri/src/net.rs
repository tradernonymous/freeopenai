// The network edge the webview cannot be.
//
// A page may only fetch what CORS permits. Release assets
// (objects.githubusercontent.com), Hugging Face (huggingface.co, cdn-lfs*,
// cas-bridge.xethub.hf.co) and a local llama.cpp server all sit outside that
// permission -- which is why the update banner never fired in the packaged app
// even though the release published correct metadata.
//
// So the fetch happens here instead: https only (loopback http for a local
// model server), an explicit host allowlist re-checked on EVERY redirect hop,
// size ceilings, and a sha256 that is verified before the file is ever handed
// to a child process.
//
// `verified` in the download result is true only when the caller supplied an
// expected digest and it matched. A download with no expectation is recorded
// with its digest but not claimed as verified -- trust-on-first-use, labelled
// honestly rather than dressed up as integrity.
//
// The frontend carries the same host list in src/net-policy.js so it can refuse
// a URL before crossing the boundary with a readable message; test/desktop-net.test.js
// asserts the two lists are identical, so they cannot drift.
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Hosts this shell will talk to. A leading "*." matches any subdomain.
pub const DEFAULT_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "huggingface.co",
    "*.huggingface.co",
    "*.hf.co",
    "*.xethub.hf.co",
];

pub const MAX_REDIRECTS: usize = 5;
/// A JSON payload this shell asks for (release metadata, model lists) is small.
pub const MAX_GET_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_NAME_CHARS: usize = 120;

fn scheme_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    Some(scheme.to_ascii_lowercase())
}

/// The host of a URL, lowercased, port and credentials stripped. IPv6
/// literals keep their brackets so "::1" cannot be confused with a port.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if authority.starts_with('[') {
        match authority.find(']') {
            Some(end) => &authority[..=end],
            None => return None,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn origin_of(url: &str) -> Option<String> {
    let scheme = scheme_of(url)?;
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme, authority))
}

pub fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
}

fn host_matches(host: &str, entry: &str) -> bool {
    let entry = entry.trim().to_ascii_lowercase();
    if entry.is_empty() {
        return false;
    }
    if let Some(suffix) = entry.strip_prefix("*.") {
        return host == suffix || host.ends_with(&format!(".{}", suffix));
    }
    host == entry
}

/// The rule, in one place: https anywhere on the list, http only on loopback
/// (a local model server), everything else refused before a socket is opened.
pub fn is_allowed(url: &str, extra: &[String]) -> bool {
    let scheme = match scheme_of(url) {
        Some(s) => s,
        None => return false,
    };
    let host = match host_of(url) {
        Some(h) => h,
        None => return false,
    };
    if scheme == "http" {
        if !is_loopback(&host) {
            return false;
        }
    } else if scheme != "https" {
        return false;
    }
    if is_loopback(&host) {
        return true;
    }
    if DEFAULT_HOSTS.iter().any(|entry| host_matches(&host, entry)) {
        return true;
    }
    extra.iter().any(|entry| host_matches(&host, entry))
}

/// Where a redirect points. Absolute, scheme-relative, root-relative and
/// sibling-relative locations all resolve; anything else is refused rather than
/// guessed at.
pub fn resolve_location(base: &str, location: &str) -> Option<String> {
    let loc = location.trim();
    if loc.is_empty() || loc.starts_with('#') {
        return None;
    }
    if loc.contains("://") {
        return Some(loc.to_string());
    }
    if let Some(rest) = loc.strip_prefix("//") {
        return Some(format!("{}://{}", scheme_of(base)?, rest));
    }
    let origin = origin_of(base)?;
    if loc.starts_with('/') {
        return Some(format!("{}{}", origin, loc));
    }
    let without_query = base.split(['?', '#']).next().unwrap_or(base);
    let directory = match without_query.rfind('/') {
        Some(index) if index >= origin.len() => &without_query[..=index],
        _ => return Some(format!("{}/{}", origin, loc)),
    };
    Some(format!("{}{}", directory, loc))
}

/// A download file name: a base name only, safe characters only. The caller
/// never gets to choose a path, so no name can escape the downloads folder.
pub fn sanitize_name(name: &str) -> Result<String, String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        return Err("the download needs a file name".to_string());
    }
    Ok(cleaned)
}

fn downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory: {}", e))?
        .join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Redirects are followed by hand so each hop can be checked against the
        // allowlist; reqwest's own policy would jump to an unvetted host.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(180))
        .user_agent(concat!("FreeAI4U-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {}", e))
}

async fn get_following(url: &str, extra: &[String]) -> Result<reqwest::Response, String> {
    let client = client()?;
    let mut current = url.trim().to_string();
    for _ in 0..=MAX_REDIRECTS {
        if !is_allowed(&current, extra) {
            return Err(format!(
                "refused to reach {} (not on the allowlist)",
                host_of(&current).unwrap_or_else(|| current.clone())
            ));
        }
        let response = client
            .get(&current)
            .send()
            .await
            .map_err(|e| format!("{}: {}", current, e))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            match resolve_location(&current, location) {
                Some(next) => {
                    current = next;
                    continue;
                }
                None => return Err(format!("{} redirected without a usable location", current)),
            }
        }
        return Ok(response);
    }
    Err(format!("too many redirects from {}", url))
}

/// A small JSON/text fetch, outside the webview's CORS limits.
#[tauri::command]
pub async fn remote_get(
    url: String,
    extra_hosts: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let extra = extra_hosts.unwrap_or_default();
    let response = get_following(&url, &extra).await?;
    let status = response.status().as_u16();
    if let Some(length) = response.content_length() {
        if length > MAX_GET_BYTES {
            return Err(format!("response too large ({} bytes)", length));
        }
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_GET_BYTES {
        return Err("response too large".to_string());
    }
    Ok(serde_json::json!({ "status": status, "body": body }))
}

/// Download a file into the app's own downloads folder, hashing as it goes and
/// removing the file again if the digest does not match what was published.
#[tauri::command]
pub async fn remote_download(
    app: tauri::AppHandle,
    url: String,
    name: String,
    sha256: Option<String>,
    extra_hosts: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let extra = extra_hosts.unwrap_or_default();
    let file_name = sanitize_name(&name)?;
    let dir = downloads_dir(&app)?;
    let dest = dir.join(&file_name);

    let mut response = get_following(&url, &extra).await?;
    if !response.status().is_success() {
        return Err(format!("download failed with HTTP {}", response.status().as_u16()));
    }

    let mut hasher = Sha256::new();
    let mut file = std::fs::File::create(&dest)
        .map_err(|e| format!("cannot write {}: {}", dest.display(), e))?;
    let mut received: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
    }
    drop(file);

    let mut digest = String::with_capacity(64);
    for byte in hasher.finalize() {
        digest.push_str(&format!("{:02x}", byte));
    }

    let expected = sha256.unwrap_or_default().trim().to_ascii_lowercase();
    let had_expectation = expected.len() == 64 && expected.chars().all(|c| c.is_ascii_hexdigit());
    if had_expectation && expected != digest {
        let _ = std::fs::remove_file(&dest);
        return Err(format!("sha256 mismatch: downloaded {} but the release says {}", digest, expected));
    }

    Ok(serde_json::json!({
        "path": dest.display().to_string(),
        "name": file_name,
        "bytes": received,
        "sha256": digest,
        // True only when we actually checked it against a published digest.
        "verified": had_expectation,
    }))
}

#[cfg(windows)]
fn spawn_detached(program: &Path, args: &[String]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let mut command = std::process::Command::new(program);
    command.args(args);
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command.spawn().map(|_| ())
}

#[cfg(not(windows))]
fn spawn_detached(program: &Path, args: &[String]) -> std::io::Result<()> {
    std::process::Command::new(program).args(args).spawn().map(|_| ())
}

/// Run a downloaded installer and quit, so the installer is the only thing
/// touching the installed files. Only a file inside our own downloads folder is
/// accepted: a command that runs an arbitrary path is a command an attacker
/// would love.
#[tauri::command]
pub fn run_installer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = downloads_dir(&app)?;
    let allowed = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let target = std::fs::canonicalize(&path).map_err(|e| format!("installer not found: {}", e))?;
    if !target.starts_with(&allowed) {
        return Err("only a downloaded installer can be run".to_string());
    }
    let is_msi = target
        .extension()
        .map(|e| e.eq_ignore_ascii_case("msi"))
        .unwrap_or(false);
    let (program, args) = if is_msi {
        (
            PathBuf::from("msiexec"),
            vec!["/i".to_string(), target.display().to_string()],
        )
    } else {
        (target.clone(), Vec::new())
    };
    spawn_detached(&program, &args).map_err(|e| format!("could not start the installer: {}", e))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extra(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn https_on_the_list_is_allowed() {
        assert!(is_allowed("https://github.com/x/y", &[]));
        assert!(is_allowed("https://api.github.com/repos/a/b", &[]));
        assert!(is_allowed("https://huggingface.co/unsloth/x", &[]));
        assert!(is_allowed("https://cdn-lfs-us-1.huggingface.co/x", &[]));
        assert!(is_allowed("https://cas-bridge.xethub.hf.co/x", &[]));
    }

    #[test]
    fn http_is_loopback_only() {
        assert!(is_allowed("http://127.0.0.1:8080/v1/models", &[]));
        assert!(is_allowed("http://localhost:8080/health", &[]));
        assert!(!is_allowed("http://example.com/", &[]));
        assert!(!is_allowed("http://huggingface.co/", &[]));
    }

    #[test]
    fn unknown_hosts_and_schemes_are_refused() {
        assert!(!is_allowed("https://example.com/", &[]));
        assert!(!is_allowed("file:///C:/Windows/win.ini", &[]));
        assert!(!is_allowed("ftp://github.com/", &[]));
        assert!(!is_allowed("", &[]));
        assert!(!is_allowed("not a url", &[]));
        // A lookalike suffix must not pass a wildcard entry.
        assert!(!is_allowed("https://nothuggingface.co/x", &[]));
        assert!(!is_allowed("https://huggingface.co.evil.com/x", &[]));
    }

    #[test]
    fn extra_hosts_are_addable_but_still_https() {
        assert!(is_allowed("https://my-engine.up.railway.app/x", &extra(&["my-engine.up.railway.app"])));
        assert!(!is_allowed("http://my-engine.up.railway.app/x", &extra(&["my-engine.up.railway.app"])));
    }

    #[test]
    fn host_parsing_handles_ports_userinfo_and_ipv6() {
        assert_eq!(host_of("https://github.com:443/a").as_deref(), Some("github.com"));
        assert_eq!(host_of("https://user:pw@GitHub.com/a").as_deref(), Some("github.com"));
        assert_eq!(host_of("http://[::1]:8080/x").as_deref(), Some("[::1]"));
        assert_eq!(host_of("https://huggingface.co?a=b#c").as_deref(), Some("huggingface.co"));
        assert_eq!(host_of("nope"), None);
    }

    #[test]
    fn redirects_resolve_including_relative_ones() {
        assert_eq!(
            resolve_location("https://github.com/a/b", "https://objects.githubusercontent.com/c").as_deref(),
            Some("https://objects.githubusercontent.com/c")
        );
        assert_eq!(
            resolve_location("https://github.com/a/b", "/c/d").as_deref(),
            Some("https://github.com/c/d")
        );
        assert_eq!(
            resolve_location("https://github.com/a/b?x=1", "c").as_deref(),
            Some("https://github.com/a/c")
        );
        assert_eq!(
            resolve_location("https://github.com/a/b", "//objects.githubusercontent.com/c").as_deref(),
            Some("https://objects.githubusercontent.com/c")
        );
        assert_eq!(resolve_location("https://github.com/a/b", "#frag"), None);
    }

    #[test]
    fn file_names_cannot_escape_the_downloads_folder() {
        assert_eq!(sanitize_name("setup.exe").unwrap(), "setup.exe");
        assert_eq!(sanitize_name("../../evil.exe").unwrap(), "evil.exe");
        assert_eq!(sanitize_name(r"C:\Windows\evil.exe").unwrap(), "evil.exe");
        assert_eq!(sanitize_name("..").unwrap_err(), "the download needs a file name");
        assert_eq!(sanitize_name("   ").unwrap_err(), "the download needs a file name");
    }
}
