// Local filesystem and command runner.
//
// Everything this app touches today that is a *file* lives on the engine: the
// workspace tree, the terminal, the builds. This module is the other half --
// real paths on this machine -- and it carries the engine's confinement rules
// ported rule-for-rule, so the two surfaces cannot disagree about what "inside
// the folder" means:
//
//   * a path is always relative to the open folder. Absolute paths, drive
//     letters and NUL bytes are refused outright.
//   * `..` may climb only while it stays inside the folder (agent-sessions.js
//     gets this from path.resolve; here it is a lexical walk).
//   * the nearest existing ancestor is canonicalised and re-checked, so a
//     symlink or a Windows junction cannot carry a write outside the folder.
//   * .git internals and secrets files are readable but never written -- the
//     same protected_path() rule as agent-sessions.js.
//   * a command that is destructive by nature is refused unless the caller
//     says it was approved.
//
// The frontend carries the same rules in src/local-fs.js so a path can be
// refused with a readable message before crossing the boundary, and
// test/desktop-local.test.js asserts the two files' lists are identical.
//
// The WORDS of a refusal matter: agent-sessions.js recognises a failed tool
// call by its opening words, so "Refused:", "old_text was not found" and the
// rest are the engine's own phrases, kept verbatim so the local coding agent
// (P7) reads them the same way.
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// A text file larger than this is not a document, it is a data dump: read the
/// head and say so.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;
/// The same ceiling for a write, so a runaway caller cannot fill the disk in
/// one call.
pub const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;
/// Per stream, in the result the caller gets back (the live events are not
/// capped: a long build must still stream).
pub const MAX_RUN_OUTPUT: usize = 512 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const MAX_ENTRIES: usize = 4000;

/// Never written, whatever the caller asks for.
pub const PROTECTED_DIRS: &[&str] = &[".git"];
/// Never written, except the template everyone commits.
pub const PROTECTED_FILES: &[&str] = &[".env"];

/// Commands that are destructive by nature. Matched as a lowercased substring,
/// so "git status && git push" is caught. A refusal is not a wall: the caller
/// passes `approve_risky` once a human has said yes.
pub const RISKY: &[(&str, &str)] = &[
    ("git push", "pushes commits to a remote"),
    ("git reset --hard", "throws away uncommitted work"),
    ("git clean -", "deletes untracked files"),
    ("git checkout --", "discards local edits"),
    ("gh release delete", "deletes a published release"),
    ("gh repo delete", "deletes a repository"),
    ("npm publish", "publishes a package"),
    ("cargo publish", "publishes a crate"),
    ("rm -rf", "deletes a tree recursively"),
    ("rm -r ", "deletes a tree recursively"),
    ("rmdir /s", "deletes a tree recursively"),
    ("del /f", "force-deletes files"),
    ("remove-item -recurse", "deletes a tree recursively"),
    ("format ", "formats a disk"),
    ("diskpart", "edits disk partitions"),
    ("bcdedit", "edits the boot configuration"),
    ("cipher /w", "wipes free space"),
    ("takeown", "takes ownership of files"),
    ("reg delete", "deletes registry keys"),
    ("shutdown", "powers the machine off"),
    ("drop table", "drops a database table"),
    ("truncate table", "empties a database table"),
    ("curl | sh", "pipes a download into a shell"),
    ("curl | bash", "pipes a download into a shell"),
    ("iwr | iex", "pipes a download into a shell"),
    ("start-process -verb runas", "asks for administrator rights"),
];

fn is_drive_absolute(wanted: &str) -> bool {
    let bytes = wanted.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Whether `child` sits at or under `root`. Windows paths compare
/// case-insensitively, so a differently-cased root cannot turn into a false
/// refusal (and, more importantly, cannot turn into a false pass).
fn under(child: &Path, root: &Path) -> bool {
    if child == root {
        return true;
    }
    if cfg!(windows) {
        let child = child.to_string_lossy().to_lowercase().replace('/', "\\");
        let root = root
            .to_string_lossy()
            .to_lowercase()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_string();
        child.starts_with(&format!("{}\\", root))
    } else {
        child.starts_with(root)
    }
}

/// Resolve a caller-supplied path inside `root`, or say why not. The engine's
/// resolveInside(), rule for rule.
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let wanted = rel.trim().replace('\\', "/");
    if wanted.contains('\0') {
        return Err("A path cannot contain a NUL byte.".to_string());
    }
    if wanted.starts_with('/') || is_drive_absolute(&wanted) {
        return Err("Refused: only paths inside the open folder can be used.".to_string());
    }
    let mut out = root.to_path_buf();
    for part in wanted.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                if !out.pop() || !under(&out, root) {
                    return Err("Refused: that path climbs out of the open folder.".to_string());
                }
            }
            other => {
                if other.contains(':') {
                    return Err(format!(
                        "Refused: a file name cannot contain ':'. ({} was given.)",
                        other
                    ));
                }
                out.push(other);
            }
        }
    }

    // The lexical answer can still be a lie: a symlink or a junction inside the
    // folder can point anywhere. The nearest existing ancestor is canonicalised
    // and re-checked -- when the path itself exists, that is the path itself.
    let mut probe: &Path = out.as_path();
    loop {
        if probe.exists() || probe == root {
            break;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err("Refused: that path climbs out of the open folder.".to_string()),
        }
    }
    let real_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Could not resolve the open folder: {}", e))?;
    let real_probe = std::fs::canonicalize(probe)
        .map_err(|e| format!("Could not resolve {}: {}", probe.display(), e))?;
    if !under(&real_probe, &real_root) {
        return Err("Refused: that path leads outside the open folder through a link.".to_string());
    }
    Ok(out)
}

/// A path relative to the root, with forward slashes -- the form every other
/// surface here speaks.
pub fn relative_to(root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(root).unwrap_or(file);
    let text = rel.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        ".".to_string()
    } else {
        text
    }
}

/// A fresh, empty folder for one throwaway run.
///
/// This is the part of the plan's "build sandbox" that is honestly available
/// here. It is NOT a security boundary and this app does not pretend it is:
/// the command still runs as the user, with the user's rights, and can still
/// read whatever the user can read. What it buys is the half that matters for
/// day-to-day work -- a build script, an installer, a `npm ci` that decides to
/// write where it was started, writes into a folder that is deleted the moment
/// the run ends. The opened project is not what got scribbled on.
fn scratch_dir(app: &tauri::AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No cache folder to build a sandbox in: {}", e))?
        .join("sandbox")
        .join(safe_segment(run_id));
    std::fs::create_dir_all(&base).map_err(|e| format!("Could not make the sandbox: {}", e))?;
    Ok(base)
}

/// A run id is a name the frontend makes up, so it is treated like anything
/// else crossing that boundary: only characters a folder name can be built
/// from survive, and an id that leaves nothing behind still gets a name.
fn safe_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "run".to_string()
    } else {
        cleaned
    }
}

/// Files a write must not touch even when approved. Empty string means fine.
/// The engine's protectedPath(), including its wording.
pub fn protected_path(rel: &str) -> String {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| PROTECTED_DIRS.contains(p)) {
        return "Refused: files inside .git are managed by git; use run_command with git instead."
            .to_string();
    }
    let base = parts.last().copied().unwrap_or("").to_lowercase();
    let is_secret = PROTECTED_FILES.contains(&base.as_str())
        || (base.starts_with(".env.") && base != ".env.example");
    if is_secret {
        return "Refused: secrets files (.env) are never written.".to_string();
    }
    String::new()
}

/// Why a command needs a human's yes, or None if it is ordinary.
pub fn risk_of(command: &str) -> Option<String> {
    let lowered = command.to_lowercase();
    RISKY
        .iter()
        .find(|(pattern, _)| lowered.contains(*pattern))
        .map(|(pattern, reason)| format!("'{}' {}", pattern.trim(), reason))
}

fn bad_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

#[derive(serde::Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub ext: String,
}

/// The native folder picker. An async command, so the dialog does not freeze
/// the window it belongs to.
#[tauri::command(async)]
pub fn local_pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Open a folder for the local agent")
        .pick_folder()
        .map(|p| p.display().to_string())
}

/// One level of the real filesystem. Dirs first, then names, case-insensitively
/// -- so the tree reads the same way in every folder.
#[tauri::command(async)]
pub fn local_list_dir(root: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("That folder is not there any more: {}", root));
    }
    let rel = path.unwrap_or_default();
    let dir = resolve_inside(&root_path, &rel)?;
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", rel));
    }
    let mut entries: Vec<Entry> = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| format!("Could not read {}: {}", rel, e))?;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let full = item.path();
        let meta = match std::fs::metadata(&full) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            full.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        entries.push(Entry {
            name,
            path: relative_to(&root_path, &full),
            dir: is_dir,
            size: meta.len(),
            ext,
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(serde_json::json!({
        "path": relative_to(&root_path, &dir),
        "absolute": dir.display().to_string(),
        "entries": entries,
        "capped": entries.len() >= MAX_ENTRIES,
    }))
}

/// The text of a file. A binary file is reported as binary rather than decoded
/// into replacement characters; a big one is truncated with the reason.
#[tauri::command(async)]
pub fn local_read_file(root: String, path: String) -> Result<serde_json::Value, String> {
    let root_path = PathBuf::from(&root);
    let file = resolve_inside(&root_path, &path)?;
    let meta = std::fs::metadata(&file)
        .map_err(|e| format!("No such file: {} ({})", path, e))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder.", path));
    }
    let limit = std::cmp::min(meta.len(), MAX_READ_BYTES) as usize;
    let mut handle = std::fs::File::open(&file).map_err(|e| format!("Could not open {}: {}", path, e))?;
    let mut buffer = vec![0u8; limit];
    let mut filled = 0usize;
    while filled < limit {
        match handle.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(format!("Could not read {}: {}", path, e)),
        }
    }
    buffer.truncate(filled);
    let binary = bad_bytes(&buffer);
    Ok(serde_json::json!({
        "path": relative_to(&root_path, &file),
        "absolute": file.display().to_string(),
        "bytes": meta.len(),
        "binary": binary,
        "truncated": meta.len() > MAX_READ_BYTES as u64,
        "text": if binary { String::new() } else { String::from_utf8_lossy(&buffer).to_string() },
    }))
}

fn write_text(root: &Path, rel: &str, text: &str) -> Result<serde_json::Value, String> {
    if text.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Refused: that file would be {} MB, past the {} MB limit for one write.",
            text.len() / (1024 * 1024),
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let file = resolve_inside(root, rel)?;
    let relative = relative_to(root, &file);
    let protected = protected_path(&relative);
    if !protected.is_empty() {
        return Err(protected);
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
    }
    std::fs::write(&file, text).map_err(|e| format!("Could not write {}: {}", relative, e))?;
    Ok(serde_json::json!({
        "path": relative,
        "absolute": file.display().to_string(),
        "bytes": text.len(),
        "created": true,
    }))
}

#[tauri::command(async)]
pub fn local_write_file(root: String, path: String, content: String) -> Result<serde_json::Value, String> {
    write_text(Path::new(&root), &path, &content)
}

/// Replace one span of text. The engine's edit_file semantics, including its
/// wording: a miss is "old_text was not found" and an ambiguous hit asks for
/// more context rather than guessing which one was meant.
#[tauri::command(async)]
pub fn local_edit_file(
    root: String,
    path: String,
    old_text: String,
    new_text: String,
    replace_all: Option<bool>,
) -> Result<serde_json::Value, String> {
    if old_text.is_empty() {
        return Err("Refused: edit needs the text to replace (old_text).".to_string());
    }
    let root_path = PathBuf::from(&root);
    let file = resolve_inside(&root_path, &path)?;
    let relative = relative_to(&root_path, &file);
    let protected = protected_path(&relative);
    if !protected.is_empty() {
        return Err(protected);
    }
    let current = std::fs::read_to_string(&file)
        .map_err(|e| format!("Could not read {}: {}", relative, e))?;
    let hits = current.matches(&old_text).count();
    if hits == 0 {
        return Err(format!("old_text was not found in {}.", relative));
    }
    let all = replace_all.unwrap_or(false);
    if hits > 1 && !all {
        return Err(format!(
            "old_text appears {} times in {}; give more context or set replace_all.",
            hits, relative
        ));
    }
    let updated = if all {
        current.replace(&old_text, &new_text)
    } else {
        current.replacen(&old_text, &new_text, 1)
    };
    if updated.len() > MAX_WRITE_BYTES {
        return Err("Refused: that edit would make the file too large.".to_string());
    }
    std::fs::write(&file, &updated).map_err(|e| format!("Could not write {}: {}", relative, e))?;
    Ok(serde_json::json!({
        "path": relative,
        "absolute": file.display().to_string(),
        "replaced": if all { hits } else { 1 },
        "bytes": updated.len(),
    }))
}

/// Run a command here, streaming both streams line by line as `local-run`
/// events, and return the settled result. The command is refused, not run, if
/// it is destructive and the caller has not marked it approved.
#[tauri::command(async)]
pub fn local_run(
    app: tauri::AppHandle,
    root: String,
    run_id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    approve_risky: Option<bool>,
    sandbox: Option<bool>,
) -> Result<serde_json::Value, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("That folder is not there any more: {}", root));
    }
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("run_command needs a command.".to_string());
    }
    if let Some(reason) = risk_of(trimmed) {
        if !approve_risky.unwrap_or(false) {
            return Err(format!(
                "Refused: that command {} ({}). Approve it to run it anyway.",
                reason,
                trimmed.lines().next().unwrap_or("")
            ));
        }
    }
    // A sandbox run happens somewhere of this app's choosing, so a cwd would be
    // a second, quieter answer to "where does this run" -- refused rather than
    // ignored, because the caller that asked for both meant one of them.
    let scratch = if sandbox.unwrap_or(false) {
        if cwd.as_deref().map(str::trim).filter(|c| !c.is_empty() && *c != ".").is_some() {
            return Err(
                "Refused: a sandbox run starts in its own empty folder, so it cannot also be given a cwd."
                    .to_string(),
            );
        }
        Some(scratch_dir(&app, &run_id)?)
    } else {
        None
    };
    let work_dir = match &scratch {
        Some(dir) => dir.clone(),
        None => match cwd.as_deref().map(str::trim).filter(|c| !c.is_empty() && *c != ".") {
            Some(rel) => resolve_inside(&root_path, rel)?,
            None => root_path.clone(),
        },
    };
    if !work_dir.is_dir() {
        return Err(format!(
            "Not a folder: {}",
            relative_to(&root_path, &work_dir)
        ));
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));

    let mut builder = shell_command(trimmed);
    builder
        .current_dir(&work_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = builder
        .spawn()
        .map_err(|e| format!("Could not start the command: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = stdout.map(|s| pump(s, app.clone(), run_id.clone(), "stdout"));
    let err_handle = stderr.map(|s| pump(s, app.clone(), run_id.clone(), "stderr"));

    let started = Instant::now();
    let mut timed_out = false;
    let mut code: Option<i32> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code();
                break;
            }
            Ok(None) => {}
            Err(e) => return Err(format!("The command could not be waited for: {}", e)),
        }
        if started.elapsed() >= timeout {
            kill_tree(&mut child);
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }

    let out_text = out_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let err_text = err_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default();

    // The scratch folder goes away whatever happened: finished, refused at the
    // gate above (so we never get here), or timed out and tree-killed. Nothing
    // a throwaway run wrote outlives the run.
    let in_sandbox = scratch.is_some();
    if let Some(dir) = &scratch {
        let _ = std::fs::remove_dir_all(dir);
    }

    Ok(serde_json::json!({
        "runId": run_id,
        "command": trimmed,
        "sandbox": in_sandbox,
        "cwd": if in_sandbox {
            "(scratch)".to_string()
        } else {
            relative_to(&root_path, &work_dir)
        },
        "absoluteCwd": work_dir.display().to_string(),
        "exitCode": code,
        "timedOut": timed_out,
        // The field name src/run-result.js already formats.
        "durationMs": started.elapsed().as_millis(),
        "stdout": clamp(&out_text),
        "stderr": clamp(&err_text),
        "stdoutTruncated": out_text.len() > MAX_RUN_OUTPUT,
        "stderrTruncated": err_text.len() > MAX_RUN_OUTPUT,
    }))
}

/// Stop a run for good, and stop what the run started.
///
/// `child.kill()` reaps the shell and nothing it started: `cmd /C npm test` is
/// two processes, and killing the first leaves the second running -- a test
/// runner still writing into a folder the app has stopped watching, or a
/// llama-server still holding a port after the session that wanted it is gone.
/// The plan for this app called that "automatic cleanup"; on Windows it has one
/// honest implementation, and it is to kill the tree by its root pid.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // No console: this runs while a terminal panel is on screen, and a
        // black window flashing over it would be its own bug report.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    // The root is still reaped here, whatever the tree kill did: a pid is not
    // reusable until it is waited for, and a zombie child would outlive the run.
    let _ = child.kill();
    let _ = child.wait();
}

fn clamp(text: &str) -> String {
    if text.len() <= MAX_RUN_OUTPUT {
        return text.to_string();
    }
    let mut cut = MAX_RUN_OUTPUT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…[output truncated]", &text[..cut])
}

/// Read a child's stream to the end, emitting each line as it arrives and
/// collecting the whole thing for the result.
fn pump<R: Read + Send + 'static>(
    stream: R,
    app: tauri::AppHandle,
    run_id: String,
    kind: &'static str,
) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut whole = String::new();
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    whole.push_str(&text);
                    let _ = app.emit(
                        "local-run",
                        serde_json::json!({
                            "runId": run_id,
                            "stream": kind,
                            "text": text,
                        }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(
            "local-run",
            serde_json::json!({ "runId": run_id, "stream": kind, "done": true }),
        );
        whole
    })
}

#[cfg(windows)]
fn shell_command(command: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new("cmd");
    // /d skips AutoRun scripts, /s keeps the quoting rules predictable, /c runs
    // the command line as given. The command goes RAW inside one pair of
    // quotes, which /s strips: through .args() Rust would escape every inner
    // `"` as `\"`, a form cmd does not understand, so `git commit -m "msg"`
    // reached git with stray backslashes.
    cmd.args(["/d", "/s", "/c"]);
    cmd.raw_arg(format!("\"{}\"", command));
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", command]);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join("freeai4u-local-test")
    }

    #[test]
    fn paths_stay_inside_the_folder() {
        let r = root();
        assert!(resolve_inside(&r, "src/main.rs").is_ok());
        assert!(resolve_inside(&r, "./a/../b.txt").is_ok());
        assert!(resolve_inside(&r, "").is_ok());
        assert!(resolve_inside(&r, "..").is_err());
        assert!(resolve_inside(&r, "../secrets.txt").is_err());
        assert!(resolve_inside(&r, "a/../../secrets.txt").is_err());
        assert!(resolve_inside(&r, "C:/Windows/System32/cmd.exe").is_err());
        assert!(resolve_inside(&r, r"C:\Windows\System32\cmd.exe").is_err());
        assert!(resolve_inside(&r, "/etc/passwd").is_err());
        assert!(resolve_inside(&r, "a\0b").is_err());
        // A colon is a drive letter or an NTFS stream, never a file name.
        assert!(resolve_inside(&r, "dir:stream").is_err());
    }

    #[test]
    fn a_scratch_name_cannot_climb_out_of_its_folder() {
        // The run id is the only part of the sandbox path that comes from the
        // frontend, so it is the only part that needs proving.
        assert_eq!(safe_segment("run-1712345678901"), "run-1712345678901");
        assert_eq!(safe_segment("../../etc"), "etc");
        assert_eq!(safe_segment(r"..\..\Windows"), "Windows");
        assert_eq!(safe_segment(""), "run");
        assert_eq!(safe_segment("..."), "run");
        assert_eq!(safe_segment("a/b"), "ab");
        assert!(safe_segment(&"x".repeat(200)).len() <= 64);
    }

    #[test]
    fn refusal_wording_matches_the_engine() {
        // agent-sessions.js classifies a failed tool call by its first words.
        let err = resolve_inside(&root(), "../x").unwrap_err();
        assert!(err.starts_with("Refused:"), "{}", err);
        let err = resolve_inside(&root(), "C:/x").unwrap_err();
        assert!(err.starts_with("Refused:"), "{}", err);
        assert!(protected_path(".git/config").starts_with("Refused:"));
        assert!(protected_path("a/.env").starts_with("Refused:"));
    }

    #[test]
    fn git_and_secrets_are_never_written() {
        assert!(protected_path("src/main.rs").is_empty());
        assert!(protected_path("src/app.tsx").is_empty());
        assert!(protected_path(".env.example").is_empty());
        assert!(!protected_path(".env").is_empty());
        assert!(!protected_path("app/.env.local").is_empty());
        assert!(!protected_path(".git/HEAD").is_empty());
        assert!(!protected_path("nested/.git/objects/x").is_empty());
    }

    #[test]
    fn destructive_commands_need_a_yes() {
        assert!(risk_of("git status").is_none());
        assert!(risk_of("npm test").is_none());
        assert!(risk_of("ls -la").is_none());
        assert!(risk_of("git push origin main").is_some());
        assert!(risk_of("git status && git push").is_some());
        assert!(risk_of("rm -rf node_modules").is_some());
        assert!(risk_of("Remove-Item -Recurse -Force .").is_some());
        assert!(risk_of("shutdown /s /t 0").is_some());
        assert!(risk_of("GH RELEASE DELETE desktop-latest").is_some());
    }

    #[test]
    fn drive_letters_are_detected_but_relative_paths_are_not() {
        assert!(is_drive_absolute("c:/x"));
        assert!(is_drive_absolute("Z:"));
        assert!(!is_drive_absolute("src/app"));
        assert!(!is_drive_absolute("./c:x"));
    }

    #[test]
    fn the_ancestor_check_is_prefix_aware() {
        let r = PathBuf::from(if cfg!(windows) { "C:\\work\\app" } else { "/work/app" });
        assert!(under(&r, &r));
        assert!(under(&r.join("src/main.rs"), &r));
        // A sibling folder whose name merely starts with the root's must not pass.
        let sibling = PathBuf::from(if cfg!(windows) { "C:\\work\\app-secrets" } else { "/work/app-secrets" });
        assert!(!under(&sibling, &r));
        assert!(!under(&r.parent().unwrap(), &r));
    }

    #[test]
    fn binary_detection_looks_at_the_head_only() {
        assert!(bad_bytes(b"abc\0def"));
        assert!(!bad_bytes(b"plain text\n"));
        assert!(!bad_bytes(&[b'a'; 9000]));
    }
}
