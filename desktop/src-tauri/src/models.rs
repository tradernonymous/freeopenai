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
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

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
    port: u16,
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
    let path = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path) {
        let candidate = entry.join(binary_name());
        if candidate.is_file() {
            return Some((candidate, "path"));
        }
    }
    None
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("cmd");
        cmd.args(["/d", "/s", "/c", "start", "", RELEASES_URL]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open")
            .arg(RELEASES_URL)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
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

/// The arguments, in one place so they can be asserted: loopback only, the
/// model by name, and only the knobs that were actually given.
pub fn args_for(
    spec: &str,
    port: u16,
    ctx: Option<u32>,
    gpu_layers: Option<i32>,
    threads: Option<u32>,
) -> Vec<String> {
    let mut args = vec![
        "-hf".to_string(),
        spec.to_string(),
        "--host".to_string(),
        // A local model is for this machine, not for the network it is on.
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
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
    pub port: u16,
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
            port: active.port,
            pid: active.child.id(),
            uptime_ms: active.started.elapsed().as_millis() as u64,
            base_url: format!("http://127.0.0.1:{}", active.port),
            detail,
        },
        None => ModelStatus {
            state: "stopped".to_string(),
            repo: String::new(),
            quant: String::new(),
            port: 0,
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
    port: Option<u16>,
    ctx: Option<u32>,
    gpu_layers: Option<i32>,
    threads: Option<u32>,
) -> Result<ModelStatus, String> {
    let repo = repo.trim().to_string();
    if repo.is_empty() {
        return Err("A model needs a Hugging Face repository, like unsloth/Qwen3-Coder-30B-GGUF.".to_string());
    }
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
    let spec = spec_for(&repo, &quant);

    let mut command = Command::new(&binary);
    command.args(args_for(&spec, port, ctx, gpu_layers, threads));
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
            port,
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
        let args = args_for("repo:Q4", 8080, None, None, None);
        assert_eq!(args, vec!["-hf", "repo:Q4", "--host", "127.0.0.1", "--port", "8080"]);
        // Never 0.0.0.0, whatever the caller asks for.
        assert!(args.iter().any(|a| a == "127.0.0.1"));
        assert!(!args.iter().any(|a| a == "0.0.0.0"));

        let full = args_for("repo:Q4", 9000, Some(8192), Some(-1), Some(8));
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
    }
}
