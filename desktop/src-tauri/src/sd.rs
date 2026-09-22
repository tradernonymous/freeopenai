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
    let model = remembered(model_file(&app)).ok_or_else(|| {
        "No model chosen: pick a .safetensors, .ckpt or .gguf under Images, \"On this PC\".".to_string()
    })?;
    let port = valid_port(port)?;
    // One server at a time, and the old one goes first: two of these would
    // fight over the port and over the machine's memory.
    shutdown();

    let mut command = Command::new(&binary);
    command.args(args_for(&model, port, threads));
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
    body
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
) -> Result<serde_json::Value, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("An image needs a prompt.".to_string());
    }
    let width = valid_side(width, "width")?;
    let height = valid_side(height, "height")?;
    let port = running_port()
        .ok_or_else(|| "The local image server is not running: start it first.".to_string())?;
    let body = job_body(
        &prompt,
        negative_prompt.unwrap_or_default().trim(),
        width,
        height,
        steps,
        seed,
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
        let body = job_body("a cat", "", 512, 768, Some(20), Some(7));
        assert_eq!(body["prompt"], "a cat");
        assert_eq!(body["negative_prompt"], "");
        assert_eq!(body["width"], 512);
        assert_eq!(body["height"], 768);
        assert_eq!(body["batch_count"], 1);
        assert_eq!(body["sample_params"]["sample_steps"], 20);
        assert_eq!(body["seed"], 7);
        // Nothing is invented when nothing was asked for.
        let bare = job_body("a cat", "", 512, 512, None, None);
        assert!(bare.get("sample_params").is_none());
        assert!(bare.get("seed").is_none());
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
