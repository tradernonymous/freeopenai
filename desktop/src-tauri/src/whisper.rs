// Local dictation through whisper.cpp.
//
// Like llama-server (models.rs), the binary is the user's: they download a
// whisper.cpp release and point the app at whisper-cli.exe. It is run from
// where it is (the DLLs beside it are part of it), never copied; the chosen
// path is remembered in <app data>/whisper/binary.txt. Weights are ggml .bin
// files, looked for in <app data>/whisper-models and beside the binary.
//
// A transcription writes the WAV the page recorded to a fresh temp folder,
// runs the binary DIRECTLY (no shell, every argument its own argv entry),
// reads the .txt it writes, and removes the folder whatever happened. A run
// that takes longer than TIMEOUT_SECS is killed.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Where the user gets the binary: the release page, not an asset URL.
pub const RELEASES_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/latest";
/// Where the ggml weights are (ggml-base.bin, ggml-small.bin, ...).
pub const MODELS_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/tree/main";
/// A dictation is at most two minutes, so a run longer than this is stuck.
pub const TIMEOUT_SECS: u64 = 120;
/// The page sends 16 kHz mono 16-bit WAV: two minutes is ~3.8 MB. Anything
/// far larger is not a dictation.
const MAX_WAV_BYTES: usize = 32 * 1024 * 1024;

/// The names whisper.cpp releases ship the CLI under: whisper-cli since 1.7,
/// main before that.
fn binary_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["whisper-cli.exe", "main.exe"]
    } else {
        &["whisper-cli", "main"]
    }
}

fn whisper_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?
        .join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Where downloaded ggml weights are expected: <app data>/whisper-models.
pub fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?
        .join("whisper-models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn saved_path_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(whisper_dir(app)?.join("binary.txt"))
}

/// Is this file name one of the CLI's names?
fn is_binary_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    binary_names().iter().any(|n| *n == lower)
}

/// `main.exe` is a very generic name to find on PATH, so a PATH hit under
/// that name only counts with whisper's own library beside it.
fn plausible_on_path(candidate: &Path) -> bool {
    let name = candidate
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.starts_with("whisper") {
        return true;
    }
    let Some(dir) = candidate.parent() else {
        return false;
    };
    ["whisper.dll", "libwhisper.so", "libwhisper.so.1", "libwhisper.dylib"]
        .iter()
        .any(|lib| dir.join(lib).is_file())
}

/// The saved path first (the one the user chose), then PATH.
fn find_binary(app: &tauri::AppHandle) -> Option<(PathBuf, &'static str)> {
    if let Ok(file) = saved_path_file(app) {
        if let Ok(saved) = std::fs::read_to_string(&file) {
            let trimmed = saved.trim();
            let path = PathBuf::from(trimmed);
            if !trimmed.is_empty() && path.is_file() {
                return Some((path, "saved"));
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            for name in binary_names() {
                let candidate = entry.join(name);
                if candidate.is_file() && plausible_on_path(&candidate) {
                    return Some((candidate, "path"));
                }
            }
        }
    }
    None
}

#[derive(serde::Serialize, Clone)]
pub struct WhisperModel {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

/// ggml weights in one folder (not recursive): *.bin files. In the binary's
/// own folder only ggml-*.bin counts, because other .bin files live there too.
fn models_in(dir: &Path, ggml_only: bool, out: &mut Vec<WhisperModel>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !lower.ends_with(".bin") || (ggml_only && !lower.starts_with("ggml")) {
            continue;
        }
        let shown = path.display().to_string();
        if out.iter().any(|m| m.path == shown) {
            continue;
        }
        out.push(WhisperModel {
            name,
            path: shown,
            bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
}

#[derive(serde::Serialize)]
pub struct WhisperFacts {
    pub found: bool,
    pub binary: String,
    pub source: String,
    pub models: Vec<WhisperModel>,
    pub models_dir: String,
    pub expected_name: String,
    pub releases_url: String,
    pub models_url: String,
}

#[tauri::command(async)]
pub fn whisper_find(app: tauri::AppHandle) -> WhisperFacts {
    let found = find_binary(&app);
    let dir = models_dir(&app).ok();
    let mut models = Vec::new();
    if let Some(d) = &dir {
        models_in(d, false, &mut models);
    }
    if let Some((binary, _)) = &found {
        if let Some(parent) = binary.parent() {
            models_in(parent, true, &mut models);
            models_in(&parent.join("models"), true, &mut models);
        }
    }
    models.sort_by(|a, b| a.name.cmp(&b.name));
    WhisperFacts {
        found: found.is_some(),
        binary: found.as_ref().map(|(p, _)| p.display().to_string()).unwrap_or_default(),
        source: found.as_ref().map(|(_, s)| s.to_string()).unwrap_or_default(),
        models,
        models_dir: dir.map(|d| d.display().to_string()).unwrap_or_default(),
        expected_name: binary_names()[0].to_string(),
        releases_url: RELEASES_URL.to_string(),
        models_url: MODELS_URL.to_string(),
    }
}

/// Remember the binary the user pointed at. Refuses anything not named like
/// the whisper.cpp CLI, so a mistyped path cannot become what this app runs.
#[tauri::command(async)]
pub fn whisper_use(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("No file at {}", path));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_binary_name(&name) {
        return Err(format!(
            "That file is {}, not {}. Pick it from the whisper.cpp release you downloaded.",
            name,
            binary_names()[0]
        ));
    }
    let file = saved_path_file(&app)?;
    std::fs::write(&file, source.display().to_string())
        .map_err(|e| format!("Could not save the path: {}", e))?;
    Ok(serde_json::json!({ "path": source.display().to_string() }))
}

/// The native picker for whisper-cli. None when the dialog was cancelled.
#[tauri::command(async)]
pub fn whisper_pick_binary(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Choose whisper-cli (from the whisper.cpp release you downloaded)")
        .pick_file()
        .map(|p| p.display().to_string());
    match picked {
        None => Ok(None),
        Some(path) => {
            whisper_use(app, path.clone())?;
            Ok(Some(path))
        }
    }
}

/// A language code whisper.cpp takes: "auto" or two/three lowercase letters.
fn valid_language(lang: &str) -> bool {
    lang == "auto" || ((2..=3).contains(&lang.len()) && lang.chars().all(|c| c.is_ascii_lowercase()))
}

/// The argv for one run: model, input, text output to `out_base`.txt, no
/// timestamps, and the language when one was given.
pub fn args_for(model: &Path, wav: &Path, out_base: &Path, language: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        OsString::from("-m"),
        model.as_os_str().to_owned(),
        OsString::from("-f"),
        wav.as_os_str().to_owned(),
        OsString::from("-otxt"),
        OsString::from("-of"),
        out_base.as_os_str().to_owned(),
        OsString::from("-nt"),
    ];
    if let Some(lang) = language {
        args.push(OsString::from("-l"));
        args.push(OsString::from(lang));
    }
    args
}

/// A temp folder that is removed when it goes out of scope -- on success,
/// on error and on timeout alike.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> Result<TempDir, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("neuraos-whisper-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(TempDir(dir))
}

/// The last few lines of what the binary said, for an error message.
fn tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(3);
    lines[start..].join(" / ").chars().take(400).collect()
}

#[tauri::command(async)]
pub fn whisper_transcribe(
    app: tauri::AppHandle,
    audio_wav_base64: String,
    model_path: String,
    language: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;
    let (binary, _) = find_binary(&app).ok_or_else(|| {
        "whisper.cpp is not set up: choose whisper-cli under Settings, Dictation.".to_string()
    })?;
    let model = PathBuf::from(&model_path);
    let model_ok = model.is_file()
        && model
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("bin"))
            .unwrap_or(false);
    if !model_ok {
        return Err(format!("No ggml model (.bin) at {}", model_path));
    }
    let lang: Option<String> = language
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty());
    if let Some(l) = &lang {
        if !valid_language(l) {
            return Err(format!("\"{}\" is not a language code whisper knows (e.g. en, de, auto).", l));
        }
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(audio_wav_base64.trim())
        .map_err(|e| format!("The recording did not arrive intact: {}", e))?;
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("The recording is not a WAV file.".to_string());
    }
    if wav.len() > MAX_WAV_BYTES {
        return Err("The recording is too long for one dictation.".to_string());
    }

    let tmp = temp_dir()?;
    let wav_path = tmp.0.join("audio.wav");
    let out_base = tmp.0.join("out");
    let txt_path = tmp.0.join("out.txt");
    let log_path = tmp.0.join("whisper.log");
    std::fs::write(&wav_path, &wav).map_err(|e| format!("Could not write the recording: {}", e))?;

    // The binary itself, argv by argv: no shell ever sees the paths.
    let mut command = Command::new(&binary);
    command.args(args_for(&model, &wav_path, &out_base, lang.as_deref()));
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    // stderr to a file, not a pipe: whisper.cpp logs a lot while loading and
    // an unread pipe would stall it.
    match std::fs::File::create(&log_path) {
        Ok(handle) => {
            command.stderr(Stdio::from(handle));
        }
        Err(_) => {
            command.stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", binary.display(), e))?;

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(TIMEOUT_SECS) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("whisper.cpp took longer than {} s and was stopped.", TIMEOUT_SECS));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Lost track of whisper.cpp: {}", e));
            }
        }
    };
    if !status.success() {
        let why = tail(&log_path);
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "killed".to_string());
        return Err(if why.is_empty() {
            format!("whisper.cpp failed ({})", code)
        } else {
            format!("whisper.cpp failed ({}): {}", code, why)
        });
    }
    let text = std::fs::read_to_string(&txt_path)
        .map_err(|e| format!("whisper.cpp wrote no transcript: {}", e))?;
    let words: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let joined = words.join(" ");
    // `tmp` drops at the end of this function: the WAV, the transcript and
    // the log are removed with it.
    drop(tmp);
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_names_are_whisper_cli_first() {
        assert!(binary_names()[0].starts_with("whisper-cli"));
        assert!(is_binary_name(binary_names()[0]));
        assert!(!is_binary_name("llama-server.exe"));
    }

    #[test]
    fn language_codes_are_short_letters_or_auto() {
        assert!(valid_language("en"));
        assert!(valid_language("auto"));
        assert!(valid_language("yue"));
        assert!(!valid_language("en; rm"));
        assert!(!valid_language("-m"));
        assert!(!valid_language(""));
    }

    #[test]
    fn the_args_are_the_documented_flags_in_order() {
        let args = args_for(Path::new("m.bin"), Path::new("a.wav"), Path::new("out"), Some("en"));
        let strs: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(strs, vec!["-m", "m.bin", "-f", "a.wav", "-otxt", "-of", "out", "-nt", "-l", "en"]);
        let none = args_for(Path::new("m.bin"), Path::new("a.wav"), Path::new("out"), None);
        assert!(!none.iter().any(|a| a.to_string_lossy() == "-l"));
    }

    #[test]
    fn the_links_are_pages_on_allowed_hosts() {
        assert!(RELEASES_URL.starts_with("https://github.com/"));
        assert!(MODELS_URL.starts_with("https://huggingface.co/"));
    }
}
