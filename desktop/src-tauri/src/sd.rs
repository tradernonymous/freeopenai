// Local image generation: stable-diffusion.cpp's `sd-server`, run by this app,
// on this machine, with no account and no network.
//
// This is the image analogue of models.rs, and it copies its rules rather than
// inventing new ones:
//
//   * the binary is the user's. This app ships none and downloads none. They
//     build or download `sd-server` from stable-diffusion.cpp and point the
//     app at it with a native picker; the path is remembered in
//     <app data>/sd/binary.txt. It is run from where it is, never copied,
//     because the DLLs beside it are part of it (the same reason whisper.rs
//     keeps whisper-cli where it found it).
//   * the weights are the user's too. A .safetensors/.ckpt/.gguf the user
//     picked, remembered in <app data>/sd/model.txt. Nothing is fetched.
//   * the server is loopback only. There is no host setting anywhere in this
//     module: the base address is built here as http://127.0.0.1:<port> and
//     nothing a page sends can change the host. sd-server has no api-key of
//     its own, so binding it to 127.0.0.1 is the whole boundary -- which is
//     exactly why the address is not configurable.
//   * stopping is real. The child is killed and reaped by `sd_stop`, and
//     `shutdown()` does the same on app exit, so an image server never
//     outlives the window.
//
// THE API THIS TALKS TO (verified against stable-diffusion.cpp's own
// examples/server/api.md and examples/server/README.md, Sept 2026):
//
//   POST /sdcpp/v1/img_gen      -- submit a job; 202 with {"id", "status",
//                                  "poll_url"}. Body fields used here:
//                                  "prompt", "negative_prompt", "width",
//                                  "height", "seed", "batch_count" and the
//                                  nested "sample_params": {"sample_steps"}.
//                                  Editing a picture is the SAME endpoint --
//                                  sd.cpp serves no edit route of its own --
//                                  with "init_image" (a raw base64 string or a
//                                  data: URL) and "strength", the documented
//                                  image-to-image pair. "mask_image" exists
//                                  too and is not sent: it wants one channel,
//                                  and nothing in this app paints one.
//   GET  /sdcpp/v1/jobs/{id}    -- {"status": queued|generating|completed|
//                                  failed|cancelled, "queue_position", and on
//                                  completion "result": {"output_format",
//                                  "images": [{"index", "b64_json"}]}}.
//   POST /sdcpp/v1/jobs/{id}/cancel -- 200 when it took, 404/410 when the job
//                                  is already gone.
//   GET  /sdcpp/v1/capabilities -- answers once the model is loaded, so it is
//                                  the readiness probe (llama.cpp's /health).
//
// The async job API is the one used, not the OpenAI-shaped
// POST /v1/images/generations the same server also serves, for one reason:
// generation takes minutes, and only the job API can say "queued" vs
// "generating" and be cancelled. A blocking POST could only be abandoned.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

/// sd-server's own documented default port (`--listen-port`).
pub const DEFAULT_PORT: u16 = 1234;
/// Where the user gets the binary: the release page, not an asset URL.
pub const RELEASES_URL: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/latest";
/// Where a person finds weights sd.cpp can load.
pub const MODELS_URL: &str = "https://huggingface.co/models?library=gguf&other=stable-diffusion";
/// Loading a diffusion model off a cold disk is slow, but not endless.
pub const START_TIMEOUT_SECS: u64 = 300;
/// The longest source picture an edit may carry, in characters of base64.
/// Roughly 18 MB of image: enough for anything a person edits by hand, and a
/// ceiling so a page cannot hand this process an unbounded string.
const MAX_INIT_IMAGE_CHARS: usize = 24 * 1024 * 1024;
/// The file extensions sd.cpp loads as a model.
const MODEL_EXTENSIONS: [&str; 4] = ["safetensors", "ckpt", "gguf", "sft"];

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "sd-server.exe"
    } else {
        "sd-server"
    }
}

struct Run {
    child: Child,
    binary: String,
    model: String,
    port: u16,
    started: Instant,
}

fn slot() -> &'static Mutex<Option<Run>> {
    static RUN: OnceLock<Mutex<Option<Run>>> = OnceLock::new();
    RUN.get_or_init(|| Mutex::new(None))
}

/// Kill whatever is running. `sd_stop` calls it, and so does app exit: an
/// image server left behind is a process the user cannot see and did not
/// ask for.
pub fn shutdown() {
    let mut guard = match slot().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(mut run) = guard.take() {
        let _ = run.child.kill();
        let _ = run.child.wait();
    }
}

fn sd_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?
        .join("sd");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Where weights are looked for: <app data>/sd-models.
pub fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?
        .join("sd-models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn binary_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(sd_dir(app)?.join("binary.txt"))
}

fn model_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(sd_dir(app)?.join("model.txt"))
}

fn remembered(path: Result<PathBuf, String>) -> Option<PathBuf> {
    let file = path.ok()?;
    let saved = std::fs::read_to_string(&file).ok()?;
    let trimmed = saved.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// The chosen model: a file, or a folder that still forms a set. Kept apart
/// from `remembered`, which the binary shares and where a folder is never
/// valid.
fn remembered_model(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(file) = remembered(model_file(app)) {
        return Some(file);
    }
    let saved = std::fs::read_to_string(model_file(app).ok()?).ok()?;
    let candidate = PathBuf::from(saved.trim());
    if candidate.is_dir() && set_in(&candidate).is_some() {
        Some(candidate)
    } else {
        None
    }
}

/// The saved binary first (the one the user chose), then PATH.
fn find_binary(app: &tauri::AppHandle) -> Option<(PathBuf, &'static str)> {
    if let Some(path) = remembered(binary_file(app)) {
        return Some((path, "saved"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            let candidate = entry.join(binary_name());
            if candidate.is_file() {
                return Some((candidate, "path"));
            }
        }
    }
    None
}

/// A model that is several files (NEURA-073): a diffusion model plus the
/// parts it needs beside it -- a VAE, and a text encoder, which sd-server takes
/// each under its own flag. Krea2, Flux, Qwen-Image and the rest ship this way,
/// and `-m <file>` alone cannot start any of them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SetParts {
    pub diffusion: PathBuf,
    pub vae: Option<PathBuf>,
    pub llm: Option<PathBuf>,
    /// The text encoder's vision projector (`mmproj-...`). An edit model reads
    /// its reference picture through it; without it sd.cpp disables vision
    /// and the model edits a picture it cannot see.
    pub llm_vision: Option<PathBuf>,
    pub clip_l: Option<PathBuf>,
    pub t5xxl: Option<PathBuf>,
}

/// The role a weight file plays in a set, from its name. Names are the only
/// evidence on disk, and they hold in practice because every published set
/// names its parts this way ("..._vae", "Qwen3VL-4B-Instruct", "t5xxl",
/// "clip_l"). A multimodal projector (`mmproj-...`) is the encoder's vision,
/// which an edit model needs to see the picture it is changing.
fn role_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.starts_with("mmproj") || lower.contains(".mmproj") {
        "llm_vision"
    } else if lower.contains("vae") {
        "vae"
    } else if lower.contains("clip_l") {
        "clip_l"
    } else if lower.contains("t5xxl") || lower.contains("umt5") || lower.starts_with("t5") {
        "t5xxl"
    } else if [
        "instruct",
        "text_encoder",
        "textencoder",
        "llm",
        "mistral",
        "gemma",
        "qwen3vl",
        "qwen3-vl",
        "qwen2.5-vl",
        "qwen2_5_vl",
    ]
    .iter()
    .any(|k| lower.contains(k))
    {
        "llm"
    } else {
        "diffusion"
    }
}

/// Sort a folder's weight files into a set. The diffusion model is the
/// largest file no other role claimed; a folder with no diffusion model, or
/// with nothing beside it, is not a set -- a lone checkpoint still starts
/// with `-m` exactly as before.
pub fn set_roles(files: &[(PathBuf, u64)]) -> Option<SetParts> {
    let mut parts = SetParts::default();
    let mut diffusion: Option<(PathBuf, u64)> = None;
    for (path, bytes) in files {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !is_model_name(&name) {
            continue;
        }
        match role_of(&name) {
            "vae" => {
                if parts.vae.is_none() {
                    parts.vae = Some(path.clone());
                }
            }
            "clip_l" => {
                if parts.clip_l.is_none() {
                    parts.clip_l = Some(path.clone());
                }
            }
            "t5xxl" => {
                if parts.t5xxl.is_none() {
                    parts.t5xxl = Some(path.clone());
                }
            }
            "llm" => {
                if parts.llm.is_none() {
                    parts.llm = Some(path.clone());
                }
            }
            "llm_vision" => {
                if parts.llm_vision.is_none() {
                    parts.llm_vision = Some(path.clone());
                }
            }
            "diffusion" => {
                let bigger = match &diffusion {
                    Some((_, b)) => *bytes > *b,
                    None => true,
                };
                if bigger {
                    diffusion = Some((path.clone(), *bytes));
                }
            }
            _ => {}
        }
    }
    let (path, _) = diffusion?;
    if parts.vae.is_none() && parts.llm.is_none() && parts.clip_l.is_none() && parts.t5xxl.is_none() {
        return None;
    }
    parts.diffusion = path;
    Some(parts)
}

/// The set a folder holds, if it holds one (not recursive).
pub fn set_in(dir: &Path) -> Option<SetParts> {
    let entries = std::fs::read_dir(dir).ok()?;
    let files: Vec<(PathBuf, u64)> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| (e.path(), e.metadata().map(|m| m.len()).unwrap_or(0)))
        .collect();
    set_roles(&files)
}

/// Is this a file name sd.cpp would load as a model?
fn is_model_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    MODEL_EXTENSIONS.iter().any(|ext| lower.ends_with(&format!(".{}", ext)))
}

#[derive(serde::Serialize, Clone)]
pub struct SdModel {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

/// Weights in one folder (not recursive).
fn models_in(dir: &Path, out: &mut Vec<SdModel>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // A folder that forms a set is one model, listed under the
            // folder's name, so choosing it is one click like any other.
            if let Some(parts) = set_in(&path) {
                let shown = path.display().to_string();
                if out.iter().any(|m| m.path == shown) {
                    continue;
                }
                let count = 1 + [&parts.vae, &parts.llm, &parts.llm_vision, &parts.clip_l, &parts.t5xxl]
                    .iter()
                    .filter(|p| p.is_some())
                    .count();
                let bytes: u64 = std::fs::read_dir(&path)
                    .map(|d| d.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum())
                    .unwrap_or(0);
                out.push(SdModel {
                    name: format!("{} (set of {} files)", entry.file_name().to_string_lossy(), count),
                    path: shown,
                    bytes,
                });
            }
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_model_name(&name) {
            continue;
        }
        let shown = path.display().to_string();
        if out.iter().any(|m| m.path == shown) {
            continue;
        }
        out.push(SdModel {
            name,
            path: shown,
            bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
}

#[derive(serde::Serialize)]
pub struct SdFacts {
    pub found: bool,
    pub binary: String,
    pub source: String,
    /// The model the user chose, empty when they have not chosen one.
    pub model: String,
    pub models: Vec<SdModel>,
    pub models_dir: String,
    pub expected_name: String,
    pub releases_url: String,
    pub models_url: String,
    pub default_port: u16,
}

#[tauri::command(async)]
pub fn sd_find(app: tauri::AppHandle) -> SdFacts {
    let found = find_binary(&app);
    let dir = models_dir(&app).ok();
    let mut models = Vec::new();
    if let Some(d) = &dir {
        models_in(d, &mut models);
    }
    if let Some((binary, _)) = &found {
        if let Some(parent) = binary.parent() {
            models_in(parent, &mut models);
            models_in(&parent.join("models"), &mut models);
        }
    }
    // The chosen model belongs in the list even when it lives somewhere else.
    if let Some(chosen) = remembered(model_file(&app)) {
        let shown = chosen.display().to_string();
        if !models.iter().any(|m| m.path == shown) {
            models.push(SdModel {
                name: chosen
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| shown.clone()),
                path: shown,
                bytes: std::fs::metadata(&chosen).map(|m| m.len()).unwrap_or(0),
            });
        }
    }
    models.sort_by(|a, b| a.name.cmp(&b.name));
    SdFacts {
        found: found.is_some(),
        binary: found.as_ref().map(|(p, _)| p.display().to_string()).unwrap_or_default(),
        source: found.as_ref().map(|(_, s)| s.to_string()).unwrap_or_default(),
        model: remembered(model_file(&app)).map(|p| p.display().to_string()).unwrap_or_default(),
        models,
        models_dir: dir.map(|d| d.display().to_string()).unwrap_or_default(),
        expected_name: binary_name().to_string(),
        releases_url: RELEASES_URL.to_string(),
        models_url: MODELS_URL.to_string(),
        default_port: DEFAULT_PORT,
    }
}

/// Remember the binary the user pointed at. Refuses anything not named like
/// sd-server, so a mistyped path cannot become what this app runs.
///
/// Not a command: the only way to set it is the native picker below, so the
/// page cannot name a file this app then runs.
fn use_binary(app: &tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(&path);
    if source.is_dir() {
        if set_in(&source).is_none() {
            return Err(format!(
                "{} is a folder, but not a model set: it needs a diffusion model and at least a VAE or a text encoder beside it.",
                path
            ));
        }
        let file = model_file(&app)?;
        std::fs::write(&file, source.display().to_string())
            .map_err(|e| format!("Could not save the path: {}", e))?;
        return Ok(serde_json::json!({ "path": source.display().to_string(), "set": true }));
    }
    if !source.is_file() {
        return Err(format!("No file at {}", path));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name != binary_name().to_lowercase() {
        return Err(format!(
            "That file is {}, not {}. Pick {} from the stable-diffusion.cpp build you downloaded.",
            name,
            binary_name(),
            binary_name()
        ));
    }
    let file = binary_file(app)?;
    std::fs::write(&file, source.display().to_string())
        .map_err(|e| format!("Could not save the path: {}", e))?;
    Ok(serde_json::json!({ "path": source.display().to_string() }))
}

/// The native picker for sd-server. None when the dialog was cancelled.
#[tauri::command(async)]
pub fn sd_pick_binary(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Choose sd-server (from the stable-diffusion.cpp build you downloaded)")
        .pick_file()
        .map(|p| p.display().to_string());
    match picked {
        None => Ok(None),
        Some(path) => {
            use_binary(&app, path.clone())?;
            Ok(Some(path))
        }
    }
}

/// Remember the weights the user pointed at.
#[tauri::command(async)]
pub fn sd_use_model(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("No file at {}", path));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !is_model_name(&name) {
        return Err(format!(
            "{} is not a model stable-diffusion.cpp loads (.{}).",
            name,
            MODEL_EXTENSIONS.join(", .")
        ));
    }
    let file = model_file(&app)?;
    std::fs::write(&file, source.display().to_string())
        .map_err(|e| format!("Could not save the path: {}", e))?;
    Ok(serde_json::json!({ "path": source.display().to_string() }))
}

/// The native picker for the weights.
#[tauri::command(async)]
pub fn sd_pick_model(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Choose a Stable Diffusion model file")
        .add_filter("Model", &MODEL_EXTENSIONS[..])
        .pick_file()
        .map(|p| p.display().to_string());
    match picked {
        None => Ok(None),
        Some(path) => {
            sd_use_model(app, path.clone())?;
            Ok(Some(path))
        }
    }
}

/// A port this app will bind sd-server to. Never a privileged one, never 0:
/// the address is built here, so the port is the only part a page can steer
/// and it is bounded.
pub fn valid_port(port: Option<u16>) -> Result<u16, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    if port < 1024 {
        return Err(format!("{} is not a port this app will use", port));
    }
    Ok(port)
}

/// The only address this module ever talks to. There is no host argument
/// anywhere: a local image server is for this machine.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

/// A job id sd-server handed out: letters, digits, `_` and `-`. Anything else
/// is refused, so a job id cannot walk the URL into another endpoint.
pub fn valid_job_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err(format!("{} is not a job id", trimmed));
    }
    Ok(trimmed.to_string())
}

/// The argv for one run: the model, and loopback. Kept in one place so it can
/// be asserted, exactly as models.rs does for llama-server.
pub fn args_for(model: &Path, port: u16, threads: Option<u32>) -> Vec<String> {
    let mut args = vec![
        "-m".to_string(),
        model.display().to_string(),
        // An image server is for this machine, not for the network it is on.
        "--listen-ip".to_string(),
        "127.0.0.1".to_string(),
        "--listen-port".to_string(),
        port.to_string(),
    ];
    if let Some(threads) = threads {
        args.push("-t".to_string());
        args.push(threads.to_string());
    }
    args
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http client: {}", e))
}

/// Whether sd-server answers, and what it said. `/sdcpp/v1/capabilities` only
/// answers once the model is loaded, which is the difference between
/// "starting" and "ready" -- the thing a progress line has to be honest about.
async fn ready(port: u16) -> (bool, String) {
    let url = format!("{}/sdcpp/v1/capabilities", base_url(port));
    let client = match client(Duration::from_secs(5)) {
        Ok(c) => c,
        Err(e) => return (false, e),
    };
    match client.get(&url).send().await {
        Ok(response) => {
            let code = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let short: String = body.chars().take(200).collect();
            (code == 200, if code == 200 { String::new() } else { format!("{} {}", code, short) })
        }
        Err(e) => (false, e.to_string()),
    }
}

#[derive(serde::Serialize)]
pub struct SdStatus {
    /// "stopped", "starting" or "ready".
    pub state: String,
    pub binary: String,
    pub model: String,
    pub port: u16,
    pub pid: u32,
    pub uptime_ms: u64,
    pub base_url: String,
    pub detail: String,
}

fn snapshot(run: &Option<Run>, is_ready: bool, detail: String) -> SdStatus {
    match run {
        Some(active) => SdStatus {
            state: if is_ready { "ready" } else { "starting" }.to_string(),
            binary: active.binary.clone(),
            model: active.model.clone(),
            port: active.port,
            pid: active.child.id(),
            uptime_ms: active.started.elapsed().as_millis() as u64,
            base_url: base_url(active.port),
            detail,
        },
        None => SdStatus {
            state: "stopped".to_string(),
            binary: String::new(),
            model: String::new(),
            port: 0,
            pid: 0,
            uptime_ms: 0,
            base_url: String::new(),
            detail,
        },
    }
}

#[tauri::command(async)]
pub async fn sd_status() -> SdStatus {
    let (running, port) = {
        let guard = match slot().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.as_ref() {
            Some(run) => (true, run.port),
            None => (false, 0),
        }
    };
    if !running {
        return snapshot(&None, false, String::new());
    }
    let (ok, detail) = ready(port).await;
    let guard = match slot().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    snapshot(&guard, ok, detail)
}

fn log_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("sd-server.log"))
}

fn log_tail(app: &tauri::AppHandle) -> String {
    let Some(path) = log_file(app) else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    let tail: String = text.chars().rev().take(1200).collect::<String>().chars().rev().collect();
    tail.trim().to_string()
}

/// The argv for a set: each part under its own flag, then what a multi-file
/// model needs on an ordinary machine. `--offload-to-cpu` keeps the weights in
/// RAM and moves each piece to the GPU only while it runs -- Krea2's three
/// parts are ~10 GB against a 4 GB card. `--vae-tiling` decodes the finished
/// picture in tiles: without it, sampling ran to the end on a 4 GB card and
/// the very last step failed out of GPU memory, leaving a blank file after
/// six minutes of work.
pub fn args_for_set(parts: &SetParts, port: u16, threads: Option<u32>) -> Vec<String> {
    let mut args = vec!["--diffusion-model".to_string(), parts.diffusion.display().to_string()];
    for (flag, part) in [
        ("--vae", &parts.vae),
        ("--llm", &parts.llm),
        ("--llm_vision", &parts.llm_vision),
        ("--clip_l", &parts.clip_l),
        ("--t5xxl", &parts.t5xxl),
    ] {
        if let Some(path) = part {
            args.push(flag.to_string());
            args.push(path.display().to_string());
        }
    }
    for flag in [
        "--offload-to-cpu",
        "--diffusion-fa",
        "--vae-tiling",
        // An image server is for this machine, not for the network it is on.
        "--listen-ip",
        "127.0.0.1",
        "--listen-port",
    ] {
        args.push(flag.to_string());
    }
    args.push(port.to_string());
    if let Some(threads) = threads {
        args.push("-t".to_string());
        args.push(threads.to_string());
    }
    args
}

/// Start sd-server and wait for it to answer. Failure says what went wrong --
/// no binary, no model, or the server's own last words -- rather than hanging.
#[tauri::command(async)]
pub async fn sd_start(
    app: tauri::AppHandle,
    port: Option<u16>,
    threads: Option<u32>,
) -> Result<SdStatus, String> {
    let (binary, _) = find_binary(&app).ok_or_else(|| {
        format!(
            "{} is not set up: choose it under Images, \"On this PC\". Get it from {}.",
            binary_name(),
            RELEASES_URL
        )
    })?;
    let model = remembered_model(&app).ok_or_else(|| {
        "No model chosen: pick a .safetensors, .ckpt or .gguf under Images, \"On this PC\".".to_string()
    })?;
    let port = valid_port(port)?;
    // One server at a time, and the old one goes first: two of these would
    // fight over the port and over the machine's memory.
    shutdown();

    let mut command = Command::new(&binary);
    // A folder is a set, and a set starts with each part under its own flag.
    let argv = match set_in(&model) {
        Some(parts) if model.is_dir() => args_for_set(&parts, port, threads),
        _ => args_for(&model, port, threads),
    };
    command.args(argv);
    command.stdin(Stdio::null());
    // The server's own log is the only place a load failure explains itself.
    if let Some(log) = log_file(&app) {
        if let Ok(handle) = std::fs::File::create(&log) {
            if let Ok(clone) = handle.try_clone() {
                command.stdout(Stdio::from(clone));
            }
            command.stderr(Stdio::from(handle));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", binary.display(), e))?;
    {
        let mut guard = match slot().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *guard = Some(Run {
            child,
            binary: binary.display().to_string(),
            model: model.display().to_string(),
            port,
            started: Instant::now(),
        });
    }

    let deadline = Instant::now() + Duration::from_secs(START_TIMEOUT_SECS);
    loop {
        let exited = {
            let mut guard = match slot().lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match guard.as_mut() {
                Some(run) => match run.child.try_wait() {
                    Ok(Some(status)) => Some(format!("sd-server exited with {}", status)),
                    Ok(None) => None,
                    Err(e) => Some(e.to_string()),
                },
                None => Some("stopped".to_string()),
            }
        };
        if let Some(reason) = exited {
            let tail = log_tail(&app);
            shutdown();
            return Err(format!("{}. {}", reason, tail));
        }
        let (ok, detail) = ready(port).await;
        if ok {
            let guard = match slot().lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            return Ok(snapshot(&guard, true, detail));
        }
        if Instant::now() >= deadline {
            let tail = log_tail(&app);
            shutdown();
            return Err(format!(
                "sd-server did not become ready within {} s. {}",
                START_TIMEOUT_SECS, tail
            ));
        }
        std::thread::sleep(Duration::from_millis(750));
    }
}

#[tauri::command(async)]
pub fn sd_stop() -> serde_json::Value {
    let was = {
        let guard = match slot().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.is_some()
    };
    shutdown();
    serde_json::json!({ "stopped": was })
}

/// The body for `POST /sdcpp/v1/img_gen`, in one place so it can be asserted.
/// Only the documented fields, and only the ones actually asked for.
pub fn job_body(
    prompt: &str,
    negative_prompt: &str,
    width: u32,
    height: u32,
    steps: Option<u32>,
    seed: Option<i64>,
    init_image: Option<&str>,
    strength: Option<f64>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "batch_count": 1,
    });
    if let Some(steps) = steps {
        body["sample_params"] = serde_json::json!({ "sample_steps": steps });
    }
    if let Some(seed) = seed {
        body["seed"] = serde_json::json!(seed);
    }
    // A strength without a picture to apply it to would be a field about
    // nothing, so the pair travels together or not at all.
    if let Some(image) = init_image {
        body["init_image"] = serde_json::json!(image);
        body["strength"] =
            serde_json::json!(strength.unwrap_or(DEFAULT_EDIT_STRENGTH).clamp(0.0, 1.0));
    }
    body
}

/// How much of the source an edit is allowed to leave behind when the caller
/// does not say. sd.cpp's own example uses 0.75; this asks for less, because
/// the request is "change this picture" rather than "start from it".
const DEFAULT_EDIT_STRENGTH: f64 = 0.6;

/// The source picture for an edit. sd.cpp accepts a raw base64 string or a
/// data: URL and nothing else -- in particular not a path, because a path
/// would be this process reading whatever file a page named.
fn valid_init_image(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("The picture to change arrived empty.".to_string());
    }
    if text.len() > MAX_INIT_IMAGE_CHARS {
        return Err("That picture is too large to edit here.".to_string());
    }
    let payload = match text.strip_prefix("data:") {
        Some(rest) => match rest.split_once(";base64,") {
            Some((kind, data)) if kind.starts_with("image/") => data,
            _ => {
                return Err(
                    "The picture must be base64 image bytes, or a data: URL carrying them."
                        .to_string(),
                )
            }
        },
        None => text,
    };
    let letters = payload.as_bytes();
    let looks_base64 = letters.iter().any(|b| b.is_ascii_alphanumeric())
        && letters.iter().all(|b| {
            b.is_ascii_alphanumeric()
                || *b == b'+'
                || *b == b'/'
                || *b == b'='
                || b.is_ascii_whitespace()
        });
    if !looks_base64 {
        return Err(
            "The picture must be base64 image bytes, or a data: URL carrying them.".to_string(),
        );
    }
    Ok(text.to_string())
}

/// The size sd.cpp will draw: a multiple of 64, and nothing absurd. A page
/// that asks for 40000 pixels is asking the machine to die.
fn valid_side(side: u32, what: &str) -> Result<u32, String> {
    if !(64..=2048).contains(&side) {
        return Err(format!("{} must be between 64 and 2048 pixels", what));
    }
    if side % 64 != 0 {
        return Err(format!("{} must be a multiple of 64", what));
    }
    Ok(side)
}

/// The running server's port, or the error that says nothing is running.
fn running_port() -> Option<u16> {
    let guard = match slot().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    guard.as_ref().map(|run| run.port)
}

/// Submit one job. Returns sd-server's own answer ({"id", "status", ...}); the
/// page then polls `sd_job` and can `sd_cancel`, so nothing blocks for the
/// minutes an image takes.
#[tauri::command(async)]
pub async fn sd_generate(
    prompt: String,
    negative_prompt: Option<String>,
    width: u32,
    height: u32,
    steps: Option<u32>,
    seed: Option<i64>,
    // An edit is the same job with the picture being changed attached. Absent,
    // this is the draw it has always been.
    init_image: Option<String>,
    strength: Option<f64>,
) -> Result<serde_json::Value, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("An image needs a prompt.".to_string());
    }
    let width = valid_side(width, "width")?;
    let height = valid_side(height, "height")?;
    let port = running_port()
        .ok_or_else(|| "The local image server is not running: start it first.".to_string())?;
    let init = match init_image {
        Some(raw) => Some(valid_init_image(&raw)?),
        None => None,
    };
    let body = job_body(
        &prompt,
        negative_prompt.unwrap_or_default().trim(),
        width,
        height,
        steps,
        seed,
        init.as_deref(),
        strength,
    )
    .to_string();
    let url = format!("{}/sdcpp/v1/img_gen", base_url(port));
    let response = client(Duration::from_secs(30))?
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("The local image server did not take the job: {}", e))?;
    let code = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&code) {
        return Err(format!(
            "sd-server answered {}: {}",
            code,
            text.chars().take(200).collect::<String>()
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("sd-server did not answer JSON: {}", e))?;
    // A submission without an id is not a job, and pretending otherwise would
    // leave the page polling something that never existed.
    if valid_job_id(value.get("id").and_then(|v| v.as_str()).unwrap_or("")).is_err() {
        return Err("sd-server accepted the job without giving it an id.".to_string());
    }
    Ok(value)
}

/// One poll of one job, passed through as sd-server wrote it: status,
/// queue_position, and on completion result.images[].b64_json.
#[tauri::command(async)]
pub async fn sd_job(id: String) -> Result<serde_json::Value, String> {
    let id = valid_job_id(&id)?;
    let port = running_port()
        .ok_or_else(|| "The local image server is not running.".to_string())?;
    let url = format!("{}/sdcpp/v1/jobs/{}", base_url(port), id);
    let response = client(Duration::from_secs(15))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Lost the local image server: {}", e))?;
    let code = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if code == 404 || code == 410 {
        return Ok(serde_json::json!({ "id": id, "status": "cancelled", "detail": "the job is gone" }));
    }
    if !(200..300).contains(&code) {
        return Err(format!(
            "sd-server answered {}: {}",
            code,
            text.chars().take(200).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("sd-server did not answer JSON: {}", e))
}

/// Cancel a job. A job that is already gone (404/410) counts as cancelled:
/// the user asked for it to stop, and it has.
#[tauri::command(async)]
pub async fn sd_cancel(id: String) -> Result<serde_json::Value, String> {
    let id = valid_job_id(&id)?;
    let Some(port) = running_port() else {
        return Ok(serde_json::json!({ "cancelled": true, "detail": "nothing is running" }));
    };
    let url = format!("{}/sdcpp/v1/jobs/{}/cancel", base_url(port), id);
    let response = client(Duration::from_secs(15))?
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Could not reach the local image server: {}", e))?;
    let code = response.status().as_u16();
    Ok(serde_json::json!({
        "cancelled": (200..300).contains(&code) || code == 404 || code == 410,
        "status": code,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn krea2s_three_files_are_one_set_by_role() {
        let files = vec![
            (PathBuf::from("k/Krea2_turbo_edit-Q4_K_M.gguf"), 7_216_993_344),
            (PathBuf::from("k/Qwen3VL-4B-Instruct-Q4_K_M.gguf"), 2_497_281_664),
            (PathBuf::from("k/wan_2.1_vae.safetensors"), 253_815_318),
            (PathBuf::from("k/mmproj-Qwen3VL-4B-Instruct-F16.gguf"), 780_000_000),
            (PathBuf::from("k/README.md"), 4_000),
        ];
        let parts = set_roles(&files).expect("a diffusion model with a VAE and an encoder is a set");
        assert_eq!(parts.diffusion, PathBuf::from("k/Krea2_turbo_edit-Q4_K_M.gguf"));
        assert_eq!(parts.llm, Some(PathBuf::from("k/Qwen3VL-4B-Instruct-Q4_K_M.gguf")));
        assert_eq!(parts.vae, Some(PathBuf::from("k/wan_2.1_vae.safetensors")));
        assert_eq!(
            parts.llm_vision,
            Some(PathBuf::from("k/mmproj-Qwen3VL-4B-Instruct-F16.gguf")),
            "the projector is the encoder's eyes, not the encoder"
        );
        assert_eq!(parts.clip_l, None);
    }

    #[test]
    fn a_lone_checkpoint_is_not_a_set() {
        let files = vec![(PathBuf::from("m/v1-5-pruned-emaonly.safetensors"), 4_000_000_000)];
        assert!(set_roles(&files).is_none(), "one file keeps starting with -m");
        let no_diffusion = vec![(PathBuf::from("m/wan_vae.safetensors"), 250_000_000)];
        assert!(set_roles(&no_diffusion).is_none(), "a VAE alone is not a model");
    }

    #[test]
    fn a_qwen_image_diffusion_model_is_not_mistaken_for_its_encoder() {
        let files = vec![
            (PathBuf::from("q/qwen-image-edit-2511-Q4_K_M.gguf"), 12_000_000_000),
            (PathBuf::from("q/Qwen2.5-VL-7B-Instruct-q4_0.gguf"), 4_400_000_000),
            (PathBuf::from("q/qwen_image_vae.safetensors"), 250_000_000),
        ];
        let parts = set_roles(&files).expect("a set");
        assert_eq!(parts.diffusion, PathBuf::from("q/qwen-image-edit-2511-Q4_K_M.gguf"));
        assert_eq!(parts.llm, Some(PathBuf::from("q/Qwen2.5-VL-7B-Instruct-q4_0.gguf")));
    }

    #[test]
    fn a_set_starts_with_each_part_under_its_flag_and_stays_on_loopback() {
        let parts = SetParts {
            diffusion: PathBuf::from("d.gguf"),
            vae: Some(PathBuf::from("v.safetensors")),
            llm: Some(PathBuf::from("l.gguf")),
            llm_vision: Some(PathBuf::from("mmproj-l.gguf")),
            clip_l: None,
            t5xxl: None,
        };
        let args = args_for_set(&parts, 18431, None);
        let joined = args.join(" ");
        assert!(joined.starts_with("--diffusion-model d.gguf"));
        assert!(joined.contains("--vae v.safetensors"));
        assert!(joined.contains("--llm l.gguf"));
        assert!(joined.contains("--llm_vision mmproj-l.gguf"));
        assert!(!joined.contains("--clip_l"), "an absent part is not passed");
        assert!(joined.contains("--offload-to-cpu"));
        assert!(joined.contains("--vae-tiling"), "the decode that ran out of GPU memory");
        assert!(joined.contains("--listen-ip 127.0.0.1"));
        assert!(!args.iter().any(|a| a == "-m"), "a set is never started with -m");
    }

    #[test]
    fn the_binary_has_one_expected_name_per_platform() {
        assert!(binary_name() == "sd-server.exe" || binary_name() == "sd-server");
        assert!(is_model_name("sd_v1.5-q8_0.gguf"));
        assert!(is_model_name("SDXL.safetensors"));
        assert!(!is_model_name("llama-server.exe"));
        assert!(!is_model_name("notes.txt"));
    }

    #[test]
    fn the_server_is_loopback_only_and_takes_only_the_knobs_given() {
        let args = args_for(Path::new("m.safetensors"), 1234, None);
        assert_eq!(
            args,
            vec!["-m", "m.safetensors", "--listen-ip", "127.0.0.1", "--listen-port", "1234"]
        );
        assert!(!args.iter().any(|a| a == "-t"));
        let threaded = args_for(Path::new("m.safetensors"), 1234, Some(4));
        assert_eq!(threaded[threaded.len() - 2..], ["-t".to_string(), "4".to_string()]);
        // Every address this module builds is this machine.
        assert_eq!(base_url(1234), "http://127.0.0.1:1234");
    }

    #[test]
    fn ports_are_bounded_and_default_to_sd_servers_own() {
        assert_eq!(valid_port(None).unwrap(), DEFAULT_PORT);
        assert_eq!(valid_port(Some(7860)).unwrap(), 7860);
        assert!(valid_port(Some(80)).is_err());
        assert!(valid_port(Some(0)).is_err());
    }

    #[test]
    fn a_job_id_cannot_walk_the_url() {
        assert_eq!(valid_job_id(" job_01HTXYZABC ").unwrap(), "job_01HTXYZABC");
        assert!(valid_job_id("../capabilities").is_err());
        assert!(valid_job_id("a/b").is_err());
        assert!(valid_job_id("").is_err());
        assert!(valid_job_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn the_job_body_is_the_documented_one() {
        let body = job_body("a cat", "", 512, 768, Some(20), Some(7), None, None);
        assert_eq!(body["prompt"], "a cat");
        assert_eq!(body["negative_prompt"], "");
        assert_eq!(body["width"], 512);
        assert_eq!(body["height"], 768);
        assert_eq!(body["batch_count"], 1);
        assert_eq!(body["sample_params"]["sample_steps"], 20);
        assert_eq!(body["seed"], 7);
        // Nothing is invented when nothing was asked for.
        let bare = job_body("a cat", "", 512, 512, None, None, None, None);
        assert!(bare.get("sample_params").is_none());
        assert!(bare.get("seed").is_none());
        // A draw never carries the edit pair.
        assert!(bare.get("init_image").is_none());
        assert!(bare.get("strength").is_none());
    }

    #[test]
    fn an_edit_is_the_same_job_with_the_picture_attached() {
        let edit = job_body("bluer", "", 512, 512, None, None, Some("QUJD"), None);
        assert_eq!(edit["init_image"], "QUJD");
        assert_eq!(edit["strength"], DEFAULT_EDIT_STRENGTH);
        // A mask is never sent: sd.cpp wants one channel and nothing here
        // paints one.
        assert!(edit.get("mask_image").is_none());
        // A strength nobody could mean is clamped rather than refused upstream.
        let strong = job_body("bluer", "", 512, 512, None, None, Some("QUJD"), Some(9.0));
        assert_eq!(strong["strength"], 1.0);
    }

    #[test]
    fn a_source_picture_is_base64_or_it_is_refused() {
        assert_eq!(valid_init_image(" QUJD ").unwrap(), "QUJD");
        let url = "data:image/png;base64,QUJD";
        assert_eq!(valid_init_image(url).unwrap(), url);
        // Not a picture, not a path, not a link this process would go and read.
        assert!(valid_init_image("data:text/plain;base64,QUJD").is_err());
        assert!(valid_init_image("C:\\Users\\me\\secret.png").is_err());
        assert!(valid_init_image("example.com/holiday.png").is_err());
        assert!(valid_init_image("   ").is_err());
        assert!(valid_init_image(&"A".repeat(MAX_INIT_IMAGE_CHARS + 1)).is_err());
    }

    #[test]
    fn a_size_the_machine_cannot_draw_is_refused() {
        assert_eq!(valid_side(512, "width").unwrap(), 512);
        assert!(valid_side(500, "width").is_err(), "not a multiple of 64");
        assert!(valid_side(40000, "width").is_err());
        assert!(valid_side(0, "width").is_err());
    }

    #[test]
    fn the_links_are_pages_on_allowed_hosts() {
        assert!(RELEASES_URL.starts_with("https://github.com/"));
        assert!(MODELS_URL.starts_with("https://huggingface.co/"));
    }
}
