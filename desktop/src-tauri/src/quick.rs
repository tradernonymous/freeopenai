// Desktop-native reach (roadmap Phase 5): a global hotkey that opens a small
// always-on-top Quick window from anywhere, and OS notifications when a long
// reply finishes or a tool waits for approval while the window is not in front.
//
// The Quick window loads the same frontend; it knows it is the Quick window by
// its label ("quick"), so there is no second app to keep in step. It gets the
// same capability as the main window (capabilities/default.json) and nothing
// the remote sign-in window has.
use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, UserAttentionType, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// ChatGPT's desktop app uses the same chord; it is remappable in Settings.
pub const DEFAULT_HOTKEY: &str = "alt+space";

static CURRENT: Mutex<Option<Shortcut>> = Mutex::new(None);
/// The selection hotkey (selection.rs): same plugin, different action.
static SELECTION: Mutex<Option<Shortcut>> = Mutex::new(None);

/// The global-shortcut plugin, with the one handler this app needs.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let is_selection = SELECTION.lock().ok().map(|s| *s == Some(*shortcut)).unwrap_or(false);
            if is_selection {
                crate::selection::capture(app);
            } else {
                toggle(app);
            }
        })
        .build()
}

/// Take `combo` as the Quick hotkey, releasing the previous one. A chord
/// another app already owns is an error the Settings card can show.
pub fn register(app: &AppHandle, combo: &str) -> Result<String, String> {
    let shortcut = Shortcut::from_str(combo.trim()).map_err(|e| format!("\"{}\" is not a shortcut: {}", combo, e))?;
    let shortcuts = app.global_shortcut();
    let mut current = CURRENT.lock().map_err(|_| "the hotkey is being changed".to_string())?;
    if let Some(old) = current.take() {
        let _ = shortcuts.unregister(old);
    }
    shortcuts
        .register(shortcut)
        .map_err(|e| format!("could not take {} (another app may own it): {}", combo, e))?;
    *current = Some(shortcut);
    Ok(combo.trim().to_string())
}

/// Take `combo` as the selection hotkey, the same way as the Quick one.
pub fn register_selection(app: &AppHandle, combo: &str) -> Result<String, String> {
    let shortcut = Shortcut::from_str(combo.trim()).map_err(|e| format!("\"{}\" is not a shortcut: {}", combo, e))?;
    if CURRENT.lock().ok().map(|c| *c == Some(shortcut)).unwrap_or(false) {
        return Err(format!("{} is already the Quick window hotkey", combo));
    }
    let shortcuts = app.global_shortcut();
    let mut current = SELECTION.lock().map_err(|_| "the hotkey is being changed".to_string())?;
    if let Some(old) = current.take() {
        let _ = shortcuts.unregister(old);
    }
    shortcuts
        .register(shortcut)
        .map_err(|e| format!("could not take {} (another app may own it): {}", combo, e))?;
    *current = Some(shortcut);
    Ok(combo.trim().to_string())
}

fn toggle(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quick") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }
    open(app);
}

/// Show the Quick window (building it the first time) and give it focus.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quick") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("index.html".into()))
        .title("NeuraOS Quick")
        .inner_size(680.0, 460.0)
        .min_inner_size(420.0, 260.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build();
    if let Err(e) = built {
        crate::crash::log(&format!("quick window: {}", e));
    }
}

#[tauri::command]
pub fn quick_hotkey_set(app: AppHandle, combo: String) -> Result<String, String> {
    register(&app, &combo)
}

#[tauri::command]
pub fn quick_hide(app: AppHandle) {
    if let Some(window) = app.get_webview_window("quick") {
        let _ = window.hide();
    }
}

/// Bring the main window forward ("Continue in the main window").
#[tauri::command]
pub fn main_show(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// A system notification -- only when the main window is not what the person
/// is looking at; otherwise the in-app toast is enough. The taskbar button
/// flashes as well, so a hidden-to-tray window is still findable.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> bool {
    let window = app.get_webview_window("main");
    let in_front = window
        .as_ref()
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false);
    if in_front {
        return false;
    }
    if let Some(w) = window.as_ref() {
        let _ = w.request_user_attention(Some(UserAttentionType::Informational));
    }
    let title: String = title.chars().take(80).collect();
    let body: String = body.chars().take(240).collect();
    app.notification().builder().title(title).body(body).show().is_ok()
}
