// NEURA-054 -- calling the user's own OpenAI-shaped endpoint, with their key.
//
// Why this is Rust and not a fetch() in the webview: the key. It lives in the
// OS credential store (secrets.rs) and the whole point of NEURA-054 is that it
// never reaches the page -- so the only place that can put it in an
// Authorization header is the side that can read it. The page hands over the
// secret's NAME (`byok.<id>`), never its value.
//
// The rule net.rs enforces is https on an explicit host allowlist, http only on
// loopback, re-checked on every redirect hop. A BYOK host cannot be on a
// compiled-in allowlist -- the user invents it -- so this command narrows the
// rule a different way instead of widening net.rs:
//
//   * the same scheme rule: https anywhere, http ONLY for a runtime on this
//     machine (a key over plain http on the network is a key in the clear);
//   * no credentials, query or fragment in the base URL, so a key can never be
//     talked into a URL;
//   * NO REDIRECTS AT ALL (`Policy::none()`, like ollama.rs). A 30x would
//     otherwise carry the Authorization header to a host the user never named,
//     which is the one thing an allowlist exists to prevent. A redirect is
//     surfaced as its status instead of followed.
//
// Nothing here logs, prints or emits the key: the events carry the status and
// the response bytes only, and diagnostics (diag.rs) never reads this module.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

/// `https://host[:port][/path]`, or http only on loopback. Returns the base
/// with trailing slashes removed; every refusal says why.
pub fn check_base(base: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("no endpoint address was given".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let scheme = match lower.split_once("://") {
        Some((scheme, rest)) if !rest.is_empty() => scheme.to_string(),
        _ => return Err(format!("{} is not a full address; it must start with https://", trimmed)),
    };
    let rest = trimmed.splitn(2, "://").nth(1).unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("leave the user:password out of the address; the key is read from the credential store".to_string());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("give the base URL only, with no query string: a key must never travel in a URL".to_string());
    }
    let host = crate::net::host_of(trimmed).ok_or_else(|| format!("{} has no host", trimmed))?;
    if scheme == "http" {
        if !crate::net::is_loopback(&host) {
            return Err(format!(
                "http is refused for {}: the key would cross the network in clear text. Use https, or a runtime on 127.0.0.1",
                host
            ));
        }
    } else if scheme != "https" {
        return Err(format!("{}:// is not an endpoint this app calls", scheme));
    }
    Ok(trimmed.to_string())
}

/// The one URL a chat turn goes to.
pub fn chat_url(base: &str) -> Result<String, String> {
    Ok(format!("{}/chat/completions", check_base(base)?))
}

/// No total timeout: a long answer is not a failure. Only the connect is timed.
/// No redirects, for the reason at the top of this file.
fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {}", e))
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn take_cancel(id: &str) -> bool {
    match cancelled().lock() {
        Ok(mut set) => set.remove(id),
        Err(p) => p.into_inner().remove(id),
    }
}

/// POST a chat completion to the user's own endpoint and relay the reply as
/// `shell-chat` events -- the same shape ollama.rs uses, so the frontend parses
/// one stream format, not two. `secret` is the NAME of the credential-store
/// entry (`byok.<id>`); the value is read here and never leaves this function.
#[tauri::command(async)]
pub async fn byok_chat_stream(
    app: tauri::AppHandle,
    id: String,
    secret: String,
    base: String,
    body: String,
) -> Result<(), String> {
    let url = chat_url(&base)?;
    let key = match crate::secrets::read(&secret)? {
        Some(value) if !value.is_empty() => value,
        _ => {
            let message = "No key is stored for that endpoint. Remove it in the model picker and add it again.".to_string();
            let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "error": message }));
            return Err(message);
        }
    };
    let request = stream_client()?
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", key))
        .body(body);
    let mut response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            // The key is not in this message: reqwest reports the URL and the
            // transport error, never a request header.
            let message = format!("Could not reach {}: {}", url, e);
            let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "error": message }));
            return Err(message);
        }
    };
    let status = response.status().as_u16();
    let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "status": status }));
    loop {
        if take_cancel(&id) {
            let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "done": true, "cancelled": true }));
            return Ok(());
        }
        match response.chunk().await {
            Ok(Some(bytes)) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "chunk": text }));
            }
            Ok(None) => break,
            Err(e) => {
                let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "error": e.to_string() }));
                return Err(e.to_string());
            }
        }
    }
    let _ = app.emit("shell-chat", serde_json::json!({ "id": id, "done": true }));
    Ok(())
}

#[tauri::command]
pub fn byok_chat_cancel(id: String) {
    if let Ok(mut set) = cancelled().lock() {
        set.insert(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_anywhere_http_only_on_this_machine() {
        assert_eq!(check_base("https://api.example.com/v1/").unwrap(), "https://api.example.com/v1");
        assert!(check_base("http://127.0.0.1:8080/v1").is_ok(), "a local runtime");
        assert!(check_base("http://localhost:8080/v1").is_ok());
        assert!(check_base("http://api.example.com/v1").is_err(), "plain http off this machine");
        assert!(check_base("ftp://api.example.com").is_err());
        assert!(check_base("api.example.com/v1").is_err(), "no scheme");
        assert!(check_base("").is_err());
    }

    #[test]
    fn a_key_can_never_be_talked_into_the_url() {
        assert!(check_base("https://user:secret@api.example.com/v1").is_err());
        assert!(check_base("https://api.example.com/v1?api_key=sk-live").is_err());
        assert!(check_base("https://api.example.com/v1#sk-live").is_err());
    }

    #[test]
    fn the_chat_url_is_the_openai_one() {
        assert_eq!(
            chat_url("https://api.example.com/v1").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
    }
}
