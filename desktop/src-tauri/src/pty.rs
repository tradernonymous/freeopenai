// NEURA-058: a real terminal.
//
// local.rs runs ONE command per call: spawn, read both pipes to the end, hand
// back a settled result. That shape cannot host a program that talks back. A
// REPL has no end, `git rebase -i` wants a screen, an installer wants an
// answer, and a progress bar wants to redraw the line it already wrote. None
// of those are missing features of local_run -- they are things a pipe cannot
// do. They need a pseudo-terminal.
//
// So this module opens one (portable-pty 0.9, which is ConPTY on Windows and
// openpty everywhere else), starts the user's shell inside it, and moves bytes:
// what the shell writes goes to the page as a `pty-output` event, what the page
// types comes back through `pty_write`. xterm.js draws it. `cd` is the shell's
// again -- there is one live process now, so it keeps its own working directory
// and nothing here has to fake it.
//
// ---------------------------------------------------------------------------
// THE SAFETY GATE, AND WHY IT MOVED RATHER THAN VANISHED
// ---------------------------------------------------------------------------
//
// local.rs refuses a destructive command BEFORE it is spawned: local::risk_of()
// names the rule, and the caller has to say `approve_risky` to get past it. A
// PTY has no "before". There is one long-lived shell and the user is typing
// into it a byte at a time; by the time "git push" is a command it has already
// been read by the shell, and there is no seam to stop it at. Pretending
// otherwise would mean parsing a half-typed line and guessing -- a gate that
// can be walked around (`g\bit push`, an alias, a script, a paste) is worse
// than no gate, because it is a promise the app cannot keep.
//
// The honest split is by AUTHOR, not by mechanism:
//
//   * `pty_write` is the user's own keyboard. It is not gated, for the same
//     reason cmd.exe is not gated: this is the user's shell, on the user's
//     machine, and they typed it. The dock is wired so that ONLY xterm's
//     onData handler calls it.
//   * `pty_run` is how anything that is not a human -- the coding agent, a
//     recipe, a button -- puts a command into that shell, and it runs the very
//     same local::risk_of() check, with local.rs's own wording, before a single
//     byte reaches the pty. One line only, so the string that was judged is the
//     string that runs.
//
// The protection agent-run commands have today is therefore not dropped: the
// agent's `run_command` tool still goes through local_run (gated), and if it is
// ever pointed at the live terminal instead it lands on pty_run (gated). What
// changed is that the human's own typing is no longer treated as a tool call.
//
// ---------------------------------------------------------------------------
// The other two rules, both about not leaving a mess:
//
//   * a session dies with its screen (`pty_close` on unmount), with a second
//     `pty_open` of the same id (a re-open is a restart, not a second shell),
//     and with the app -- `shutdown()` is armed the first time a pty is opened
//     by listening for the "app-quitting" event main.rs emits on tray Quit. The
//     shell is killed AND its tree is killed, because `cmd /c npm test` is two
//     processes and reaping the first orphans the second (local.rs kill_tree).
//   * output is bounded. `yes` writes faster than any UI can draw, so the bytes
//     are buffered here, flushed at most once per FLUSH_EVERY, and the buffer is
//     capped at MAX_PENDING with the OLDEST bytes dropped -- a terminal only
//     ever shows the newest screen anyway, and an unbounded Vec plus an
//     unbounded event rate is how a `yes` loop takes the window down.
use base64::Engine;
use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, PtySystem,
    SlavePty,
};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Listener};

use crate::local;

/// One read from the pty. Bigger than a line, smaller than a screen of a fast
/// writer, so a flood is drained in few syscalls.
const READ_CHUNK: usize = 8 * 1024;
/// At most one `pty-output` event per session per this long. An idle terminal
/// still feels instant (the first byte after a quiet moment flushes at once);
/// a flood is capped at ~60 events a second instead of thousands.
const FLUSH_EVERY: Duration = Duration::from_millis(16);
/// The ceiling on bytes held between two flushes. Past this the OLDEST bytes go:
/// a terminal shows the newest screen, and memory must not follow `yes`.
const MAX_PENDING: usize = 256 * 1024;
/// A terminal smaller than this is not a terminal, and one larger than this is
/// a number the page got wrong.
const MIN_COLS: u16 = 8;
const MAX_COLS: u16 = 1000;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 500;

struct Session {
    /// Kept so the pty stays open: dropping the master is what closes it.
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Split out from the child so the shell can be killed while the reaping
    /// thread is parked in `wait()`.
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    alive: Arc<AtomicBool>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static MAP: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A poisoned lock still holds a usable map: one panicked thread must not take
/// every terminal down with it (mcp.rs takes the same line).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The session id is a name the page makes up, so only characters a key can be
/// built from survive it -- and an id that leaves nothing behind is refused
/// rather than quietly renamed, because two callers must not collide on it.
fn safe_id(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        return Err("A terminal needs an id.".to_string());
    }
    Ok(cleaned)
}

/// The user's shell, as the OS names it. COMSPEC and SHELL are what every other
/// terminal on the machine honours.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn clamp(value: Option<u16>, fallback: u16, low: u16, high: u16) -> u16 {
    value.unwrap_or(fallback).clamp(low, high)
}

/// Kill what the shell started, not just the shell. local.rs carries the same
/// paragraph: on Windows `cmd /c npm test` is two processes, and reaping the
/// first leaves the second writing into a folder nobody is watching.
fn kill_tree(pid: Option<u32>) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // No console: a black window flashing over the app would be its own
        // bug report.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Some(pid) = pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Elsewhere the shell is the session leader of the pty and the kernel
        // hangs the rest of the job off it, so killing the child (done by the
        // caller) already takes the group with it.
        let _ = pid;
    }
}

/// Every terminal, on Quit. Armed by `arm_quit_guard` the first time one is
/// opened, so main.rs needs nothing but the module and its commands.
pub fn shutdown() {
    let all: Vec<Session> = lock(sessions()).drain().map(|(_, s)| s).collect();
    for mut s in all {
        s.alive.store(false, Ordering::SeqCst);
        let _ = s.killer.kill();
        kill_tree(s.pid);
    }
}

/// main.rs emits "app-quitting" on tray Quit and waits before exiting; that is
/// the moment every shell this app started has to die. Registered once.
fn arm_quit_guard(app: &tauri::AppHandle) {
    static ARMED: std::sync::Once = std::sync::Once::new();
    ARMED.call_once(|| {
        app.listen("app-quitting", |_| shutdown());
    });
}

/// Drain the pty into `pty-output` events: one thread reading (so a blocking
/// read never delays anything else) and one coalescing, so the page gets whole
/// chunks at a bounded rate instead of a syscall's worth at a time.
fn pump(app: tauri::AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut dropped = false;
        let mut last = Instant::now();
        loop {
            match rx.recv_timeout(FLUSH_EVERY) {
                Ok(chunk) => {
                    pending.extend_from_slice(&chunk);
                    if pending.len() > MAX_PENDING {
                        let cut = pending.len() - MAX_PENDING;
                        pending.drain(..cut);
                        dropped = true;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&app, &id, &mut pending, &mut dropped);
                    break;
                }
            }
            if !pending.is_empty() && last.elapsed() >= FLUSH_EVERY {
                flush(&app, &id, &mut pending, &mut dropped);
                last = Instant::now();
            }
        }
    });
}

/// Bytes go to the page base64'd, not as a String: a pty splits UTF-8 wherever
/// the read happened to end, and lossy-decoding half a character here would
/// write a permanent replacement mark into the user's scrollback. xterm.js
/// takes a Uint8Array and does the decoding itself, across chunks.
fn flush(app: &tauri::AppHandle, id: &str, pending: &mut Vec<u8>, dropped: &mut bool) {
    if pending.is_empty() {
        return;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&pending[..]);
    let _ = app.emit(
        "pty-output",
        serde_json::json!({ "id": id, "data": data, "dropped": *dropped }),
    );
    pending.clear();
    *dropped = false;
}

/// Wait for the shell, tell the page, and forget the session. A pid that is
/// never waited for is a zombie, and a session left in the map is a terminal
/// the user can still type into after it has gone.
fn reap(
    app: tauri::AppHandle,
    id: String,
    mut child: Box<dyn Child + Send + Sync>,
    alive: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let status = child.wait();
        alive.store(false, Ordering::SeqCst);
        let code = status.ok().map(|s| s.exit_code());
        // Only forget the session if it is still OURS. A close-then-open of the
        // same id puts a live shell under that key while this thread is parked
        // in wait(), and a blind remove here would delete the new one.
        {
            let mut guard = lock(sessions());
            let ours = guard
                .get(&id)
                .map(|current| Arc::ptr_eq(&current.alive, &alive))
                .unwrap_or(false);
            if ours {
                guard.remove(&id);
            }
        }
        let _ = app.emit(
            "pty-exit",
            serde_json::json!({ "id": id, "exitCode": code }),
        );
    });
}

/// Open a terminal in the open folder (or a folder inside it) and start the
/// user's shell in it. A second open of the same id replaces the first.
#[tauri::command(async)]
pub fn pty_open(
    app: tauri::AppHandle,
    id: String,
    root: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<serde_json::Value, String> {
    let id = safe_id(&id)?;
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("That folder is not there any more: {}", root));
    }
    // Where the shell STARTS is still confined to the open folder, by local.rs's
    // own resolver. Where it goes afterwards is the user's business: this is
    // their shell, and a `cd ..` typed into it is not something a terminal can
    // honestly refuse (see the gate note at the top of this file).
    let work_dir = match cwd
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty() && *c != ".")
    {
        Some(rel) => local::resolve_inside(&root_path, rel)?,
        None => root_path.clone(),
    };
    if !work_dir.is_dir() {
        return Err(format!("Not a folder: {}", local::relative_to(&root_path, &work_dir)));
    }

    // A re-open is a restart. Without this, a remount would leave the first
    // shell running with nothing reading it.
    close(id.clone())?;

    let cols = clamp(cols, 80, MIN_COLS, MAX_COLS);
    let rows = clamp(rows, 24, MIN_ROWS, MAX_ROWS);
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair: PtyPair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("Could not open a terminal: {}", e))?;
    let PtyPair { master, slave } = pair;

    let shell = default_shell();
    // Owned OsString / String arguments on purpose: CommandBuilder's setters
    // are generic, and an owned value satisfies every bound they could carry.
    let mut builder = CommandBuilder::new(shell.clone());
    builder.cwd(work_dir.clone().into_os_string());
    // Colour and line editing: a shell that thinks it is on a dumb terminal
    // prints no escapes at all, which is the whole point of doing this.
    builder.env("TERM", "xterm-256color");
    let child = slave
        .spawn_command(builder)
        .map_err(|e| format!("Could not start {}: {}", shell, e))?;
    // The slave end is the shell's now. Holding it here would keep the pty open
    // after the shell exits, so the reader would never see EOF.
    drop(slave);

    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("Could not read from the terminal: {}", e))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("Could not write to the terminal: {}", e))?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    let alive = Arc::new(AtomicBool::new(true));

    arm_quit_guard(&app);
    pump(app.clone(), id.clone(), reader);
    reap(app, id.clone(), child, alive.clone());

    lock(sessions()).insert(
        id.clone(),
        Session {
            master,
            writer,
            killer,
            pid,
            alive,
        },
    );

    Ok(serde_json::json!({
        "id": id,
        "shell": shell,
        "pid": pid,
        "cwd": local::relative_to(&root_path, &work_dir),
        "absoluteCwd": work_dir.display().to_string(),
        "cols": cols,
        "rows": rows,
    }))
}

/// The keystrokes. NOT gated -- this is the user's own shell (see the top of
/// this file). Only xterm's onData handler calls it.
#[tauri::command(async)]
pub fn pty_write(id: String, data: String) -> Result<(), String> {
    let id = safe_id(&id)?;
    let mut guard = lock(sessions());
    let session = guard
        .get_mut(&id)
        .ok_or_else(|| "That terminal is not open.".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("Could not write to the terminal: {}", e))
}

/// A command from something that is not a human -- the coding agent, a recipe,
/// a button. This is the seam local.rs's gate moved to: the same risk_of() rule
/// and the same wording, checked on the whole one-line string before any byte
/// reaches the shell.
#[tauri::command(async)]
pub fn pty_run(
    id: String,
    command: String,
    approve_risky: Option<bool>,
) -> Result<serde_json::Value, String> {
    let id = safe_id(&id)?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("run_command needs a command.".to_string());
    }
    // One line, so what was judged is what runs: a second line would reach the
    // shell without having been the thing the gate (or the user) looked at.
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("Refused: a command sent to the terminal must be a single line.".to_string());
    }
    if let Some(reason) = local::risk_of(trimmed) {
        if !approve_risky.unwrap_or(false) {
            return Err(format!(
                "Refused: that command {} ({}). Approve it to run it anyway.",
                reason, trimmed
            ));
        }
    }
    let mut guard = lock(sessions());
    let session = guard
        .get_mut(&id)
        .ok_or_else(|| "That terminal is not open.".to_string())?;
    let line = format!("{}\r", trimmed);
    session
        .writer
        .write_all(line.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("Could not write to the terminal: {}", e))?;
    Ok(serde_json::json!({ "id": id, "command": trimmed, "sent": true }))
}

/// The window changed shape. Without this the shell still believes the old
/// size and every wrapped line is drawn in the wrong place.
#[tauri::command(async)]
pub fn pty_resize(id: String, cols: Option<u16>, rows: Option<u16>) -> Result<(), String> {
    let id = safe_id(&id)?;
    let size = PtySize {
        rows: clamp(rows, 24, MIN_ROWS, MAX_ROWS),
        cols: clamp(cols, 80, MIN_COLS, MAX_COLS),
        pixel_width: 0,
        pixel_height: 0,
    };
    let guard = lock(sessions());
    let session = guard
        .get(&id)
        .ok_or_else(|| "That terminal is not open.".to_string())?;
    session
        .master
        .resize(size)
        .map_err(|e| format!("Could not resize the terminal: {}", e))
}

/// Close one terminal for good: the shell and everything it started.
#[tauri::command(async)]
pub fn pty_close(id: String) -> Result<serde_json::Value, String> {
    let id = safe_id(&id)?;
    let closed = close(id)?;
    Ok(serde_json::json!({ "closed": closed }))
}

fn close(id: String) -> Result<bool, String> {
    let taken = lock(sessions()).remove(&id);
    match taken {
        Some(mut session) => {
            session.alive.store(false, Ordering::SeqCst);
            let _ = session.killer.kill();
            kill_tree(session.pid);
            // Dropping the master closes the pty, so the reader thread sees EOF
            // and the coalescing thread flushes what is left and stops.
            drop(session);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Which terminals are open. The page uses it to notice a session the shell
/// has already reaped (a shell the user typed `exit` into).
#[tauri::command(async)]
pub fn pty_list() -> Vec<String> {
    let mut ids: Vec<String> = lock(sessions()).keys().cloned().collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_cannot_be_a_path_or_nothing() {
        assert_eq!(safe_id("dock-1").unwrap(), "dock-1");
        assert_eq!(safe_id("../../etc").unwrap(), "etc");
        assert_eq!(safe_id("a/b").unwrap(), "ab");
        assert!(safe_id("").is_err());
        assert!(safe_id("///").is_err());
        assert!(safe_id(&"x".repeat(200)).unwrap().len() <= 64);
    }

    #[test]
    fn a_size_from_the_page_is_clamped_to_something_a_shell_can_use() {
        assert_eq!(clamp(None, 80, MIN_COLS, MAX_COLS), 80);
        assert_eq!(clamp(Some(0), 80, MIN_COLS, MAX_COLS), MIN_COLS);
        assert_eq!(clamp(Some(60000), 80, MIN_COLS, MAX_COLS), MAX_COLS);
        assert_eq!(clamp(Some(120), 80, MIN_COLS, MAX_COLS), 120);
        assert_eq!(clamp(Some(1), 24, MIN_ROWS, MAX_ROWS), MIN_ROWS);
    }

    // The gate agent-run commands keep: pty_run asks local::risk_of the same
    // question local_run asks, so the two surfaces cannot disagree about what
    // needs a human.
    #[test]
    fn the_agent_path_still_asks_the_same_question_as_local_run() {
        assert!(local::risk_of("npm test").is_none());
        assert!(local::risk_of("git push origin main").is_some());
        assert!(local::risk_of("rm -rf node_modules").is_some());
    }

    // The buffer a `yes` loop fills has a ceiling, and the oldest bytes are the
    // ones that go.
    #[test]
    fn the_output_buffer_drops_the_oldest_bytes_rather_than_growing() {
        let mut pending: Vec<u8> = Vec::new();
        for _ in 0..40 {
            pending.extend_from_slice(&vec![b'y'; READ_CHUNK]);
            if pending.len() > MAX_PENDING {
                let cut = pending.len() - MAX_PENDING;
                pending.drain(..cut);
            }
        }
        assert_eq!(pending.len(), MAX_PENDING);
    }
}
