// Saving a file: a native save dialog in the desktop shell, a download in a
// browser. The base64 hop exists because Tauri command arguments cross the
// webview boundary as JSON, and JSON cannot carry raw bytes.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::fs::OpenOptions;
use std::io::Write;
use tauri::Manager;

// pub: generate_handler! resolves commands through their module path, so a
// private fn here fails the release build with "function is private".
#[tauri::command]
pub fn save_file_dialog(
    app: tauri::AppHandle,
    file_name: String,
    mime: String,
    body_base64: String,
) -> Result<String, String> {
    let bytes = BASE64
        .decode(body_base64.as_bytes())
        .map_err(|e| format!("bad file payload: {}", e))?;

    let start_dir = app
        .path()
        .document_dir()
        .ok()
        .or_else(|| app.path().download_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let path = rfd::FileDialog::new()
        .set_title("Save file")
        .set_file_name(&file_name)
        .set_directory(&start_dir)
        .add_filter("Documents", &["docx", "xlsx", "pptx", "md", "txt", "csv", "html"])
        .save_file()
        .ok_or("save cancelled")?;

    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {}", path.display(), e))?;
    f.write_all(&bytes)
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    let _ = mime; // recorded for future dialogs; the extension carries the type
    Ok(format!("Saved to {}", path.display()))
}
