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
    get_following_with(url, extra, None, None).await
}

/// Whether a bearer token may be sent to this URL: only the Hub itself. A
/// redirect to a CDN host must not carry it -- the same rule the official
/// huggingface_hub client applies.
pub fn may_carry_token(url: &str) -> bool {
    match host_of(url) {
        Some(host) => host == "huggingface.co" || host.ends_with(".huggingface.co"),
        None => false,
    }
}

/// The GET behind every fetch here, following redirects by hand so each hop is
/// checked. `resume_from` becomes a Range header (a partial download picks up
/// where it stopped); `token` is sent only to hosts may_carry_token allows.
pub async fn get_following_with(
    url: &str,
    extra: &[String],
    resume_from: Option<u64>,
    token: Option<&str>,
) -> Result<reqwest::Response, String> {
    let client = client()?;
    let mut current = url.trim().to_string();
    for _ in 0..=MAX_REDIRECTS {
        if !is_allowed(&current, extra) {
            return Err(format!(
                "refused to reach {} (not on the allowlist)",
                host_of(&current).unwrap_or_else(|| current.clone())
            ));
        }
        let mut request = client.get(&current);
        if let Some(from) = resume_from {
            if from > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={}-", from));
            }
        }
        if let Some(t) = token {
            if !t.is_empty() && may_carry_token(&current) {
                request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", t));
            }
        }
        let response = request
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

/// The update-signing public key (roadmap 5.9), compiled in from the
/// NEURAOS_UPDATER_PUBKEY build variable: the base64 `tauri signer` prints. A
/// build without one keeps the sha256-only check; a build with one refuses a
/// manifest that is unsigned or signed by anyone else.
const UPDATER_PUBKEY: Option<&str> = option_env!("NEURAOS_UPDATER_PUBKEY");

/// Base64 text (as `tauri signer` writes keys and .sig files) -> the minisign
/// text inside it.
fn unbase64_text(value: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|e| format!("not base64: {}", e))?;
    String::from_utf8(bytes).map_err(|_| "not text".to_string())
}

/// Check `body` against a minisign signature with the compiled-in key.
pub fn verify_manifest(body: &str, signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let key_text = unbase64_text(pubkey_b64)?;
    let sig_text = unbase64_text(signature_b64)?;
    let key = minisign_verify::PublicKey::decode(&key_text).map_err(|e| format!("bad update key: {}", e))?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| format!("bad signature file: {}", e))?;
    key.verify(body.as_bytes(), &sig, true)
        .map_err(|_| "the update manifest's signature does not match NeuraOS's key".to_string())
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let response = get_following(url, &[]).await?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(format!("{} answered HTTP {}", url, status));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_GET_BYTES {
        return Err("response too large".to_string());
    }
    Ok(body)
}

/// The release's desktop-version.json, verified when this build carries an
/// update key: fetched with its .sig, and returned only if the signature holds.
/// The sha256 values inside are then what every installer download is checked
/// against, so a signed manifest covers the installer too.
#[tauri::command]
pub async fn update_manifest(url: String) -> Result<serde_json::Value, String> {
    let body = fetch_text(&url).await?;
    let key = match UPDATER_PUBKEY.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => key,
        None => return Ok(serde_json::json!({ "body": body, "signed": false })),
    };
    let signature = fetch_text(&format!("{}.sig", url))
        .await
        .map_err(|e| format!("this release is not signed ({}); refusing to update from it", e))?;
    verify_manifest(&body, &signature, key)?;
    Ok(serde_json::json!({ "body": body, "signed": true }))
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

/// Pages this shell will open in the user's browser: sign-in and release
/// pages. A command that opens an arbitrary URL is a command a page could
/// abuse, so the list is short and https-only.
pub const OPEN_HOSTS: &[&str] = &[
    "github.com",
    "huggingface.co",
    "puter.com",
    "*.puter.com",
    "unsloth.ai",
    "docs.unsloth.ai",
];

pub fn may_open(url: &str) -> bool {
    if scheme_of(url).as_deref() != Some("https") {
        return false;
    }
    match host_of(url) {
        Some(host) => OPEN_HOSTS.iter().any(|entry| host_matches(&host, entry)),
        None => false,
    }
}

/// Hand a URL to the default browser. Windows goes through `cmd start` with
/// no console window; elsewhere xdg-open.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    if !may_open(url) {
        return Err(format!(
            "refused to open {} (only https pages on {} are opened)",
            host_of(url).unwrap_or_else(|| url.to_string()),
            OPEN_HOSTS.join(", ")
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("cmd");
        // `start` treats & and ^ as shell characters; the URL is quoted so a
        // query string survives, and the empty "" is start's window title.
        cmd.args(["/d", "/s", "/c", "start", "", &url.replace('&', "^&")]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_in_browser(url.trim())
}

/// The OS half of open_in_browser, with no policy: callers decide what may be
/// opened. Windows goes through `cmd start` with no console window.
fn launch(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/d", "/s", "/c", "start", "", &url.replace('&', "^&")]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Whether a URL is a Puter sign-in page: https, puter.com, /action/sign-in.
pub fn is_puter_signin(url: &str) -> bool {
    if scheme_of(url).as_deref() != Some("https") {
        return false;
    }
    let host_ok = matches!(host_of(url).as_deref(), Some("puter.com"));
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    let path = rest.split_once('/').map(|(_, p)| p).unwrap_or("");
    host_ok && path.starts_with("action/sign-in?")
}

/// The redirect page: one line of script, the URL embedded as a JSON string
/// (with `<` escaped) so nothing in it can break out of the script.
pub fn redirect_page(url: &str) -> String {
    let literal = serde_json::to_string(url)
        .unwrap_or_else(|_| String::from("\"\""))
        .replace('<', "\\u003c");
    let mut page = String::new();
    page.push_str("<!doctype html><meta charset=\"utf-8\"><title>NeuraOS - Puter sign-in</title>");
    page.push_str("<body style=\"font:14px system-ui;background:#0b0d10;color:#c9d1d9;padding:32px\">Opening Puter sign-in...");
    page.push_str("<script>location.replace(");
    page.push_str(&literal);
    page.push_str(");</script>");
    page
}

/// Open Puter's sign-in page THROUGH a page of our own.
///
/// Puter's sign-in page renders nothing unless it was opened from another page
/// ("No referrer found" in its console): it names the referring site as the
/// app asking for the account. A URL launched by the OS has no referrer, which
/// is why the desktop's sign-in opened a blank tab. So the shell serves a
/// one-line redirect page on 127.0.0.1 for a few minutes and opens THAT; the
/// browser then arrives at Puter from `http://127.0.0.1:<port>/`.
///
/// The listener answers every request with the same page, accepts only the
/// sign-in URL it was started for, binds loopback only, and goes away on its
/// own.
#[tauri::command(async)]
pub fn puter_signin_open(url: String) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    let url = url.trim().to_string();
    if !is_puter_signin(&url) {
        return Err("only a puter.com sign-in page is opened this way".to_string());
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("no loopback port: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let page = redirect_page(&url);
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        let mut served = 0u32;
        while std::time::Instant::now() < deadline && served < 8 {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                    let mut buffer = [0u8; 2048];
                    let _ = stream.read(&mut buffer);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: origin\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        page.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(page.as_bytes());
                    let _ = stream.flush();
                    served += 1;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(150)),
            }
        }
    });
    launch(&format!("http://127.0.0.1:{}/", port))?;
    Ok(serde_json::json!({ "port": port }))
}

/// Whether a URL is the engine's GitHub sign-in: https (or loopback http for
/// a local engine) and exactly `/api/github/authorize`.
pub fn is_connect_url(url: &str) -> bool {
    let scheme = scheme_of(url).unwrap_or_default();
    let Some(host) = host_of(url) else { return false };
    if !(scheme == "https" || (scheme == "http" && is_loopback(&host))) {
        return false;
    }
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    let path = rest.split_once('/').map(|(_, p)| p).unwrap_or("");
    let path = path.split(['?', '#']).next().unwrap_or("");
    path == "api/github/authorize"
}

/// Connect an account in a SECOND WINDOW OF THIS APP.
///
/// The engine keys a GitHub connection to its session cookie. The system
/// browser has another cookie jar, so a sign-in there would connect GitHub to
/// a session this app is not using. A window of this app shares the webview's
/// cookies, so the engine sees the same session on the way out to GitHub and
/// on the way back. The window gets no commands (it shows remote pages), and
/// it is closed -- and `connect-finished` emitted -- as soon as navigation
/// returns to the engine outside the /api/github/ routes.
#[tauri::command]
pub async fn auth_window_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri::Emitter;
    let url = url.trim().to_string();
    if !is_connect_url(&url) {
        return Err("only the engine's GitHub sign-in is opened this way".to_string());
    }
    let target: tauri::Url = url.parse().map_err(|e| format!("not an address: {}", e))?;
    let engine_host = target.host_str().unwrap_or("").to_string();
    if let Some(existing) = app.get_webview_window("connect") {
        let _ = existing.destroy();
    }
    let handle = app.clone();
    tauri::WebviewWindowBuilder::new(&app, "connect", tauri::WebviewUrl::External(target))
        .title("Connect GitHub - NeuraOS")
        .inner_size(560.0, 760.0)
        .on_navigation(move |next| {
            let back_home = next.host_str() == Some(engine_host.as_str()) && !next.path().starts_with("/api/github/");
            if back_home {
                // The query says how it went (?gh=same&login=... when GitHub
                // handed back an account that was already connected).
                let landed = match next.query() {
                    Some(q) => format!("{}?{}", next.path(), q),
                    None => next.path().to_string(),
                };
                let _ = handle.emit("connect-finished", landed);
                if let Some(window) = handle.get_webview_window("connect") {
                    let _ = window.destroy();
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| format!("could not open the sign-in window: {}", e))?;
    Ok(())
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

/// A Windows path as a comparable string: lowercased, forward slashes turned
/// into backslashes, no trailing separator. Windows paths are
/// case-insensitive and `Path::starts_with` is not, so the comparison is done
/// on these strings instead.
fn folded_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    text.trim_end_matches('\\').to_string()
}

/// How this copy was installed, decided from facts the caller gathers so the
/// rule is testable without an install. The NSIS installer puts
/// `uninstall.exe` beside the app exe, and it may do so under Program Files
/// too (a per-machine install) -- so that fact is checked first. With no
/// uninstaller, an exe under Program Files was put there by the MSI (Windows
/// Installer keeps its uninstall entry elsewhere). Anything else -- Downloads,
/// the desktop, a USB stick -- is the portable exe, which must never be
/// replaced by running an installer.
fn kind_of(exe_dir: &Path, has_uninstaller: bool, program_dirs: &[PathBuf]) -> &'static str {
    if has_uninstaller {
        return "nsis";
    }
    let dir = folded_path(exe_dir);
    let under_program_files = program_dirs.iter().any(|root| {
        let root = folded_path(root);
        !root.is_empty() && (dir == root || dir.starts_with(&format!("{}\\", root)))
    });
    if under_program_files {
        "msi"
    } else {
        "portable"
    }
}

/// "nsis", "msi" or "portable": which artifact of a release updates this copy.
/// Running the other installer type over an install registers a second copy
/// with Windows instead of upgrading the first, and a portable exe is not
/// installed at all. A copy whose own location cannot be read is treated as
/// portable, the one kind that never runs anything.
#[tauri::command]
pub fn install_kind() -> String {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return "portable".to_string(),
    };
    let dir = match exe.parent() {
        Some(dir) => dir.to_path_buf(),
        None => return "portable".to_string(),
    };
    let has_uninstaller = dir.join("uninstall.exe").is_file();
    // All three: a 32-bit view of the environment reports the x86 folder as
    // ProgramFiles, and ProgramW6432 is where the 64-bit folder then lives.
    let program_dirs: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(PathBuf::from)
        .collect();
    kind_of(&dir, has_uninstaller, &program_dirs).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program_files() -> Vec<PathBuf> {
        vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ]
    }

    #[test]
    fn an_nsis_install_is_known_by_its_uninstaller() {
        let per_user = Path::new(r"C:\Users\Ann\AppData\Local\NeuraOS Desktop");
        assert_eq!(kind_of(per_user, true, &program_files()), "nsis");
        // A per-machine NSIS install also lives under Program Files; the
        // uninstaller beside the exe still says which installer put it there.
        let per_machine = Path::new(r"C:\Program Files\NeuraOS Desktop");
        assert_eq!(kind_of(per_machine, true, &program_files()), "nsis");
    }

    #[test]
    fn an_msi_install_lives_under_program_files_without_an_uninstaller() {
        let dir = Path::new(r"C:\Program Files\NeuraOS Desktop");
        assert_eq!(kind_of(dir, false, &program_files()), "msi");
        let x86 = Path::new(r"C:\Program Files (x86)\NeuraOS Desktop");
        assert_eq!(kind_of(x86, false, &program_files()), "msi");
    }

    #[test]
    fn anything_else_is_portable() {
        let downloads = Path::new(r"C:\Users\Ann\Downloads");
        assert_eq!(kind_of(downloads, false, &program_files()), "portable");
        // A folder that merely starts with the same letters is not inside it.
        let lookalike = Path::new(r"C:\Program Files Extra\NeuraOS");
        assert_eq!(kind_of(lookalike, false, &program_files()), "portable");
        // No Program Files variables at all: nothing can be called an MSI install.
        let dir = Path::new(r"C:\Program Files\NeuraOS Desktop");
        assert_eq!(kind_of(dir, false, &[]), "portable");
        assert_eq!(kind_of(dir, false, &[PathBuf::new()]), "portable");
    }

    #[test]
    fn program_files_is_compared_without_case_or_slash_differences() {
        let dir = Path::new(r"c:\PROGRAM FILES\NeuraOS Desktop");
        assert_eq!(kind_of(dir, false, &program_files()), "msi");
        let forward = Path::new("C:/Program Files/NeuraOS Desktop");
        assert_eq!(kind_of(forward, false, &program_files()), "msi");
        let trailing = vec![PathBuf::from(r"C:\Program Files\")];
        assert_eq!(kind_of(Path::new(r"C:\Program Files\NeuraOS Desktop"), false, &trailing), "msi");
    }

    fn extra(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_engines_github_sign_in_gets_a_window() {
        assert!(is_connect_url("https://engine.example.com/api/github/authorize"));
        assert!(is_connect_url("http://127.0.0.1:3000/api/github/authorize"));
        assert!(!is_connect_url("http://engine.example.com/api/github/authorize"), "http only on this machine");
        assert!(!is_connect_url("https://engine.example.com/api/github/authorize/x"));
        assert!(!is_connect_url("https://engine.example.com/login"));
        assert!(!is_connect_url("https://github.com/login/oauth/authorize"));
    }

    #[test]
    fn only_a_puter_sign_in_page_gets_the_redirect() {
        assert!(is_puter_signin("https://puter.com/action/sign-in?embedded_in_popup=true&msg_id=1"));
        assert!(!is_puter_signin("http://puter.com/action/sign-in?x=1"));
        assert!(!is_puter_signin("https://puter.com.evil.com/action/sign-in?x=1"));
        assert!(!is_puter_signin("https://puter.com/other?x=1"));
        assert!(!is_puter_signin("https://evil.com/action/sign-in?x=1"));
    }

    #[test]
    fn the_redirect_page_cannot_be_broken_out_of() {
        let page = redirect_page("https://puter.com/action/sign-in?a=\"</script><script>alert(1)//");
        assert!(page.contains("location.replace("));
        assert!(!page.contains("</script><script>alert"), "the URL is a JSON string with < escaped");
    }

    #[test]
    fn only_https_pages_on_the_short_list_are_opened() {
        assert!(may_open("https://puter.com/action/sign-in?x=1"));
        assert!(may_open("https://api.puter.com/x"));
        assert!(may_open("https://github.com/ggml-org/llama.cpp/releases/latest"));
        assert!(!may_open("http://puter.com/"));
        assert!(!may_open("https://example.com/"));
        assert!(!may_open("file:///C:/Windows/System32/calc.exe"));
        assert!(!may_open("https://puter.com.evil.com/"));
    }

    #[test]
    fn a_token_goes_to_the_hub_and_never_to_a_cdn_hop() {
        assert!(may_carry_token("https://huggingface.co/unsloth/x/resolve/main/y.gguf"));
        assert!(!may_carry_token("https://cas-bridge.xethub.hf.co/xet-bridge-us/abc"));
        assert!(!may_carry_token("https://cdn-lfs.hf.co/repos/x"));
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
