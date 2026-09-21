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
// engine's confinement rules), diag.rs (the facts behind Copy diagnostics).
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

mod crash;
mod diag;
mod local;
mod models;
mod net;
mod save;
mod secrets;
mod webview2;
use tauri::generate_handler;
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

// Set only by the tray Quit: the close handler hides the window (tray-style),
// so it has to be able to tell a close from a quit.
static QUITTING: AtomicBool = AtomicBool::new(false);

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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A neuraos:// link in the second launch's argv is delivered by
            // the deep-link plugin (single-instance's `deep-link` feature).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(generate_handler![
            save::save_file_dialog,
            net::remote_get,
            net::remote_download,
            net::run_installer,
            net::open_url,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            diag::diagnostics,
            local::local_pick_folder,
            local::local_list_dir,
            local::local_read_file,
            local::local_write_file,
            local::local_edit_file,
            local::local_run,
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
            models::local_models_scan
        ])
        // neuraos:// links: "Use this model" on Hugging Face, once NeuraOS is
        // listed there, and the app's own bookmarklet until then. The URL is
        // handed to the frontend as an event; nothing is acted on here.
        .plugin(tauri_plugin_deep_link::init())
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
                        //
                        // A local model server is a child process of this app.
                        // Leaving one running after the window is gone would be
                        // a process the user cannot see and did not ask for.
                        models::shutdown();
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
