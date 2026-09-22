// NeuraOS Desktop shell (Tauri 2) -- the desktop front end for the FreeAI4U
// engine. The crate, the binary and the bundle identifier keep their
// freeai4u-* names: they are what an existing install and the update path are
// keyed on, and a rename there would be a new app, not a new version.
//
// This file is wiring only: boot checks, the tray, the window, and which
// plugins and commands exist. Each concern with rules of its own lives next to
// it -- crash.rs (where a failure is recorded), webview2.rs (the runtime the
// window needs), save.rs (the native save dialog), net.rs (the network edge a
// webview cannot be), local.rs (the real filesystem and command runner, with the
// engine's confinement rules), diag.rs (the facts behind Copy diagnostics),
// mcp.rs (local MCP servers over stdio: the MCP host, docs/adr/0001).
//
// Release builds carry windows_subsystem="windows": a GUI app must never
// open a console window (the "black terminal flash" on launch).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use std::sync::atomic::{AtomicBool, Ordering};

mod chat_store;
mod crash;
mod diag;
mod gguf;
mod hf_oauth;
mod local;
mod mcp;
mod models;
mod net;
mod ollama;
mod launch;
mod quick;
mod selection;
mod save;
mod secrets;
mod webview2;
mod whisper;
use tauri::generate_handler;
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

// Set only by the tray Quit: the close handler hides the window (tray-style),
// so it has to be able to tell a close from a quit.
static QUITTING: AtomicBool = AtomicBool::new(false);

// NEURA-050: which machines may actually be asked for Mica.
//
// tauri.conf.json declares the material, so the window is built with it and a
// PC that can draw it needs no code at all. This is where that ask is taken
// back: Mica is DWM's Windows 11 system backdrop, and DWM draws no backdrop at
// all once Personalisation > Colours > Transparency effects is off. On those
// machines the shell keeps the flat background it has always had rather than a
// material that is only half there.
//
// The rule is deliberately pessimistic -- a Registry read that fails means no.
// A window that is flat when it could have been Mica is one nobody notices; a
// window that is translucent when the system will not draw the material behind
// it is unreadable chat.
mod mica {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    /// The first Windows 11 build. Below it the backdrop attribute does not
    /// exist, so asking for it is the same as asking for nothing.
    const WINDOWS_11_BUILD: u32 = 22000;

    /// The version rule by itself, so it can be checked without a Registry:
    /// the build number is stored as text, and something that is not a build
    /// number is not evidence of Windows 11.
    pub fn build_supports_mica(build: Option<&str>) -> bool {
        build
            .and_then(|b| b.trim().parse::<u32>().ok())
            .map(|b| b >= WINDOWS_11_BUILD)
            .unwrap_or(false)
    }

    /// Read the way webview2.rs reads its runtime version: the value Windows
    /// itself keeps, rather than parsing the output of a command.
    fn current_build() -> Option<String> {
        winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .ok()
            .and_then(|hk| hk.get_value::<String, _>("CurrentBuildNumber").ok())
    }

    /// Personalisation > Colours > Transparency effects. A missing value is
    /// the factory state, which is on -- the reading Windows itself makes.
    fn transparency_enabled() -> bool {
        winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            .ok()
            .and_then(|hk| hk.get_value::<u32, _>("EnableTransparency").ok())
            .map(|value| value != 0)
            .unwrap_or(true)
    }

    /// Whether this PC can draw the material tauri.conf.json asked for.
    pub fn supported() -> bool {
        build_supports_mica(current_build().as_deref()) && transparency_enabled()
    }
}

// NEURA-021: the page holds chat edits for 400 ms before they reach the chat
// store. The tray Quit emits "app-quitting", and the page flushes and calls
// quit_ready; the exit waits for that, or for QUIT_FLUSH_WAIT, whichever is
// first. The wait runs on its own thread: the event loop must stay free to
// deliver the event and answer the command.
const QUIT_FLUSH_WAIT: std::time::Duration = std::time::Duration::from_millis(800);

fn quit_ready_slot() -> &'static std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>> =
        std::sync::OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// The page has flushed its chats: the pending tray Quit may exit now.
#[tauri::command]
fn quit_ready() {
    let mut slot = match quit_ready_slot().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(tx) = slot.take() {
        let _ = tx.send(());
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        crash::log(&format!("PANIC: {}", info));
    }));

    // The runtime check runs before the app window exists. This is the belt
    // that turns "double-click, nothing happens" into an explanation.
    if webview2::version().is_none() {
        crash::log("WebView2 runtime not found at startup");
        // The dialog offers to open the download. Whether it was taken is
        // recorded either way, so the crash log answers "did they install it?"
        // without asking the user to remember.
        let opened = webview2::ask_to_install();
        crash::log(&format!("WebView2 install offered; download page opened: {}", opened));
        return;
    }

    tauri::Builder::default()
        // Registered first: a second launch must focus the window that exists
        // rather than build a second tray icon and a second app object.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A neuraos:// link in the second launch's argv is delivered by
            // the deep-link plugin (single-instance's `deep-link` feature).
            // A .gguf file or a folder ("Open with", Explorer's verb) is ours.
            if let Some(path) = launch::path_arg(&args) {
                launch::remember(path.clone());
                let _ = app.emit("open-path", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(generate_handler![
            save::save_file_dialog,
            net::remote_get,
            net::update_manifest,
            net::remote_download,
            net::run_installer,
            net::open_url,
            net::puter_signin_open,
            net::auth_window_open,
            ollama::ollama_tags,
            ollama::ollama_ps,
            ollama::ollama_eject,
            ollama::ollama_start,
            ollama::shell_chat_stream,
            ollama::shell_chat_cancel,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            chat_store::chat_store_list,
            chat_store::chat_store_put,
            chat_store::chat_store_delete,
            chat_store::chat_store_clear,
            chat_store::chat_store_key_get,
            chat_store::chat_store_key_set,
            chat_store::chat_store_set_aside,
            quit_ready,
            hf_oauth::hf_oauth_config,
            hf_oauth::hf_oauth_listen,
            hf_oauth::hf_oauth_cancel,
            hf_oauth::hf_oauth_exchange,
            hf_oauth::hf_oauth_refresh,
            diag::diagnostics,
            local::local_pick_folder,
            local::local_list_dir,
            local::local_read_file,
            local::local_write_file,
            local::local_edit_file,
            local::local_run,
            mcp::mcp_stdio_start,
            mcp::mcp_stdio_request,
            mcp::mcp_stdio_stop,
            mcp::mcp_stdio_list,
            models::local_server_find,
            models::local_server_pick,
            models::local_server_use,
            models::local_open_releases,
            models::local_model_start,
            models::local_model_status,
            models::local_model_stop,
            models::local_model_download,
            models::local_model_download_cancel,
            models::local_models_list,
            models::local_model_delete,
            models::local_models_scan,
            whisper::whisper_find,
            whisper::whisper_use,
            whisper::whisper_pick_binary,
            whisper::whisper_transcribe,
            gguf::gguf_info,
            quick::quick_hotkey_set,
            quick::quick_hide,
            quick::main_show,
            quick::notify,
            selection::quick_take_selection,
            selection::selection_hotkey_set,
            launch::launch_take_path
        ])
        // neuraos:// links: "Use this model" on Hugging Face, once NeuraOS is
        // listed there, and the app's own bookmarklet until then. The URL is
        // handed to the frontend as an event; nothing is acted on here.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        // Phase 5: the Quick window's global hotkey, and system notifications
        // (both driven from Rust, so the frontend needs no plugin permissions).
        .plugin(quick::plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        // Registered for the frontend's future use; today the app stores its
        // settings in localStorage. It must NOT be given a config map here:
        // this plugin version rejects one and the app panics at startup.
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // Now that Tauri knows its own directories, the crash log belongs
            // with the rest of the app's data.
            if let Ok(dir) = app.path().app_log_dir() {
                crash::set_path(dir.join(crash::CRASH_FILE));
            }
            // Deep links arrive as a list of URLs; the frontend decides what
            // a neuraos://model?repo=... means.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                let _ = handle.emit("deep-link", urls);
            });
            // A dev build is not installed, so the scheme is registered at
            // runtime; the installer registers it for a release.
            #[cfg(debug_assertions)]
            {
                let _ = app.deep_link().register_all();
            }

            // NEURA-050: the window was already built with the Mica material
            // tauri.conf.json declares. Where the system cannot draw it, clear
            // it again so the shell falls back to its own flat background
            // instead of an effect Windows will only half honour. Failing to
            // clear it is worth a line in the crash log and nothing more: the
            // window is drawn and usable either way.
            if !mica::supported() {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) =
                        window.set_effects(None::<tauri::utils::config::WindowEffectsConfig>)
                    {
                        crash::log(&format!("mica: could not clear the window effect: {}", e));
                    }
                }
            }

            // Opened with a model file or a folder: the page takes it on load.
            if let Some(path) = launch::path_arg(&std::env::args().collect::<Vec<String>>()) {
                launch::remember(path);
            }

            // The Quick window hotkey. The frontend re-sends a remapped one at
            // start; a chord another app owns is logged, not fatal.
            if let Err(e) = quick::register(app.handle(), quick::DEFAULT_HOTKEY) {
                crash::log(&format!("quick hotkey: {}", e));
            }
            if let Err(e) = quick::register_selection(app.handle(), selection::DEFAULT_HOTKEY) {
                crash::log(&format!("selection hotkey: {}", e));
            }

            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            // The ONE tray icon: tauri.conf.json must not declare `trayIcon`
            // as well, or Windows shows a second, dead icon beside this one.
            let mut tray = TrayIconBuilder::with_id("main").tooltip("NeuraOS");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let _tray = tray
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
                        //
                        // A local model server is a child process of this app.
                        // Leaving one running after the window is gone would be
                        // a process the user cannot see and did not ask for.
                        //
                        // A second Quit while the first is waiting is ignored.
                        if QUITTING.swap(true, Ordering::SeqCst) {
                            return;
                        }
                        models::shutdown();
                        // The same for local MCP servers (mcp.rs).
                        mcp::shutdown();
                        // Ask the page to flush its chats (NEURA-021), then
                        // exit when it says quit_ready or after the wait.
                        let (tx, rx) = std::sync::mpsc::channel::<()>();
                        {
                            let mut slot = match quit_ready_slot().lock() {
                                Ok(g) => g,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                            *slot = Some(tx);
                        }
                        let asked = app.emit("app-quitting", ()).is_ok();
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            if asked {
                                let _ = rx.recv_timeout(QUIT_FLUSH_WAIT);
                            }
                            handle.exit(0);
                        });
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
                // Only the main window lives in the tray. A sign-in window
                // that is closed is simply closed.
                if window.label() != "main" {
                    return;
                }
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
    crash::log(&format!("FATAL: {}", msg));
    let _ = rfd::MessageDialog::new()
        .set_title("NeuraOS Desktop")
        .set_level(rfd::MessageLevel::Error)
        .set_description(&format!(
            "NeuraOS failed to start: {}\n\nA note was appended to:\n{}\n\nInclude it if you report this.",
            msg,
            crash::hint()
        ))
        .show();
}

#[cfg(test)]
mod tests {
    use super::mica;

    // NEURA-050: the Windows 10 / Windows 11 line, and the fact that a
    // build number we cannot read is not a yes. The material is declared in
    // tauri.conf.json for every machine, so this predicate is the only thing
    // standing between a Windows 10 user and an effect their DWM will not
    // draw.
    #[test]
    fn mica_is_asked_for_on_windows_11_only() {
        assert!(!mica::build_supports_mica(Some("19045")), "Windows 10 22H2");
        assert!(!mica::build_supports_mica(Some("21390")), "an Insider build before 11");
        assert!(mica::build_supports_mica(Some("22000")), "the first Windows 11 build");
        assert!(mica::build_supports_mica(Some(" 26200 ")), "padded, as the Registry can return it");
    }

    #[test]
    fn an_unreadable_build_number_is_not_windows_11() {
        assert!(!mica::build_supports_mica(None));
        assert!(!mica::build_supports_mica(Some("")));
        assert!(!mica::build_supports_mica(Some("10.0.26200")));
        assert!(!mica::build_supports_mica(Some("-1")));
    }
}
