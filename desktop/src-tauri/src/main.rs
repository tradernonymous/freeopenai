// FreeAI4U Desktop shell (Tauri 2).
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
mod webview2;
use tauri::generate_handler;

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
        let _ = rfd::MessageDialog::new()
            .set_title("FreeAI4U Desktop")
            .set_level(rfd::MessageLevel::Warning)
            .set_description(&webview2::install_message())
            .show();
        return;
    }

    tauri::Builder::default()
        // Registered first: a second launch must focus the window that exists
        // rather than build a second tray icon and a second app object.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
            models::local_model_stop
        ])
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
        .set_title("FreeAI4U Desktop")
        .set_level(rfd::MessageLevel::Error)
        .set_description(&format!(
            "FreeAI4U failed to start: {}\n\nA note was appended to:\n{}\n\nInclude it if you report this.",
            msg,
            crash::hint()
        ))
        .show();
}
