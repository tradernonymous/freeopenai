// The facts behind the app's own "Copy diagnostics" button.
//
// This module gathers; it does not format. The sentence a user copies is built
// by src/diagnostics.js, which node:test exercises directly -- including the
// part that matters most, redacting anything that looks like a credential.
//
// A diagnostics bundle is only useful if it is safe to paste into an issue, so
// nothing here touches the engine session, a provider key or a chat's contents.
use tauri::Manager;

#[derive(serde::Serialize)]
pub struct Facts {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub webview2: String,
    pub log_path: String,
    pub log_bytes: u64,
    pub log_tail: String,
    pub data_dir: String,
    pub cache_dir: String,
}

fn path_or_empty(result: Result<std::path::PathBuf, tauri::Error>) -> String {
    result.map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
pub fn diagnostics(app: tauri::AppHandle) -> Facts {
    Facts {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        webview2: crate::webview2::version().unwrap_or_else(|| "missing".to_string()),
        log_path: crate::crash::hint(),
        log_bytes: crate::crash::bytes(),
        log_tail: crate::crash::tail(6000),
        data_dir: path_or_empty(app.path().app_data_dir()),
        cache_dir: path_or_empty(app.path().app_cache_dir()),
    }
}
