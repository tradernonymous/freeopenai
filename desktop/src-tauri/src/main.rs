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
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

const CRASH_LOG: &str = "C:/Users/Public/freeai4u-crash.log";
const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

fn log_crash(msg: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(CRASH_LOG) {
        let _ = writeln!(f, "[{}] {}", chrono::Utc::now().to_rfc3339(), msg);
    }
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
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
                        std::process::exit(0);
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
                window.hide().unwrap();
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
            "FreeAI4U failed to start: {}\n\nA note was appended to C:/Users/Public/freeai4u-crash.log -- include it if you report this.",
            msg
        ))
        .show();
}
