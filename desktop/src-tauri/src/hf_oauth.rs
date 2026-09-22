// One-click Hugging Face sign-in: OAuth 2 authorization code + PKCE with a
// loopback redirect (RFC 8252), for a public client that has no secret.
//
// The page (hf-auth.js beginOAuth) makes the PKCE verifier and the state,
// asks this module to listen, opens the authorize page in the system browser,
// and hands the code it gets back to hf_oauth_exchange. This module owns the
// parts a webview cannot do:
//
//   * listening on the ONE loopback address registered with the OAuth app,
//     http://127.0.0.1:47823/hf/callback -- a fixed port, because HF matches
//     the redirect URI exactly. A busy port is a clear error, not a fallback;
//   * checking that the `state` that comes back is the one that was sent, so
//     a page cannot feed this app a code from someone else's sign-in;
//   * the token request itself (no CORS in the way), to one fixed URL.
//
// The client id is compiled in from NEURAOS_HF_CLIENT_ID (a repository
// variable on CI); Settings can override it, which the page passes in.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub const PORT: u16 = 47823;
pub const CALLBACK_PATH: &str = "/hf/callback";
/// Must match the redirect URI registered on huggingface.co, character for character.
pub const REDIRECT_URI: &str = "http://127.0.0.1:47823/hf/callback";
const TOKEN_URL: &str = "https://huggingface.co/oauth/token";
const BUILD_CLIENT_ID: Option<&str> = option_env!("NEURAOS_HF_CLIENT_ID");
const DEFAULT_TIMEOUT_SECS: u64 = 180;
const MAX_TIMEOUT_SECS: u64 = 900;

/// Bumped by every listen and by cancel: a listener whose number is no longer
/// the current one stops, so Cancel (or a second attempt) frees the port.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The compiled-in client id (None when the build had none) and the redirect URI.
#[tauri::command]
pub fn hf_oauth_config() -> serde_json::Value {
    let client_id: Option<String> = BUILD_CLIENT_ID
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    serde_json::json!({ "client_id": client_id, "redirect_uri": REDIRECT_URI })
}

/// Wait for the browser to come back to the callback address; resolves with
/// the authorization code once the state matches.
#[tauri::command]
pub async fn hf_oauth_listen(state: String, timeout_secs: Option<u64>) -> Result<String, String> {
    if state.len() < 16 {
        return Err("the sign-in state is too short".to_string());
    }
    let secs = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(10, MAX_TIMEOUT_SECS);
    let timeout = Duration::from_secs(secs);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let listener = bind()?;
        wait_for_code(listener, &state, timeout, generation)
    })
    .await
    .map_err(|e| format!("the sign-in listener stopped: {}", e))?
}

/// Stop a listen that is waiting (the Cancel button).
#[tauri::command]
pub fn hf_oauth_cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Trade the authorization code (and the PKCE verifier) for a token.
#[tauri::command]
pub async fn hf_oauth_exchange(
    code: String,
    verifier: String,
    client_id: String,
    redirect_uri: String,
) -> Result<serde_json::Value, String> {
    if redirect_uri != REDIRECT_URI {
        return Err(format!("the redirect URI must be {}", REDIRECT_URI));
    }
    let client_id = client_id.trim().to_string();
    if !valid_client_id(&client_id) {
        return Err("that is not a Hugging Face OAuth client id".to_string());
    }
    if code.is_empty() || verifier.len() < 43 || verifier.len() > 128 {
        return Err("the sign-in code or verifier is missing".to_string());
    }
    post_token(&[
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
    ])
    .await
}

/// A new access token from a refresh token, without the browser.
#[tauri::command]
pub async fn hf_oauth_refresh(refresh_token: String, client_id: String) -> Result<serde_json::Value, String> {
    let client_id = client_id.trim().to_string();
    if !valid_client_id(&client_id) {
        return Err("that is not a Hugging Face OAuth client id".to_string());
    }
    if refresh_token.is_empty() {
        return Err("there is no refresh token".to_string());
    }
    post_token(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", client_id.as_str()),
    ])
    .await
}

// ---- the token endpoint ----------------------------------------------------

fn valid_client_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("FreeAI4U-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {}", e))
}

async fn post_token(form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let response = http()?
        .post(TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| format!("could not reach Hugging Face: {}", e))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let has_token = value.get("access_token").and_then(|v| v.as_str()).is_some();
    if status >= 400 || !has_token {
        return Err(token_error(status, &value, &body));
    }
    Ok(value)
}

fn token_error(status: u16, value: &serde_json::Value, body: &str) -> String {
    let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let detail = value.get("error_description").and_then(|v| v.as_str()).unwrap_or("");
    if !code.is_empty() || !detail.is_empty() {
        let text = format!("Hugging Face token request failed (HTTP {}): {} {}", status, code, detail);
        text.trim().to_string()
    } else {
        let snippet: String = body.chars().take(200).collect();
        format!("Hugging Face token request failed (HTTP {}): {}", status, snippet)
    }
}

// ---- the loopback listener -------------------------------------------------

fn bind() -> Result<TcpListener, String> {
    // A cancelled listener lets go of the port within a poll interval, so a
    // retry right after Cancel waits a moment rather than failing.
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::AddrInUse && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                return Err(format!(
                    "port {} on 127.0.0.1 is busy ({}). Hugging Face sign-in needs exactly this port -- it is the redirect address registered for the app. Close whatever is using it and try again, or use an access token instead.",
                    PORT, e
                ));
            }
        }
    }
}

fn wait_for_code(listener: TcpListener, state: &str, timeout: Duration, generation: u64) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("cancelled".to_string());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Sign-in timed out: the browser did not come back within {} seconds. Try again.",
                timeout.as_secs()
            ));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let head = read_head(&mut stream);
                let query = match callback_query(&head) {
                    Some(q) => q,
                    None => {
                        respond(&mut stream, "404 Not Found", &page(false, "Nothing here. NeuraOS is waiting for Hugging Face to send you back."));
                        continue;
                    }
                };
                let callback = parse_query(&query);
                let result = outcome(&callback, state);
                match &result {
                    Ok(_) => respond(&mut stream, "200 OK", &page(true, "Signed in \u{2014} you can close this tab and go back to NeuraOS.")),
                    Err(message) => respond(&mut stream, "400 Bad Request", &page(false, message)),
                }
                return result;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn read_head(stream: &mut TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                data.extend_from_slice(&chunk[..n]);
                if data.len() > 8192 || data.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&data).into_owned()
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn page(ok: bool, message: &str) -> String {
    let title = if ok { "Signed in" } else { "Sign-in failed" };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>NeuraOS: {}</title><style>body{{font-family:system-ui,sans-serif;margin:15vh auto;max-width:34rem;padding:0 1rem;color:#222}}h1{{font-size:1.4rem}}</style></head><body><h1>{}</h1><p>{}</p></body></html>",
        title,
        title,
        escape(message)
    )
}

// ---- the callback request --------------------------------------------------

pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// The query string of a `GET /hf/callback?...` request line; None for any
/// other request (a favicon, a probe).
pub fn callback_query(request: &str) -> Option<String> {
    let line = request.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    if method != "GET" {
        return None;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != CALLBACK_PATH {
        return None;
    }
    Some(query.to_string())
}

pub fn parse_query(query: &str) -> Callback {
    let mut callback = Callback { code: None, state: None, error: None, error_description: None };
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, raw) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        let value = percent_decode(raw);
        match percent_decode(key).as_str() {
            "code" => callback.code = Some(value),
            "state" => callback.state = Some(value),
            "error" => callback.error = Some(value),
            "error_description" => callback.error_description = Some(value),
            _ => {}
        }
    }
    callback
}

/// What the callback means. The state is checked FIRST: an answer to some
/// other request is refused whatever else it carries.
pub fn outcome(callback: &Callback, expected_state: &str) -> Result<String, String> {
    let state_matches = match &callback.state {
        Some(s) => !expected_state.is_empty() && s.as_str() == expected_state,
        None => false,
    };
    if !state_matches {
        return Err("The sign-in answer did not match this request (state mismatch). Start the sign-in again from NeuraOS.".to_string());
    }
    if let Some(error) = &callback.error {
        let detail = callback.error_description.clone().unwrap_or_default();
        if detail.is_empty() {
            return Err(format!("Hugging Face did not sign you in: {}", error));
        }
        return Err(format!("Hugging Face did not sign you in: {} ({})", detail, error));
    }
    match &callback.code {
        Some(code) if !code.is_empty() => Ok(code.clone()),
        _ => Err("Hugging Face sent no authorization code.".to_string()),
    }
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            match (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                (Some(high), Some(low)) => {
                    out.push(high * 16 + low);
                    i += 3;
                }
                _ => {
                    out.push(b);
                    i += 1;
                }
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_redirect_uri_is_the_fixed_loopback_address() {
        assert_eq!(REDIRECT_URI, format!("http://127.0.0.1:{}{}", PORT, CALLBACK_PATH));
    }

    #[test]
    fn only_the_callback_path_is_read() {
        assert_eq!(callback_query("GET /hf/callback?code=a&state=b HTTP/1.1\r\n").as_deref(), Some("code=a&state=b"));
        assert_eq!(callback_query("GET /favicon.ico HTTP/1.1\r\n"), None);
        assert_eq!(callback_query("POST /hf/callback?code=a HTTP/1.1\r\n"), None);
    }

    #[test]
    fn the_state_must_match() {
        let good = parse_query("code=abc&state=s%2Dtate-0123456789");
        assert_eq!(outcome(&good, "s-tate-0123456789"), Ok("abc".to_string()));
        assert!(outcome(&good, "another-state-000000").is_err());
        let forged = parse_query("error=access_denied&state=wrong");
        assert!(outcome(&forged, "s-tate-0123456789").unwrap_err().contains("state mismatch"));
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("a%20b+c%2F"), "a b c/");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn client_ids_are_plain() {
        assert!(valid_client_id("0123abcd-ef45-6789"));
        assert!(!valid_client_id(""));
        assert!(!valid_client_id("a b"));
        assert!(!valid_client_id("a&b"));
    }
}
