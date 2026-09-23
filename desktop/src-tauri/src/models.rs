// A local model server: llama.cpp's `llama-server`, run by this app, on this
// machine.
//
// The engine can already point at any OpenAI-compatible gateway -- including a
// llama.cpp server -- but it cannot START one, and the app has no way to say
// "this model runs here". That is what this module is: find the binary, run it
// with a Hugging Face repo and quant (`llama-server -hf <repo>:<quant>`, which
// is llama.cpp's own downloader, so nothing here has to fetch gigabytes
// itself), wait for it to become healthy, and stop it.
//
// Since Phase 0 of the desktop roadmap it also OWNS THE WEIGHTS: a GGUF from
// Hugging Face is downloaded into the app's models folder with progress the
// user can see, resumed if it stopped, and run with `-m <file>`; and a GGUF
// that is already on the machine (an Unsloth Studio or Hugging Face cache, or
// any folder the user points at) is found and run from where it is. `-hf` is
// still accepted for a repo the app has not fetched, in which case llama.cpp's
// own downloader runs -- silently, which is why the app has its own.
//
// Three rules, all of them about not lying to the user:
//
//   * the binary is the user's. This app does not ship one and does not fetch
//     one behind their back: `local_server_use` copies the file they chose into
//     the app's own folder, and `local_open_releases` opens the page to get it
//     from. A verified download of a release we have not hashed would be a
//     claim we cannot make.
//   * the server is started on loopback only (`--host 127.0.0.1`), so a local
//     model is never exposed to the network it happens to be sitting on.
//   * stopping is real: the child is killed and reaped, and the app reaps it on
//     exit too, because a model server left running after the window closes is
//     a process the user cannot see and did not ask for.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const DEFAULT_PORT: u16 = 8080;
/// Where the user gets the binary from. The release page, not a direct asset:
/// an asset URL is a URL that rots, and the page always has the newest build
/// for their platform.
pub const RELEASES_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/latest";

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

struct Run {
    child: Child,
    repo: String,
    quant: String,
    file: String,
    port: u16,
    api_key: String,
    started: Instant,
}

fn slot() -> &'static Mutex<Option<Run>> {
    static RUN: OnceLock<Mutex<Option<Run>>> = OnceLock::new();
    RUN.get_or_init(|| Mutex::new(None))
}

/// Kill whatever is running. Called by `local_model_stop` and on app exit.
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

fn llama_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?
        .join("llama");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Where downloaded weights live: <app data>/models. One flat folder, files
/// named as the Hub names them, so a listing is self-explanatory.
pub fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Where the binary is: the app's own folder first (the copy the user chose),
/// then PATH. An explicit path in the app's folder wins because it is the one
/// the app put there.
fn find_binary(app: &tauri::AppHandle) -> Option<(PathBuf, &'static str)> {
    if let Ok(dir) = llama_dir(app) {
        let own = dir.join(binary_name());
        if own.is_file() {
            return Some((own, "app"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            let candidate = entry.join(binary_name());
            if candidate.is_file() {
                return Some((candidate, "path"));
            }
        }
    }
    // Unsloth Studio installs a llama.cpp build of its own. It is run from
    // where it is (it needs the DLLs beside it), never copied.
    unsloth_binaries().into_iter().find(|p| p.is_file()).map(|p| (p, "unsloth"))
}

/// Where Unsloth Studio keeps its prebuilt llama-server.
pub fn unsloth_binaries() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Vec::new();
    };
    let root = PathBuf::from(home).join(".unsloth").join("llama.cpp");
    vec![
        root.join("build").join("bin").join("Release").join(binary_name()),
        root.join("build").join("bin").join(binary_name()),
        root.join("llama.cpp").join("build").join("bin").join("Release").join(binary_name()),
        root.join(binary_name()),
    ]
}

fn log_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("llama-server.log"))
}

#[derive(serde::Serialize)]
pub struct ServerFacts {
    pub found: bool,
    pub path: String,
    pub source: String,
    pub expected_name: String,
    pub releases_url: String,
    pub dir: String,
}

#[tauri::command(async)]
pub fn local_server_find(app: tauri::AppHandle) -> ServerFacts {
    let found = find_binary(&app);
    ServerFacts {
        found: found.is_some(),
        path: found.as_ref().map(|(p, _)| p.display().to_string()).unwrap_or_default(),
        source: found.as_ref().map(|(_, s)| s.to_string()).unwrap_or_default(),
        expected_name: binary_name().to_string(),
        releases_url: RELEASES_URL.to_string(),
        dir: llama_dir(&app).map(|d| d.display().to_string()).unwrap_or_default(),
    }
}

/// Take the binary the user pointed at. A native dialog has already asked them
/// for it; this refuses anything that is not the server by name, so a
/// mistyped path cannot become "the thing this app runs".
#[tauri::command(async)]
pub fn local_server_use(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
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
            "That file is {}, not {}. Pick {} from the release you downloaded.",
            name,
            binary_name(),
            binary_name()
        ));
    }
    let dir = llama_dir(&app)?;
    let destination = dir.join(binary_name());
    std::fs::copy(&source, &destination)
        .map_err(|e| format!("Could not copy {}: {}", source.display(), e))?;
    Ok(serde_json::json!({
        "path": destination.display().to_string(),
        "bytes": std::fs::metadata(&destination).map(|m| m.len()).unwrap_or(0),
    }))
}

/// The native picker for the binary the user downloaded.
#[tauri::command(async)]
pub fn local_server_pick(app: tauri::AppHandle) -> Option<String> {
    let picked = rfd::FileDialog::new()
        .set_title("Choose llama-server (from the llama.cpp release you downloaded)")
        .pick_file()
        .map(|p| p.display().to_string())?;
    local_server_use(app, picked.clone()).ok()?;
    Some(picked)
}

/// Open the releases page in the user's browser. https and one host: this runs
/// a command, so it is not a general-purpose launcher.
#[tauri::command(async)]
pub fn local_open_releases() -> Result<(), String> {
    if !RELEASES_URL.starts_with("https://github.com/") {
        return Err("refused: not a github.com address".to_string());
    }
    crate::net::open_in_browser(RELEASES_URL)
}

/// `unsloth/Qwen3-Coder-30B-GGUF` + `Q4_K_M` -> the `-hf` argument llama.cpp
/// wants. A repo with no quant lets llama.cpp choose.
pub fn spec_for(repo: &str, quant: &str) -> String {
    let quant = quant.trim();
    if quant.is_empty() {
        return repo.trim().to_string();
    }
    format!("{}:{}", repo.trim(), quant)
}

/// What the server loads: a Hub spec llama.cpp fetches itself, or a file on
/// this machine.
pub enum ModelSource {
    Hub(String),
    File(PathBuf),
}

/// A random key for the loopback server. Loopback is not a boundary between
/// programs: any process (or any web page a browser is showing) can POST to
/// 127.0.0.1:8080. The key makes the server this app's, and the status hands
/// it to the frontend, which is the only caller that should have it.
pub fn new_api_key() -> String {
    let mut bytes = [0u8; 24];
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stack = &bytes as *const _ as usize as u128;
    let pid = std::process::id() as u128;
    // Not a CSPRNG, and it does not need to be: this guards a local port for
    // the life of one process against drive-by requests, not against a
    // process that can already read this one's memory. A splitmix-style mix
    // over the seed gives bytes that differ between calls and processes.
    let mut x = seed ^ stack.rotate_left(17) ^ pid.rotate_left(41);
    for b in bytes.iter_mut() {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15_9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9_BF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB_94D0_49BB_1331_11EB);
        *b = ((z ^ (z >> 31)) & 0xff) as u8;
    }
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// The arguments, in one place so they can be asserted: loopback only, the
/// model by name or file, tool calling on, and only the knobs that were
/// actually given.
pub fn args_for(
    source: &ModelSource,
    port: u16,
    ctx: Option<u32>,
    gpu_layers: Option<i32>,
    threads: Option<u32>,
    api_key: &str,
) -> Vec<String> {
    let mut args = match source {
        ModelSource::Hub(spec) => vec!["-hf".to_string(), spec.to_string()],
        ModelSource::File(path) => vec!["-m".to_string(), path.display().to_string()],
    };
    args.extend([
        "--host".to_string(),
        // A local model is for this machine, not for the network it is on.
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        // Without --jinja the OpenAI `tools` field is ignored and every tool
        // call comes back as prose (llama.cpp docs/function-calling.md).
        "--jinja".to_string(),
    ]);
    if !api_key.is_empty() {
        args.push("--api-key".to_string());
        args.push(api_key.to_string());
    }
    if let Some(ctx) = ctx {
        args.push("--ctx-size".to_string());
        args.push(ctx.to_string());
    }
    if let Some(layers) = gpu_layers {
        args.push("--n-gpu-layers".to_string());
        args.push(layers.to_string());
    }
    if let Some(threads) = threads {
        args.push("--threads".to_string());
        args.push(threads.to_string());
    }
    args
}

/// Whether the server answers `/health`, and what it says.
///
/// llama.cpp answers 503 while a model is still loading and 200 with
/// `{"status":"ok"}` once it is up, which is the difference between "starting"
/// and "ready" -- the thing a progress line needs to be honest about.
async fn health(port: u16) -> (bool, String) {
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => return (false, e.to_string()),
    };
    match client.get(&url).send().await {
        Ok(response) => {
            let code = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let short = body.chars().take(200).collect::<String>();
            (code == 200, if code == 200 { short } else { format!("{} {}", code, short) })
        }
        Err(e) => (false, e.to_string()),
    }
}

#[derive(serde::Serialize)]
pub struct ModelStatus {
    pub state: String,
    pub repo: String,
    pub quant: String,
    pub file: String,
    pub port: u16,
    /// The bearer token the frontend must send; empty when nothing runs.
    pub api_key: String,
    pub pid: u32,
    pub uptime_ms: u64,
    pub base_url: String,
    pub detail: String,
}

fn snapshot(run: &Option<Run>, healthy: bool, detail: String) -> ModelStatus {
    match run {
        Some(active) => ModelStatus {
            state: if healthy { "ready" } else { "starting" }.to_string(),
            repo: active.repo.clone(),
            quant: active.quant.clone(),
            file: active.file.clone(),
            port: active.port,
            api_key: active.api_key.clone(),
            pid: active.child.id(),
            uptime_ms: active.started.elapsed().as_millis() as u64,
            base_url: format!("http://127.0.0.1:{}", active.port),
            detail,
        },
        None => ModelStatus {
            state: "stopped".to_string(),
            repo: String::new(),
            quant: String::new(),
            file: String::new(),
            port: 0,
            api_key: String::new(),
            pid: 0,
            uptime_ms: 0,
            base_url: String::new(),
            detail,
        },
    }
}

#[tauri::command(async)]
pub async fn local_model_status() -> ModelStatus {
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
    let (ok, detail) = health(port).await;
    let guard = match slot().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    snapshot(&guard, ok, detail)
}

/// Start a model, wait for it to answer, and report what actually happened.
///
/// `-hf <repo>:<quant>` makes llama.cpp fetch and cache the weights itself --
/// the documented Unsloth path, and the reason this app needs no GGUF
/// downloader of its own.
#[tauri::command(async)]
pub async fn local_model_start(
    app: tauri::AppHandle,
    repo: String,
    quant: Option<String>,
    file: Option<String>,
    port: Option<u16>,
    ctx: Option<u32>,
    gpu_layers: Option<i32>,
    threads: Option<u32>,
) -> Result<ModelStatus, String> {
    let repo = repo.trim().to_string();
    let file = file.unwrap_or_default().trim().to_string();
    // A file wins over a repo: it is the thing the app (or the user) already
    // has. A bare name is looked up in the models folder; a path must exist.
    let source = if !file.is_empty() {
        ModelSource::File(resolve_model_file(&app, &file)?)
    } else {
        if repo.is_empty() {
            return Err("A model needs a Hugging Face repository, like unsloth/Qwen3-Coder-30B-GGUF, or a file.".to_string());
        }
        ModelSource::Hub(String::new())
    };
    let (binary, _) = find_binary(&app).ok_or_else(|| {
        format!(
            "{} is not here yet. Get it from {} and choose the file in Settings → Local models.",
            binary_name(),
            RELEASES_URL
        )
    })?;
    shutdown();

    let port = port.unwrap_or(DEFAULT_PORT);
    let quant = quant.unwrap_or_default().trim().to_string();
    let source = match source {
        ModelSource::Hub(_) => ModelSource::Hub(spec_for(&repo, &quant)),
        other => other,
    };
    let spec = match &source {
        ModelSource::Hub(spec) => spec.clone(),
        ModelSource::File(path) => path.display().to_string(),
    };
    let api_key = new_api_key();

    let mut command = Command::new(&binary);
    command.args(args_for(&source, port, ctx, gpu_layers, threads, &api_key));
    command.stdin(Stdio::null());
    // The server's own log is the only place a load failure explains itself,
    // so it goes to the app's log directory rather than nowhere.
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
            repo: repo.clone(),
            quant: quant.clone(),
            file: file.clone(),
            port,
            api_key,
            started: Instant::now(),
        });
    }

    // Wait for /health. A 4B model on a cold cache takes a while to load, but
    // "a while" is not forever: a deadline, and then the log's own words.
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let exited = {
            let mut guard = match slot().lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match guard.as_mut() {
                Some(run) => match run.child.try_wait() {
                    Ok(Some(status)) => Some(format!("llama-server exited with {}", status)),
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
        let (ok, detail) = health(port).await;
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
                "{} did not become ready within 180s. {}",
                spec, tail
            ));
        }
        std::thread::sleep(Duration::from_millis(750));
    }
}

fn log_tail(app: &tauri::AppHandle) -> String {
    let Some(path) = log_file(app) else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    // The last thing the server said is what explains a failure to load; the
    // whole log is in the diagnostics bundle.
    let tail: String = text.chars().rev().take(1200).collect::<String>().chars().rev().collect();
    tail.trim().to_string()
}

/// A model file the frontend named: either a file in the models folder, or an
/// absolute path to a .gguf that exists (one the scan found). Anything else
/// is refused, so "start this file" cannot become "run llama-server on
/// whatever path a page says".
fn resolve_model_file(app: &tauri::AppHandle, file: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(file);
    let path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        models_dir(app)?.join(crate::net::sanitize_name(file)?)
    };
    let is_gguf = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err(format!("{} is not a .gguf file", path.display()));
    }
    if !path.is_file() {
        return Err(format!("No model file at {}", path.display()));
    }
    Ok(path)
}

/// The Hub URL for one file of one repo. The repo is two path segments; the
/// file is a bounded path of clean segments -- a name, a folder and a name
/// for the split layouts, or deeper for repos that sort their weights into
/// `split/diffusion_models/...`. Every segment is checked, so a page cannot
/// turn this into a request for another host or another path.
pub fn hub_file_url(repo: &str, file: &str) -> Result<String, String> {
    hub_file_url_for(Kind::Text, repo, file)
}

/// `hub_file_url` for one kind of weights: the same path rules, then that
/// kind's formats instead of GGUF alone.
pub fn hub_file_url_for(kind: Kind, repo: &str, file: &str) -> Result<String, String> {
    let repo = repo.trim().trim_matches('/');
    let ok_segment = |s: &str| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || !parts.iter().all(|p| ok_segment(p)) {
        return Err(format!("{} is not an owner/name repository id", repo));
    }
    let file = file.trim().trim_matches('/');
    let file_parts: Vec<&str> = file.split('/').collect();
    if file_parts.is_empty() || file_parts.len() > MAX_FILE_DEPTH || !file_parts.iter().all(|p| ok_segment(p)) {
        return Err(format!("{} is not a file name this app will fetch", file));
    }
    kind.check_file(file)?;
    Ok(format!("https://huggingface.co/{}/resolve/main/{}", repo, file))
}

/// What a download is for, which decides the folder it lands in and the
/// formats it may be. Text is llama-server's (GGUF, <app data>/models), and
/// is what a call that names no kind gets, so the Local models card is
/// untouched. Image and voice land where sd.rs and whisper.rs already look,
/// so a finished file is in their lists with nothing else to set up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Image,
    Voice,
}

impl Kind {
    pub fn parse(raw: Option<&str>) -> Result<Kind, String> {
        let clean = raw.map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
        match clean.as_str() {
            "" | "text" => Ok(Kind::Text),
            "image" => Ok(Kind::Image),
            "voice" => Ok(Kind::Voice),
            other => Err(format!("{} is not a kind of model this app downloads", other)),
        }
    }

    /// The formats each tool loads. `.ckpt` is not among the image ones even
    /// though sd.cpp reads it: a .ckpt is a Python pickle, and unpickling a
    /// file from a stranger's repo can run whatever code they put in it. The
    /// same repos almost always carry a .safetensors of the same weights.
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Kind::Text => &["gguf"],
            Kind::Image => &["safetensors", "gguf"],
            Kind::Voice => &["bin"],
        }
    }

    /// Is this repo file one this kind may fetch? The refusal says why, in
    /// words, because "not allowed" alone reads as a bug.
    pub fn check_file(self, file: &str) -> Result<(), String> {
        let lower = file.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or("").to_string();
        if self == Kind::Text {
            // Exactly the rule and the words it always had.
            if !lower.ends_with(".gguf") {
                return Err(format!("{} is not a .gguf file", file));
            }
            return Ok(());
        }
        // A pickle is refused by name before the format rule, so the reason
        // given is the real one rather than "wrong format". A transformers
        // `pytorch_model.bin` is a pickle behind a .bin name.
        let pickled = [".ckpt", ".pt", ".pth", ".pkl", ".pickle"].iter().any(|ext| lower.ends_with(ext))
            || base.starts_with("pytorch_model")
            || base.starts_with("training_args");
        if pickled {
            return Err(format!(
                "{} is a pickled checkpoint, and loading one can run arbitrary code on this PC. Pick the .safetensors or .gguf file of the same model.",
                file
            ));
        }
        if !self.extensions().iter().any(|ext| lower.ends_with(&format!(".{}", ext))) {
            return Err(match self {
                Kind::Image => format!("{} is not a .safetensors or .gguf file, the formats sd-server loads", file),
                _ => format!("{} is not a ggml .bin file, the format whisper.cpp loads", file),
            });
        }
        Ok(())
    }

    /// The progress event each kind reports on. Text keeps `local-download`;
    /// the others get their own, because the Local models card and the
    /// Dictation card sit on one screen and each should draw only its own bar.
    pub fn event(self) -> &'static str {
        match self {
            Kind::Text => "local-download",
            Kind::Image => "image-download",
            Kind::Voice => "voice-download",
        }
    }

    fn dir(self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        match self {
            Kind::Text => models_dir(app),
            Kind::Image => crate::sd::models_dir(app),
            Kind::Voice => crate::whisper::models_dir(app),
        }
    }
}

/// The folder a component set's files share, under the image folder. A set
/// (diffusion model, VAE, text encoders) goes in a folder of its own so its
/// VAE and encoders are not offered one by one as models to draw with. Only
/// images come in sets, and the name is cleaned to one plain segment.
pub fn set_folder(kind: Kind, set: Option<&str>) -> Result<Option<String>, String> {
    let raw = set.map(|s| s.trim()).unwrap_or("");
    if raw.is_empty() {
        return Ok(None);
    }
    if kind != Kind::Image {
        return Err("Only image models come as sets of files".to_string());
    }
    Ok(Some(crate::net::sanitize_name(raw)?))
}

fn download_dir(app: &tauri::AppHandle, kind: Kind, set: Option<&str>) -> Result<PathBuf, String> {
    let base = kind.dir(app)?;
    match set_folder(kind, set)? {
        None => Ok(base),
        Some(folder) => {
            let dir = base.join(folder);
            std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
            Ok(dir)
        }
    }
}

/// How deep a repo file path may be. The two-segment limit refused every
/// repo that keeps its weights in `split/diffusion_models/<name>.gguf` with
/// "not a file name this app will fetch", a message that read as a typo
/// rather than a rule. Six is more than any layout on the Hub uses and still
/// bounds the request.
const MAX_FILE_DEPTH: usize = 6;

static CANCEL: AtomicBool = AtomicBool::new(false);

/// The smallest file the scan calls a model.
pub const SCAN_MIN_BYTES: u64 = 64 * 1024 * 1024;

fn downloading() -> &'static Mutex<Option<String>> {
    static ACTIVE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

#[derive(serde::Serialize, Clone)]
pub struct DownloadProgress {
    pub repo: String,
    pub file: String,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub cancelled: bool,
    pub error: String,
    pub path: String,
}

fn emit_progress(app: &tauri::AppHandle, kind: Kind, p: &DownloadProgress) {
    // Text's event is spelled out here because the Local models card listens
    // for exactly this name.
    let _ = match kind {
        Kind::Text => app.emit("local-download", p),
        other => app.emit(other.event(), p),
    };
}

/// Download one file from the Hub into the folder its kind runs from.
///
/// Progress goes out as the kind's event (`local-download` for text: bytes
/// received against the total, then done/cancelled/error). The bytes land in `<name>.part` and are
/// renamed only when the whole file arrived, so a listing never shows a
/// half-file as a model; and a `.part` left by a stop or a crash is resumed
/// with a Range request rather than fetched again. One download at a time:
/// two 16 GB streams on one disk help nobody.
///
/// `kind` is text (the default: a GGUF for llama-server, into the models
/// folder), image or voice; `set` names the folder an image component set
/// shares. Text keeps its pause-and-resume stop. For image and voice a stop
/// is a cancel and the `.part` goes with it: those cards offer no resume, and
/// a half-file nobody can see is only lost disk.
#[tauri::command(async)]
pub async fn local_model_download(
    app: tauri::AppHandle,
    repo: String,
    file: String,
    token: Option<String>,
    kind: Option<String>,
    set: Option<String>,
) -> Result<serde_json::Value, String> {
    let kind = Kind::parse(kind.as_deref())?;
    let url = hub_file_url_for(kind, &repo, &file)?;
    let name = crate::net::sanitize_name(&file)?;
    let dir = download_dir(&app, kind, set.as_deref())?;
    let dest = dir.join(&name);
    let part = dir.join(format!("{}.part", name));

    {
        let mut active = match downloading().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(current) = active.as_ref() {
            return Err(format!("{} is still downloading. Wait for it or stop it first.", current));
        }
        *active = Some(name.clone());
    }
    CANCEL.store(false, Ordering::SeqCst);

    let result = download_into(&app, &url, &repo, &file, &dest, &part, token.as_deref(), kind).await;

    if let Ok(mut active) = downloading().lock() {
        *active = None;
    }
    result
}

async fn download_into(
    app: &tauri::AppHandle,
    url: &str,
    repo: &str,
    file: &str,
    dest: &Path,
    part: &Path,
    token: Option<&str>,
    kind: Kind,
) -> Result<serde_json::Value, String> {
    use std::io::Write;

    if dest.is_file() {
        let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        emit_progress(app, kind, &DownloadProgress {
            repo: repo.to_string(),
            file: file.to_string(),
            received: bytes,
            total: bytes,
            done: true,
            cancelled: false,
            error: String::new(),
            path: dest.display().to_string(),
        });
        return Ok(serde_json::json!({ "path": dest.display().to_string(), "bytes": bytes, "resumed": false, "already": true }));
    }

    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut response = crate::net::get_following_with(url, &[], Some(have), token).await?;
    let status = response.status().as_u16();
    // 206 means the server honoured the Range and we append; 200 means it did
    // not (or there was nothing to resume) and the file starts over.
    let (append, mut received) = match status {
        206 if have > 0 => (true, have),
        200 => (false, 0),
        401 | 403 => {
            return Err(format!(
                "Hugging Face refused the download ({}). A gated repo needs a sign-in that accepted its terms.",
                status
            ))
        }
        404 => return Err("That file is not in the repository (404). Pick a quant the repo lists.".to_string()),
        other => return Err(format!("download failed with HTTP {}", other)),
    };
    let total = response
        .content_length()
        .map(|len| if append { len + have } else { len })
        .unwrap_or(0);

    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(append)
        .write(true)
        .truncate(!append)
        .open(part)
        .map_err(|e| format!("cannot write {}: {}", part.display(), e))?;

    let mut progress = DownloadProgress {
        repo: repo.to_string(),
        file: file.to_string(),
        received,
        total,
        done: false,
        cancelled: false,
        error: String::new(),
        path: part.display().to_string(),
    };
    emit_progress(app, kind, &progress);

    let mut last_emit = Instant::now();
    let mut since_emit: u64 = 0;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            let _ = out.flush();
            drop(out);
            if kind != Kind::Text {
                let _ = std::fs::remove_file(part);
            }
            progress.received = received;
            progress.cancelled = true;
            emit_progress(app, kind, &progress);
            return Ok(serde_json::json!({ "path": part.display().to_string(), "bytes": received, "cancelled": true }));
        }
        let chunk = match response.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                progress.received = received;
                progress.error = e.to_string();
                emit_progress(app, kind, &progress);
                return Err(format!("download stopped after {} bytes: {}. Start it again to resume.", received, e));
            }
        };
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        // A progress line every ~4 MB or every quarter second, whichever is
        // first: enough to move a bar, not enough to flood the webview.
        if since_emit >= 4 * 1024 * 1024 || last_emit.elapsed() >= Duration::from_millis(250) {
            progress.received = received;
            emit_progress(app, kind, &progress);
            last_emit = Instant::now();
            since_emit = 0;
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);

    if total > 0 && received != total {
        progress.received = received;
        progress.error = format!("expected {} bytes, received {}", total, received);
        emit_progress(app, kind, &progress);
        return Err(format!("{}. Start the download again to resume.", progress.error));
    }
    std::fs::rename(part, dest).map_err(|e| format!("could not finish {}: {}", dest.display(), e))?;
    progress.received = received;
    progress.total = if total > 0 { total } else { received };
    progress.done = true;
    progress.path = dest.display().to_string();
    emit_progress(app, kind, &progress);
    Ok(serde_json::json!({ "path": dest.display().to_string(), "bytes": received, "resumed": append, "already": false }))
}

#[tauri::command(async)]
pub fn local_model_download_cancel() -> serde_json::Value {
    CANCEL.store(true, Ordering::SeqCst);
    let active = match downloading().lock() {
        Ok(g) => g.clone(),
        Err(p) => p.into_inner().clone(),
    };
    serde_json::json!({ "cancelling": active.is_some(), "file": active.unwrap_or_default() })
}

#[derive(serde::Serialize)]
pub struct ModelFile {
    pub file: String,
    pub path: String,
    pub bytes: u64,
    /// True for a `.part` a download left behind: resumable, not runnable.
    pub partial: bool,
}

fn gguf_entries(dir: &Path, depth: usize, out: &mut Vec<ModelFile>, include_partial: bool) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                gguf_entries(&path, depth - 1, out, include_partial);
            }
            continue;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let lower = name.to_ascii_lowercase();
        let partial = lower.ends_with(".gguf.part");
        if !(lower.ends_with(".gguf") || (include_partial && partial)) {
            continue;
        }
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        out.push(ModelFile {
            file: if partial { name.trim_end_matches(".part").to_string() } else { name },
            path: path.display().to_string(),
            bytes,
            partial,
        });
    }
}

/// What is in the models folder: finished files, and the partial ones a
/// download can pick up again.
#[tauri::command(async)]
pub fn local_models_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = models_dir(&app)?;
    let mut files = Vec::new();
    gguf_entries(&dir, 0, &mut files, true);
    files.sort_by(|a, b| a.file.to_ascii_lowercase().cmp(&b.file.to_ascii_lowercase()));
    Ok(serde_json::json!({ "dir": dir.display().to_string(), "files": files }))
}

/// Remove one file from a kind's folder (its `.part` too). Only those
/// folders, and only that kind's formats: this is not a general delete. A
/// cancelled image set uses it to take back the parts it already finished,
/// and the set's folder goes too once it is empty.
#[tauri::command(async)]
pub fn local_model_delete(
    app: tauri::AppHandle,
    file: String,
    kind: Option<String>,
    set: Option<String>,
) -> Result<serde_json::Value, String> {
    let kind = Kind::parse(kind.as_deref())?;
    let name = crate::net::sanitize_name(&file)?;
    let lower = name.to_ascii_lowercase();
    if !kind.extensions().iter().any(|ext| lower.ends_with(&format!(".{}", ext))) {
        return Err(format!("{} is not a model file", name));
    }
    let in_set = set_folder(kind, set.as_deref())?.is_some();
    let dir = download_dir(&app, kind, set.as_deref())?;
    let mut removed = 0u32;
    for candidate in [dir.join(&name), dir.join(format!("{}.part", name))] {
        if candidate.is_file() {
            std::fs::remove_file(&candidate)
                .map_err(|e| format!("could not delete {}: {}", candidate.display(), e))?;
            removed += 1;
        }
    }
    if in_set {
        // remove_dir takes only an empty folder, so a set folder that still
        // holds anything else is left as it is.
        let _ = std::fs::remove_dir(&dir);
    }
    Ok(serde_json::json!({ "removed": removed }))
}

/// Folders other tools keep GGUFs in on this machine. Only the ones that
/// exist are returned, so the screen shows what is real.
pub fn known_model_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    if let Some(home) = &home {
        // Hugging Face's own cache (also where Unsloth Studio and llama.cpp
        // -hf put what they fetch through huggingface_hub).
        out.push(home.join(".cache").join("huggingface").join("hub"));
        out.push(home.join(".cache").join("llama.cpp"));
        out.push(home.join(".cache").join("unsloth"));
        out.push(home.join(".unsloth"));
        out.push(home.join(".lmstudio").join("models"));
        out.push(home.join("models"));
    }
    if let Some(local) = &local {
        out.push(local.join("llama.cpp"));
        out.push(local.join("unsloth"));
        out.push(local.join("Unsloth"));
        out.push(local.join("unsloth-studio"));
    }
    if let Some(roaming) = &roaming {
        out.push(roaming.join("unsloth"));
        out.push(roaming.join("Unsloth"));
    }
    out.into_iter().filter(|p| p.is_dir()).collect()
}

/// One part of a split set: a name ending `-00002-of-00003.gguf`. Byte-wise,
/// so a non-ASCII name can never split a char.
fn is_split_part(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 20 || !b[b.len() - 5..].eq_ignore_ascii_case(b".gguf") {
        return false;
    }
    let t = &b[b.len() - 20..b.len() - 5];
    t[0] == b'-'
        && t[1..6].iter().all(|c| c.is_ascii_digit())
        && t[6..10].eq_ignore_ascii_case(b"-of-")
        && t[10..15].iter().all(|c| c.is_ascii_digit())
}

/// GGUF files already on this machine: in the folders other tools use, plus
/// any folder the caller names (one the user picked). Depth-limited, so a
/// mistaken pick of a drive root does not walk it.
#[tauri::command(async)]
pub fn local_models_scan(dirs: Option<Vec<String>>) -> serde_json::Value {
    let mut roots = known_model_dirs();
    for extra in dirs.unwrap_or_default() {
        let p = PathBuf::from(extra.trim());
        if p.is_dir() && !roots.contains(&p) {
            roots.push(p);
        }
    }
    let mut files = Vec::new();
    for root in &roots {
        gguf_entries(root, 5, &mut files, false);
    }
    // llama.cpp ships tiny vocab-only .gguf files (ggml-vocab-*.gguf); they
    // are not models. Anything under 64 MB is not one either -- except a part
    // of a split set, whose last part can be small; the frontend folds the
    // parts into one model.
    files.retain(|f| {
        (f.bytes >= SCAN_MIN_BYTES || is_split_part(&f.file))
            && !f.file.to_ascii_lowercase().starts_with("ggml-vocab-")
    });
    files.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    serde_json::json!({
        "dirs": roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "files": files,
    })
}

#[tauri::command(async)]
pub fn local_model_stop() -> serde_json::Value {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_binary_has_one_expected_name_per_platform() {
        assert!(binary_name() == "llama-server.exe" || binary_name() == "llama-server");
    }

    #[test]
    fn the_releases_url_is_the_page_not_a_rotting_asset() {
        assert!(RELEASES_URL.starts_with("https://github.com/"));
        assert!(RELEASES_URL.contains("llama.cpp/releases"));
        assert!(!RELEASES_URL.contains("/download/"));
    }

    #[test]
    fn a_repo_and_quant_become_one_hf_argument() {
        assert_eq!(spec_for("unsloth/Qwen3-Coder-30B-GGUF", "Q4_K_M"), "unsloth/Qwen3-Coder-30B-GGUF:Q4_K_M");
        // No quant named: llama.cpp picks, and the repo stands alone.
        assert_eq!(spec_for("unsloth/Llama-3.2-3B-Instruct-GGUF", "  "), "unsloth/Llama-3.2-3B-Instruct-GGUF");
    }

    #[test]
    fn the_server_is_loopback_only_and_only_takes_the_knobs_given() {
        let hub = ModelSource::Hub("repo:Q4".to_string());
        let args = args_for(&hub, 8080, None, None, None, "");
        assert_eq!(args, vec!["-hf", "repo:Q4", "--host", "127.0.0.1", "--port", "8080", "--jinja"]);
        // Never 0.0.0.0, whatever the caller asks for.
        assert!(args.iter().any(|a| a == "127.0.0.1"));
        assert!(!args.iter().any(|a| a == "0.0.0.0"));

        // A file on disk is passed as -m, and the key guards the port.
        let file = ModelSource::File(PathBuf::from("m/x.gguf"));
        let keyed = args_for(&file, 8080, None, None, None, "k3y");
        assert_eq!(keyed[0], "-m");
        assert!(keyed[1].ends_with("x.gguf"));
        assert!(keyed.windows(2).any(|w| w == ["--api-key", "k3y"]));
        assert!(keyed.iter().any(|a| a == "--jinja"), "tool calling needs the jinja template");

        let full = args_for(&hub, 9000, Some(8192), Some(-1), Some(8), "");
        assert!(full.windows(2).any(|w| w == ["--ctx-size", "8192"]));
        assert!(full.windows(2).any(|w| w == ["--n-gpu-layers", "-1"]));
        assert!(full.windows(2).any(|w| w == ["--threads", "8"]));
        assert!(full.windows(2).any(|w| w == ["--port", "9000"]));
    }

    #[test]
    fn a_stopped_server_reports_no_port_rather_than_a_stale_one() {
        let status = snapshot(&None, false, String::new());
        assert_eq!(status.state, "stopped");
        assert_eq!(status.port, 0);
        assert_eq!(status.base_url, "");
        assert_eq!(status.api_key, "");
    }

    #[test]
    fn api_keys_are_long_and_differ() {
        let a = new_api_key();
        let b = new_api_key();
        assert_eq!(a.len(), 48);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn split_parts_are_recognised_by_their_suffix() {
        assert!(is_split_part("x-UD-Q4_K_XL-00003-of-00003.gguf"));
        assert!(is_split_part("X-00001-OF-00002.GGUF"));
        assert!(!is_split_part("x-UD-Q4_K_XL.gguf"));
        assert!(!is_split_part("x-0001-of-00003.gguf"));
        assert!(!is_split_part("-of-.gguf"));
        assert!(!is_split_part("ñ-00001-of-00002.gguf.part"));
    }

    #[test]
    fn a_hub_url_is_two_segments_and_one_gguf_and_nothing_else() {
        assert_eq!(
            hub_file_url("unsloth/gemma-4-E4B-it-GGUF", "gemma-4-E4B-it-UD-Q4_K_XL.gguf").unwrap(),
            "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-UD-Q4_K_XL.gguf"
        );
        assert!(hub_file_url("unsloth/x-GGUF", "UD-Q4_K_XL/x-UD-Q4_K_XL-00001-of-00002.gguf").is_ok());
        assert!(
            hub_file_url("ChrisColeTech/qwen-image-GGUF", "split/diffusion_models/qwen-image-Q4_K_M.gguf").is_ok(),
            "three deep is a real Hub layout"
        );
        assert!(hub_file_url("a/b", "1/2/3/4/5/6/7.gguf").is_err(), "still bounded");
        assert!(hub_file_url("a/b", "split/../x.gguf").is_err(), "a dot segment never passes");
        assert!(hub_file_url("unsloth", "x.gguf").is_err(), "no owner");
        assert!(hub_file_url("a/b/c", "x.gguf").is_err(), "too deep");
        assert!(hub_file_url("../etc", "x.gguf").is_err());
        assert!(hub_file_url("unsloth/x", "x.safetensors").is_err(), "not a gguf");
        assert!(hub_file_url("unsloth/x", "../x.gguf").is_err());
        assert!(hub_file_url("evil.com/x?y", "x.gguf").is_err());
    }

    #[test]
    fn a_call_that_names_no_kind_is_text_and_text_is_unchanged() {
        assert_eq!(Kind::parse(None).unwrap(), Kind::Text);
        assert_eq!(Kind::parse(Some("  ")).unwrap(), Kind::Text);
        assert_eq!(Kind::parse(Some("Image")).unwrap(), Kind::Image);
        assert_eq!(Kind::parse(Some("voice")).unwrap(), Kind::Voice);
        assert!(Kind::parse(Some("video")).is_err());
        assert_eq!(
            hub_file_url("unsloth/x", "x.safetensors").unwrap_err(),
            "x.safetensors is not a .gguf file",
            "text refuses with the words it always had"
        );
        assert_eq!(hub_file_url("unsloth/x", "x.ckpt").unwrap_err(), "x.ckpt is not a .gguf file");
        assert_eq!(hub_file_url("a/b", "x.gguf"), hub_file_url_for(Kind::Text, "a/b", "x.gguf"));
        assert_eq!(Kind::Text.event(), "local-download", "the Local models card still hears its own bar");
        assert_ne!(Kind::Voice.event(), Kind::Text.event());
        assert_ne!(Kind::Image.event(), Kind::Text.event());
    }

    #[test]
    fn each_kind_takes_its_own_formats_and_no_others() {
        assert!(Kind::Image.check_file("v1-5-pruned-emaonly.safetensors").is_ok());
        assert!(Kind::Image.check_file("split/diffusion_models/qwen-image-Q4_K_M.gguf").is_ok());
        assert!(Kind::Image.check_file("ggml-base.bin").is_err());
        assert!(Kind::Image.check_file("model_index.json").is_err());
        assert!(Kind::Voice.check_file("ggml-base.en.bin").is_ok());
        assert!(Kind::Voice.check_file("ggml-base.en.gguf").is_err());
        assert!(Kind::Voice.check_file("x.safetensors").is_err());
        assert!(Kind::Text.check_file("x.bin").is_err());
    }

    #[test]
    fn a_pickle_is_refused_and_the_refusal_says_why() {
        for file in ["v1-5-pruned.ckpt", "sub/X.CKPT", "model.pt", "vae.pth"] {
            let err = Kind::Image.check_file(file).unwrap_err();
            assert!(err.contains("arbitrary code"), "{} was refused as: {}", file, err);
        }
        let err = Kind::Voice.check_file("pytorch_model.bin").unwrap_err();
        assert!(err.contains("arbitrary code"), "a transformers .bin is a pickle too: {}", err);
        assert!(hub_file_url_for(Kind::Image, "a/b", "x.ckpt").is_err());
    }

    #[test]
    fn the_path_rules_are_as_strict_for_every_kind() {
        for (kind, file) in [(Kind::Image, "x.safetensors"), (Kind::Voice, "ggml-x.bin")] {
            assert!(hub_file_url_for(kind, "a/b", file).is_ok());
            assert!(hub_file_url_for(kind, "a/b", &format!("../{}", file)).is_err());
            assert!(hub_file_url_for(kind, "a/b/c", file).is_err());
            assert!(hub_file_url_for(kind, "evil.com/x?y", file).is_err());
            assert!(hub_file_url_for(kind, "a/b", &format!("1/2/3/4/5/6/{}", file)).is_err());
            assert!(hub_file_url_for(kind, "a/b", &format!(".hidden/{}", file)).is_err());
        }
    }

    #[test]
    fn only_an_image_set_gets_a_folder_and_the_name_is_one_clean_segment() {
        assert_eq!(set_folder(Kind::Image, None).unwrap(), None);
        assert_eq!(set_folder(Kind::Image, Some(" ")).unwrap(), None);
        assert_eq!(
            set_folder(Kind::Image, Some("qwen-image-Q4_K_M")).unwrap(),
            Some("qwen-image-Q4_K_M".to_string())
        );
        assert_eq!(set_folder(Kind::Image, Some("../../evil")).unwrap(), Some("evil".to_string()));
        assert!(set_folder(Kind::Text, Some("x")).is_err());
        assert!(set_folder(Kind::Voice, Some("x")).is_err());
    }
}
