// FreeAI4U Desktop shell (Tauri 2).
//
// Release builds carry windows_subsystem="windows": a GUI app must never
// open a console window (the "black terminal flash" on launch).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

mod save;
use tauri::generate_handler;

const CRASH_FILE: &str = "freeai4u-crash.log";
// A crash loop must not fill the disk: past this size the log is replaced, not
// appended to.
const CRASH_LOG_MAX_BYTES: u64 = 256 * 1024;
const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/?LinkId=2124703";

// The log lives in the app's own directory, not in a shared public folder:
// that location is not writable in a locked-down profile (so the "no silent
// deaths" promise failed exactly when it was needed) and crash text should not
// land somewhere every account can read. Set from Tauri once the app exists;
// the value below is the fallback for a failure that happens before that.
static CRASH_LOG: Mutex<Option<PathBuf>> = Mutex::new(None);
// Set only by the tray Quit: the close handler hides the window (tray-style),
// so it has to be able to tell a close from a quit.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn crash_log_path() -> PathBuf {
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

fn set_crash_log_path(path: PathBuf) {
    if let Ok(mut guard) = CRASH_LOG.lock() {
        *guard = Some(path);
    }
}

fn log_crash(msg: &str) {
    let path = crash_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > CRASH_LOG_MAX_BYTES {
            let _ = std::fs::write(
                &path,
                format!("[{}] log rotated ({} bytes)\n", chrono::Utc::now().to_rfc3339(), meta.len()),
            );
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {}", chrono::Utc::now().to_rfc3339(), msg);
    }
}

fn crash_log_hint() -> String {
    crash_log_path().display().to_string()
}

/// Reads the Registry for the WebView2 runtime the same way the loader does:
/// HKCU first (per-user installs), then HKLM (machine-wide), both the WOW64
/// view and the native one. `pv` is the runtime version; any value counts.
fn webview2_version() -> Option<String> {
    let keys = [
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    let hives = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];
    for hive in hives {
        for key in keys {
            if let Ok(hk) = winreg::RegKey::predef(hive).open_subkey(key) {
                if let Ok(version) = hk.get_value::<String, _>("pv") {
                    if !version.trim().is_empty() {
                        return Some(version);
                    }
                }
            }
        }
    }
    None
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log_crash(&format!("PANIC: {}", info));
    }));

    // The runtime check runs before the app window exists. This is the belt
    // that turns "double-click, nothing happens" into an explanation.
    if webview2_version().is_none() {
        log_crash("WebView2 runtime not found at startup");
        let msg = format!(
            "FreeAI4U needs the free Microsoft WebView2 runtime, which is missing on this PC.\n\n\
             Install it once from:\n{}\n\nThen start FreeAI4U again. (The installer version of \
             FreeAI4U installs it automatically.)",
            WEBVIEW2_DOWNLOAD
        );
        let _ = rfd::MessageDialog::new()
            .set_title("FreeAI4U Desktop")
            .set_level(rfd::MessageLevel::Warning)
            .set_description(&msg)
            .show();
        return;
    }

    tauri::Builder::default()
        .invoke_handler(generate_handler![save::save_file_dialog])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        // Registered for the frontend's future use; today the app stores its
        // settings in localStorage. It must NOT be given a config map here:
        // this plugin version rejects one and the app panics at startup.
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // Now that Tauri knows its own directories, the crash log belongs
            // with the rest of the app's data.
            if let Ok(dir) = app.path().app_log_dir() {
                set_crash_log_path(dir.join(CRASH_FILE));
            }
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        id: _,
                        position: _,
                        rect: _,
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        // A clean exit through Tauri, not a raw process kill:
                        // the shutdown runs, so the window-state plugin persists
                        // the window position and the WebView2 children are
                        // reaped instead of being orphaned.
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Closing the window hides it (the app lives in the tray) --
                // except while quitting, when the close must go through so
                // Tauri's own shutdown can run.
                if QUITTING.load(Ordering::SeqCst) {
                    return;
                }
                let _ = window.hide();
                api.prevent_close();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| fatal_error(&e.to_string()));
}

/// Any boot failure (a bad plugin config, a missing runtime) becomes a dialog
/// plus a crash-log entry. A GUI must never die silently: the user's report
/// of "flashes then nothing" is exactly what this replaces.
fn fatal_error(msg: &str) {
    log_crash(&format!("FATAL: {}", msg));
    let _ = rfd::MessageDialog::new()
        .set_title("FreeAI4U Desktop")
        .set_level(rfd::MessageLevel::Error)
        .set_description(&format!(
            "FreeAI4U failed to start: {}\n\nA note was appended to:\n{}\n\nInclude it if you report this.",
            msg,
            crash_log_hint()
        ))
        .show();
}
