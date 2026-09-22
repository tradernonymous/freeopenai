// Local MCP servers over stdio: the shell is the MCP host (docs/adr/0001).
//
// A server on this PC is a program the person named -- `npx -y @scope/server`,
// `uvx something`, a path to an .exe -- that speaks newline-delimited JSON-RPC
// on its stdin and stdout. This module owns those processes the way models.rs
// owns llama-server: spawned here, kept in one map keyed by the frontend's id,
// and reaped on Stop or on Quit, so a server cannot outlive the window.
//
// The rules:
//   * the program is spawned directly with its arguments. There is no shell in
//     between, so an argument is an argument and never a second command.
//   * `initialize` (protocol 2025-06-18) and `notifications/initialized` happen
//     in `mcp_stdio_start`; a server that cannot finish the handshake is killed
//     and its stderr tail is the error.
//   * stdout lines that are not JSON, and notifications, are ignored. A request
//     FROM the server gets an answer (`ping` a result, anything else "method not
//     found"), so a server that asks something never waits forever.
//   * stderr is kept as a short ring buffer -- the explanation a failed start
//     needs -- and nothing else is logged. Env values never leave this file.
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// How much of a server's stderr is kept for the error a failure shows.
const STDERR_LINES: usize = 40;
const STDERR_LINE_CHARS: usize = 400;
/// A first `npx -y` run downloads the package before it can answer.
const INIT_TIMEOUT_MS: u64 = 90_000;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// More than this many at once is a runaway frontend, not a person.
const MAX_SERVERS: usize = 16;
/// What the frontend splits an error on to show the stderr tail by itself.
const STDERR_MARK: &str = "\n\nstderr:\n";

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<serde_json::Value>>>>;
type Tail = Arc<Mutex<VecDeque<String>>>;
type Input = Arc<Mutex<Option<ChildStdin>>>;

struct Server {
    child: Child,
    stdin: Input,
    pending: Pending,
    stderr: Tail,
    alive: Arc<AtomicBool>,
}

fn servers() -> &'static Mutex<HashMap<String, Server>> {
    static MAP: OnceLock<Mutex<HashMap<String, Server>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// JSON-RPC ids, unique across every server this app runs.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A poisoned lock still holds a usable map: one panicked thread must not take
/// every server down with it.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The id is a name the frontend makes up (tools.slug of the server name), so
/// only characters an id can be built from survive.
fn safe_id(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        Err("A local MCP server needs a name.".to_string())
    } else {
        Ok(cleaned)
    }
}

fn tail_text(tail: &Tail) -> String {
    lock(tail).iter().cloned().collect::<Vec<String>>().join("\n")
}

fn with_tail(message: &str, tail: &Tail) -> String {
    let text = tail_text(tail);
    if text.trim().is_empty() {
        message.to_string()
    } else {
        format!("{}{}{}", message, STDERR_MARK, text)
    }
}

/// One JSON-RPC message, one line. serde_json's compact form never contains a
/// raw newline (a newline inside a string is escaped), which is what the stdio
/// transport's framing relies on.
fn write_line(stdin: &Input, message: &serde_json::Value) -> Result<(), String> {
    let mut text = serde_json::to_string(message).map_err(|e| e.to_string())?;
    text.push('\n');
    let mut guard = lock(stdin);
    match guard.as_mut() {
        Some(pipe) => pipe
            .write_all(text.as_bytes())
            .and_then(|_| pipe.flush())
            .map_err(|e| format!("The server's input is closed: {}", e)),
        None => Err("The server has been stopped.".to_string()),
    }
}

/// A response goes to whoever is waiting for its id; a request from the server
/// is answered; a notification is dropped.
fn route(message: &serde_json::Value, pending: &Pending, stdin: &Input) {
    let method = message.get("method").and_then(|m| m.as_str());
    let id = message.get("id");
    match (method, id) {
        (None, Some(id)) => {
            if let Some(n) = id.as_u64() {
                let waiter = lock(pending).remove(&n);
                if let Some(tx) = waiter {
                    let _ = tx.send(message.clone());
                }
            }
        }
        (Some(method), Some(id)) if !id.is_null() => {
            let reply = if method == "ping" {
                serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} })
            } else {
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("NeuraOS does not support {}", method) },
                })
            };
            // Written off the reader thread: if a request is mid-write into a
            // full pipe, the reader must keep draining stdout or neither moves.
            let input = stdin.clone();
            std::thread::spawn(move || {
                let _ = write_line(&input, &reply);
            });
        }
        _ => {}
    }
}

fn read_stdout<R: Read + Send + 'static>(stream: R, pending: Pending, stdin: Input, alive: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            // A banner, a progress line, a stray console.log: not ours to read.
            let message: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            route(&message, &pending, &stdin);
        }
        // The server is gone. Dropping every waiting sender wakes each request
        // with "exited before answering" instead of letting it run to its timeout.
        alive.store(false, Ordering::SeqCst);
        lock(&pending).clear();
    });
}

fn read_stderr<R: Read + Send + 'static>(stream: R, tail: Tail) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text: String = String::from_utf8_lossy(&line)
                .trim_end()
                .chars()
                .take(STDERR_LINE_CHARS)
                .collect();
            if text.is_empty() {
                continue;
            }
            let mut guard = lock(&tail);
            if guard.len() >= STDERR_LINES {
                guard.pop_front();
            }
            guard.push_back(text);
        }
    });
}

/// Send one request to a running server and wait for the answer with its id.
/// The global map is held only long enough to find the server, so a slow tool
/// on one server never holds up another.
fn request(id: &str, method: &str, params: serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
    let (stdin, pending, tail, alive) = {
        let map = lock(servers());
        let server = map
            .get(id)
            .ok_or_else(|| format!("The MCP server '{}' is not running. Start it in Settings → Connectors.", id))?;
        (
            server.stdin.clone(),
            server.pending.clone(),
            server.stderr.clone(),
            server.alive.clone(),
        )
    };
    let rpc_id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    lock(&pending).insert(rpc_id, tx);
    // Checked after the waiter is registered: the reader clears the waiters
    // when the server exits, so either it sees this one or this sees it gone.
    if !alive.load(Ordering::SeqCst) {
        lock(&pending).remove(&rpc_id);
        return Err(with_tail(&format!("The MCP server '{}' has exited.", id), &tail));
    }
    let mut message = serde_json::json!({ "jsonrpc": "2.0", "id": rpc_id, "method": method });
    if !params.is_null() {
        message["params"] = params;
    }
    if let Err(e) = write_line(&stdin, &message) {
        lock(&pending).remove(&rpc_id);
        return Err(with_tail(&e, &tail));
    }
    let reply = match rx.recv_timeout(timeout) {
        Ok(v) => v,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            lock(&pending).remove(&rpc_id);
            return Err(with_tail(
                &format!("{} got no answer from '{}' within {} s.", method, id, timeout.as_secs()),
                &tail,
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            // The last words on stderr are usually the explanation; give the
            // reader a moment to collect them.
            std::thread::sleep(Duration::from_millis(200));
            return Err(with_tail(
                &format!("The MCP server '{}' exited before answering {}.", id, method),
                &tail,
            ));
        }
    };
    if let Some(error) = reply.get("error") {
        let text = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("the server refused that call");
        return Err(format!("{} failed: {}", method, text));
    }
    Ok(reply.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

/// A bare name (`npx`, `uvx`, `node`) the way a person types it. Windows'
/// process API only appends .exe, and `npx` is `npx.cmd`, so PATH is searched
/// here for the extensions a terminal would try. Anything with a folder or an
/// extension in it is used exactly as given.
fn resolve_program(command: &str, env: &HashMap<String, String>) -> PathBuf {
    let given = PathBuf::from(command);
    if !cfg!(windows) || command.contains('/') || command.contains('\\') || given.extension().is_some() {
        return given;
    }
    let path = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    for dir in path.split(';') {
        let dir = dir.trim();
        if dir.is_empty() {
            continue;
        }
        for ext in ["exe", "cmd", "bat", "com"] {
            let candidate = Path::new(dir).join(format!("{}.{}", command, ext));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    given
}

/// Stop a server and what it started: `npx` is a launcher, and killing it alone
/// leaves the node process it spawned running. The same tree kill local.rs uses.
fn kill_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_server(id: &str) -> bool {
    let server = lock(servers()).remove(id);
    match server {
        Some(mut s) => {
            // Killed before the input is closed: a write blocked on a server
            // that stopped reading holds the input's lock until the pipe breaks.
            kill_tree(&mut s.child);
            lock(&s.stdin).take();
            true
        }
        None => false,
    }
}

/// Every server, on Quit (main.rs, next to models::shutdown).
pub fn shutdown() {
    let all: Vec<Server> = lock(servers()).drain().map(|(_, s)| s).collect();
    for mut s in all {
        kill_tree(&mut s.child);
        lock(&s.stdin).take();
    }
}

/// Start (or restart) a local server and complete the MCP handshake. Answers
/// with what the server said about itself.
#[tauri::command(async)]
pub fn mcp_stdio_start(
    id: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = safe_id(&id)?;
    let program = command.trim();
    if program.is_empty() {
        return Err("A local MCP server needs a command to run.".to_string());
    }
    if program.contains('\0') {
        return Err("A command cannot contain a NUL byte.".to_string());
    }
    // A second Start is a restart, not a second copy.
    stop_server(&id);
    if lock(servers()).len() >= MAX_SERVERS {
        return Err(format!("At most {} local MCP servers can run at once; stop one first.", MAX_SERVERS));
    }
    let env = env.unwrap_or_default();
    let args = args.unwrap_or_default();

    let mut builder = Command::new(resolve_program(program, &env));
    builder
        .args(&args)
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        let folder = PathBuf::from(dir);
        if !folder.is_dir() {
            return Err(format!("The working folder is not there: {}", dir));
        }
        builder.current_dir(folder);
    }
    // No console: a server is a background process, and a black window per
    // server would be its own bug report.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        builder.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = builder
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", program, e))?;

    let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => {
            kill_tree(&mut child);
            return Err("The server started without its pipes.".to_string());
        }
    };
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let tail: Tail = Arc::new(Mutex::new(VecDeque::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let input: Input = Arc::new(Mutex::new(Some(stdin)));
    read_stdout(stdout, pending.clone(), input.clone(), alive.clone());
    read_stderr(stderr, tail.clone());
    let pid = child.id();
    lock(servers()).insert(
        id.clone(),
        Server {
            child,
            stdin: input.clone(),
            pending,
            stderr: tail,
            alive,
        },
    );

    let init = request(
        &id,
        "initialize",
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "NeuraOS", "version": env!("CARGO_PKG_VERSION") },
        }),
        Duration::from_millis(INIT_TIMEOUT_MS),
    );
    let result = match init {
        Ok(r) => r,
        Err(e) => {
            stop_server(&id);
            return Err(e);
        }
    };
    let initialized = serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    if let Err(e) = write_line(&input, &initialized) {
        stop_server(&id);
        return Err(e);
    }
    Ok(serde_json::json!({
        "id": id,
        "pid": pid,
        "protocolVersion": result.get("protocolVersion").cloned().unwrap_or(serde_json::Value::Null),
        "serverInfo": result.get("serverInfo").cloned().unwrap_or(serde_json::Value::Null),
        "capabilities": result.get("capabilities").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

/// One JSON-RPC request (`tools/list`, `tools/call`, ...) to a running server:
/// its `result`, or its error as the message.
#[tauri::command(async)]
pub fn mcp_stdio_request(
    id: String,
    method: String,
    params: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let id = safe_id(&id)?;
    let method = method.trim();
    if method.is_empty() {
        return Err("An MCP request needs a method.".to_string());
    }
    if method == "initialize" {
        return Err("initialize is done once, by Start.".to_string());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, MAX_TIMEOUT_MS));
    request(&id, method, params.unwrap_or(serde_json::Value::Null), timeout)
}

#[tauri::command(async)]
pub fn mcp_stdio_stop(id: String) -> serde_json::Value {
    let stopped = safe_id(&id).map(|key| stop_server(&key)).unwrap_or(false);
    serde_json::json!({ "stopped": stopped })
}

/// The ids of the servers still running. One that exited on its own stays in
/// the map (so a request can still say why, with its stderr) but is not listed.
#[tauri::command]
pub fn mcp_stdio_list() -> Vec<String> {
    let mut map = lock(servers());
    let mut ids: Vec<String> = Vec::new();
    for (key, server) in map.iter_mut() {
        let running = server.alive.load(Ordering::SeqCst) && matches!(server.child.try_wait(), Ok(None));
        if running {
            ids.push(key.clone());
        }
    }
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_only_name_characters() {
        assert_eq!(safe_id("github").unwrap(), "github");
        assert_eq!(safe_id("my_server-2").unwrap(), "my_server-2");
        assert_eq!(safe_id("../../x").unwrap(), "x");
        assert!(safe_id("").is_err());
        assert!(safe_id("...").is_err());
        assert!(safe_id(&"a".repeat(200)).unwrap().len() <= 64);
    }

    #[test]
    fn a_path_or_an_extension_is_used_as_given() {
        let env = HashMap::new();
        assert_eq!(resolve_program("C:/tools/server.exe", &env), PathBuf::from("C:/tools/server.exe"));
        assert_eq!(resolve_program("./server", &env), PathBuf::from("./server"));
        assert_eq!(resolve_program("server.cmd", &env), PathBuf::from("server.cmd"));
    }

    #[test]
    fn the_stderr_tail_rides_the_error() {
        let tail: Tail = Arc::new(Mutex::new(VecDeque::new()));
        assert_eq!(with_tail("failed", &tail), "failed");
        lock(&tail).push_back("npm ERR! 404".to_string());
        assert_eq!(with_tail("failed", &tail), format!("failed{}npm ERR! 404", STDERR_MARK));
    }
}
