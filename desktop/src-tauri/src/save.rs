// Saving a file: a native save dialog in the desktop shell, a download in a
// browser. The base64 hop exists because Tauri command arguments cross the
// webview boundary as JSON, and JSON cannot carry raw bytes.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::fs::OpenOptions;
use std::io::Write;
use tauri::Manager;

/// The extension for the save dialog: the file name's own extension when it has
/// one, else the mime type's. The dialog used to offer one fixed document list,
/// so a .png or a .pdf would have been silently unsaveable.
fn extension_for(file_name: &str, mime: &str) -> String {
    if let Some(ext) = std::path::Path::new(file_name).extension().and_then(|e| e.to_str()) {
        let clean = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if !clean.is_empty() && clean.chars().all(|c| c.is_ascii_alphanumeric()) {
            return clean;
        }
    }
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let known = match base.as_str() {
        "application/pdf" => "pdf",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "text/markdown" => "md",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "text/html" => "html",
        "application/json" => "json",
        "application/zip" => "zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        _ => "",
    };
    known.to_string()
}

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

    let extension = extension_for(&file_name, &mime);
    let mut dialog = rfd::FileDialog::new()
        .set_title("Save file")
        .set_file_name(&file_name)
        .set_directory(&start_dir);
    if !extension.is_empty() {
        dialog = dialog.add_filter(extension.to_uppercase().as_str(), &[extension.as_str()]);
    }
    // Always offer everything: a derived filter that guessed wrong must not be
    // the reason a file cannot be saved.
    let path = dialog
        .add_filter("All files", &["*"])
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
    Ok(format!("Saved to {}", path.display()))
}
