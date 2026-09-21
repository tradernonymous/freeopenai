// Ollama, and any other model server on this machine, reached from the shell.
//
// Two reasons this is Rust and not a fetch() in the webview:
//
//   * Ollama only answers browser requests from a short list of origins, and a
//     Tauri window on Windows (`http://tauri.localhost`) is not on it. The
//     shell has no origin, so it is simply a local client like `ollama run`.
//   * a chat reply is a stream. `remote_get` buffers a whole body; this relays
//     each chunk as a `shell-chat` event the moment it arrives.
//
// Connecting to Ollama rather than reading its folder is deliberate: Ollama
// runs every model it has, including the ones in its own engine format that
// llama-server cannot load, so there is no "unsupported model" case -- the
// same choice Unsloth Studio's "Connected" tab makes.
//
// Everything here is LOOPBACK ONLY. A page cannot use these commands to reach
// the network: the URL is checked before a byte moves.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

pub const DEFAULT_BASE: &str = "http://127.0.0.1:11434";

/// `http://127.0.0.1:11434` style bases only: http, a loopback host, no path.
pub fn loopback_base(base: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    let candidate = if trimmed.is_empty() { DEFAULT_BASE } else { trimmed };
    let lower = candidate.to_ascii_lowercase();
    if !lower.starts_with("http://") {
        return Err("a local model server is reached over http on this machine".to_string());
    }
    let host = crate::net::host_of(candidate).ok_or_else(|| format!("{} is not an address", candidate))?;
    if !crate::net::is_loopback(&host) {
        return Err(format!("{} is not this machine; only 127.0.0.1 / localhost are reached", host));
    }
    let rest = candidate.splitn(2, "://").nth(1).unwrap_or("");
    if rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return Err("give the address without a path, like http://127.0.0.1:11434".to_string());
    }
    Ok(candidate.to_string())
}

/// A full loopback URL (base + path) for the streaming command.
pub fn loopback_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if !trimmed.to_ascii_lowercase().starts_with("http://") {
        return Err("only http on this machine is streamed through the shell".to_string());
    }
    let host = crate::net::host_of(trimmed).ok_or_else(|| format!("{} is not an address", trimmed))?;
    if !crate::net::is_loopback(&host) {
        return Err(format!("{} is not this machine", host));
    }
    Ok(trimmed.to_string())
}

fn quick_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {}", e))
}

/// No total timeout: a long answer is not a failure. Only the connect is timed.
fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {}", e))
}

async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let response = quick_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| not_running(url, &e.to_string()))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!("{} answered {}: {}", url, status, body.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&body).map_err(|e| format!("{} did not answer JSON: {}", url, e))
}

fn not_running(url: &str, detail: &str) -> String {
    format!("Nothing is answering at {} -- is Ollama running? ({})", url, detail)
}

/// The models Ollama has: `GET /api/tags`, passed through as it is.
#[tauri::command(async)]
pub async fn ollama_tags(base: Option<String>) -> Result<serde_json::Value, String> {
    let base = loopback_base(&base.unwrap_or_default())?;
    get_json(&format!("{}/api/tags", base)).await
}

/// What is loaded right now: `GET /api/ps`.
#[tauri::command(async)]
pub async fn ollama_ps(base: Option<String>) -> Result<serde_json::Value, String> {
    let base = loopback_base(&base.unwrap_or_default())?;
    get_json(&format!("{}/api/ps", base)).await
}

/// Unload a model now rather than after Ollama's idle timeout: an empty
/// generate with `keep_alive: 0` is Ollama's documented way to do it.
#[tauri::command(async)]
pub async fn ollama_eject(base: Option<String>, model: String) -> Result<(), String> {
    let base = loopback_base(&base.unwrap_or_default())?;
    let body = serde_json::json!({ "model": model, "keep_alive": 0 }).to_string();
    let url = format!("{}/api/generate", base);
    let response = quick_client()?
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| not_running(&url, &e.to_string()))?;
    if !response.status().is_success() {
        return Err(format!("Ollama answered {} to the eject", response.status().as_u16()));
    }
    Ok(())
}

fn ollama_binary() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = std::path::PathBuf::from(local).join("Programs").join("Ollama").join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// Start `ollama serve` if Ollama is installed and not answering. It is the
/// user's own program, started the way its tray app starts it; this app does
/// not own the process and does not stop it on exit.
#[tauri::command(async)]
pub async fn ollama_start(base: Option<String>) -> Result<serde_json::Value, String> {
    let base = loopback_base(&base.unwrap_or_default())?;
    if get_json(&format!("{}/api/tags", base)).await.is_ok() {
        return Ok(serde_json::json!({ "started": false, "running": true }));
    }
    let binary = ollama_binary().ok_or_else(|| {
        "Ollama is not installed here (looked in %LOCALAPPDATA%\\Programs\\Ollama and PATH). Get it from ollama.com.".to_string()
    })?;
    let mut command = std::process::Command::new(&binary);
    command.arg("serve");
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|e| format!("could not start {}: {}", binary.display(), e))?;
    // Give it a moment to bind, then say whether it answered.
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(500));
        if get_json(&format!("{}/api/tags", base)).await.is_ok() {
            return Ok(serde_json::json!({ "started": true, "running": true }));
        }
    }
    Ok(serde_json::json!({ "started": true, "running": false }))
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

/// POST a JSON body to a model server on this machine and relay the reply as
/// `shell-chat` events: `{id, status}` once, `{id, chunk}` per piece of body,
/// then `{id, done}` or `{id, error}`. The body's format (SSE from
/// llama-server, NDJSON from Ollama) is the frontend's to parse.
#[tauri::command(async)]
pub async fn shell_chat_stream(
    app: tauri::AppHandle,
    id: String,
    url: String,
    body: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let url = loopback_url(&url)?;
    let mut request = stream_client()?
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(key) = api_key.as_deref() {
        if !key.is_empty() {
            request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", key));
        }
    }
    let mut response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let message = not_running(&url, &e.to_string());
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
pub fn shell_chat_cancel(id: String) {
    if let Ok(mut set) = cancelled().lock() {
        set.insert(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_machine_is_a_base() {
        assert_eq!(loopback_base("").unwrap(), DEFAULT_BASE);
        assert_eq!(loopback_base("http://localhost:11434/").unwrap(), "http://localhost:11434");
        assert!(loopback_base("https://127.0.0.1:11434").is_err(), "http only");
        assert!(loopback_base("http://192.168.1.5:11434").is_err(), "not this machine");
        assert!(loopback_base("http://example.com").is_err());
        assert!(loopback_base("http://127.0.0.1:11434/api").is_err(), "no path");
        assert!(loopback_base("http://127.0.0.1.evil.com:11434").is_err());
    }

    #[test]
    fn only_this_machine_is_streamed() {
        assert!(loopback_url("http://127.0.0.1:11434/api/chat").is_ok());
        assert!(loopback_url("http://127.0.0.1:8080/v1/chat/completions").is_ok());
        assert!(loopback_url("https://api.openai.com/v1/chat/completions").is_err());
        assert!(loopback_url("http://10.0.0.2:11434/api/chat").is_err());
    }
}
