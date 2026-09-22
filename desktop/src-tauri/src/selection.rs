// The selection toolbar (roadmap 5.8): select text in any app, press the
// selection hotkey, and the Quick window opens with that text and Explain /
// Translate / Summarise / Rewrite ready.
//
// Windows UI Automation would read a selection without touching the
// clipboard, but it needs the `windows` crate and per-app patterns. This does
// what every "ask about selection" tool on Windows ends up doing: release the
// hotkey's modifiers, send Ctrl+C to the app in front, wait for the clipboard
// sequence number to move, and read CF_UNICODETEXT -- a handful of user32 and
// kernel32 calls, no new dependency. The copied text stays on the clipboard;
// nothing is sent anywhere until the person picks an action.
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

pub const DEFAULT_HOTKEY: &str = "alt+shift+space";

/// The text the last hotkey press captured, until the Quick window takes it.
static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// Longest selection handed to the Quick window, in UTF-16 units.
const MAX_UNITS: usize = 60_000;

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
        fn OpenClipboard(owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
        fn GetClipboardSequenceNumber() -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(mem: *mut c_void) -> i32;
    }

    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const CF_UNICODETEXT: u32 = 13;
    const VK_SHIFT: u8 = 0x10;
    const VK_CONTROL: u8 = 0x11;
    const VK_MENU: u8 = 0x12;
    const VK_SPACE: u8 = 0x20;
    const VK_LWIN: u8 = 0x5B;
    const VK_C: u8 = 0x43;

    pub fn sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    /// Ctrl+C to whatever has focus, after letting go of the hotkey's keys
    /// (Alt still held would make it Ctrl+Alt+C).
    pub fn send_copy() {
        unsafe {
            for vk in [VK_MENU, VK_SHIFT, VK_SPACE, VK_LWIN] {
                keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
            }
            keybd_event(VK_CONTROL, 0, 0, 0);
            keybd_event(VK_C, 0, 0, 0);
            keybd_event(VK_C, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
        }
    }

    pub fn read_text(max_units: usize) -> Option<String> {
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return None;
            }
            let mut out = None;
            let handle = GetClipboardData(CF_UNICODETEXT);
            if !handle.is_null() {
                let ptr = GlobalLock(handle) as *const u16;
                if !ptr.is_null() {
                    let mut len = 0usize;
                    while len < max_units && *ptr.add(len) != 0 {
                        len += 1;
                    }
                    out = Some(String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len)));
                    GlobalUnlock(handle);
                }
            }
            CloseClipboard();
            out
        }
    }
}

#[cfg(windows)]
fn copy_selection() -> Option<String> {
    let before = win::sequence();
    win::send_copy();
    // Most apps answer Ctrl+C within a few frames; slow ones get ~0.6 s.
    for _ in 0..30 {
        thread::sleep(Duration::from_millis(20));
        if win::sequence() != before {
            // One more beat: some apps set several formats in turn.
            thread::sleep(Duration::from_millis(30));
            return win::read_text(MAX_UNITS).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        }
    }
    None
}

#[cfg(not(windows))]
fn copy_selection() -> Option<String> {
    None
}

/// The hotkey was pressed: grab the selection off the UI thread, then open the
/// Quick window, which asks for the text with `quick_take_selection`.
pub fn capture(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let text = copy_selection();
        if let Ok(mut slot) = PENDING.lock() {
            *slot = Some(text.unwrap_or_default());
        }
        crate::quick::open(&app);
        // A Quick window that is already open hears it at once.
        let _ = app.emit_to("quick", "quick-selection", ());
    });
}

/// The captured selection, once: Some("") means the hotkey fired but nothing
/// was selected (or the app refused Ctrl+C); None means no hotkey press.
#[tauri::command]
pub fn quick_take_selection() -> Option<String> {
    PENDING.lock().ok().and_then(|mut slot| slot.take())
}

#[tauri::command]
pub fn selection_hotkey_set(app: AppHandle, combo: String) -> Result<String, String> {
    crate::quick::register_selection(&app, &combo)
}
