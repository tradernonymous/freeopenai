// Where a failure gets recorded.
//
// The log lives in the app's own directory, not in a shared public folder: that
// location is not writable in a locked-down profile (so the "no silent deaths"
// promise failed exactly when it was needed) and crash text should not land
// somewhere every account can read.
//
// It has to work before the app exists -- a panic in the boot path is the case
// that matters most -- so the path falls back to the user profile, and Tauri
// replaces it with its own log directory once the app is up.
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub const CRASH_FILE: &str = "freeai4u-crash.log";
// A crash loop must not fill the disk: past this size the log is replaced, not
// appended to.
pub const CRASH_LOG_MAX_BYTES: u64 = 256 * 1024;

static CRASH_LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn path() -> PathBuf {
    if let Ok(guard) = CRASH_LOG.lock() {
        if let Some(path) = guard.as_ref() {
            return path.clone();
        }
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("FreeAI4U")
        .join("logs")
        .join(CRASH_FILE)
}

/// Called from setup, once Tauri knows its own directories.
pub fn set_path(path: PathBuf) {
    if let Ok(mut guard) = CRASH_LOG.lock() {
        *guard = Some(path);
    }
}

/// Append one line, rotating first when the file has grown past the cap.
pub fn log(msg: &str) {
    let file = path();
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > CRASH_LOG_MAX_BYTES {
            let _ = std::fs::write(
                &file,
                format!(
                    "[{}] log rotated ({} bytes)\n",
                    chrono::Utc::now().to_rfc3339(),
                    meta.len()
                ),
            );
        }
    }
    if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(handle, "[{}] {}", chrono::Utc::now().to_rfc3339(), msg);
    }
}

/// The exact file, for a dialog that should tell the user where to look.
pub fn hint() -> String {
    path().display().to_string()
}

/// Current size, or 0 when nothing has ever been recorded.
pub fn bytes() -> u64 {
    std::fs::metadata(path()).map(|meta| meta.len()).unwrap_or(0)
}

/// The last `max_bytes` of the log, so a diagnostics bundle can carry what went
/// wrong without carrying the whole history. Reads from the end: a log that hit
/// its cap is exactly the case where reading it all would be slowest.
pub fn tail(max_bytes: usize) -> String {
    let file = path();
    let content = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(_) => return String::new(),
    };
    let start = content.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&content[start..]).to_string()
}
