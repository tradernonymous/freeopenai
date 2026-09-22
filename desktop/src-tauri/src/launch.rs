// Opening NeuraOS WITH something (roadmap 5.4): double-clicking a .gguf file
// (the bundle registers the association) or "Open in NeuraOS" on a folder in
// Explorer (the NSIS hook adds the verb) starts the app with that path on its
// command line. A first launch keeps it until the page asks for it; a second
// launch hands it to the running window as an `open-path` event.
use std::path::Path;
use std::sync::Mutex;

static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// The path worth opening in a launch's arguments: an existing .gguf file or
/// an existing folder. Flags, neuraos:// links (the deep-link plugin's) and
/// the executable itself are skipped.
pub fn path_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find_map(|arg| {
        let a = arg.trim().trim_matches('"');
        if a.is_empty() || a.starts_with('-') || a.to_ascii_lowercase().starts_with("neuraos:") {
            return None;
        }
        let p = Path::new(a);
        let is_model = p.is_file()
            && p.extension().map(|e| e.to_string_lossy().eq_ignore_ascii_case("gguf")).unwrap_or(false);
        if is_model || p.is_dir() {
            Some(a.to_string())
        } else {
            None
        }
    })
}

/// Keep a path for the page to take once it has loaded.
pub fn remember(path: String) {
    if let Ok(mut slot) = PENDING.lock() {
        *slot = Some(path);
    }
}

/// The path this launch was opened with, once.
#[tauri::command]
pub fn launch_take_path() -> Option<String> {
    PENDING.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_the_exe_flags_and_links() {
        let dir = std::env::temp_dir();
        let args = vec![
            "neuraos.exe".to_string(),
            "--flag".to_string(),
            "neuraos://model?repo=x".to_string(),
            dir.to_string_lossy().to_string(),
        ];
        assert_eq!(path_arg(&args), Some(dir.to_string_lossy().to_string()));
        assert_eq!(path_arg(&["neuraos.exe".to_string(), "C:/no/such/file.gguf".to_string()]), None);
    }
}
