// The WebView2 runtime: the window cannot be drawn without it.
//
// This is the belt that turns "double-click, nothing happens" into an
// explanation. It runs before the app window exists, which is why it lives on
// its own and touches nothing else.
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

pub const DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/?LinkId=2124703";

/// Reads the Registry for the runtime the same way the loader does: HKCU first
/// (per-user installs), then HKLM (machine-wide), both the WOW64 view and the
/// native one. `pv` is the runtime version; any value counts.
pub fn version() -> Option<String> {
    let keys = [
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    let hives = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];
    for hive in hives {
        for key in keys {
            if let Ok(hk) = winreg::RegKey::predef(hive).open_subkey(key) {
                if let Ok(found) = hk.get_value::<String, _>("pv") {
                    if !found.trim().is_empty() {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

/// What the user should do about it.
pub fn install_message() -> String {
    format!(
        "NeuraOS needs the free Microsoft WebView2 runtime, which is missing on this PC.\n\n\
         Install it once from:\n{}\n\nThen start NeuraOS again. (The installer version of \
         NeuraOS installs it automatically.)",
        DOWNLOAD_URL
    )
}

/// Opens the download page in the user's own browser, and answers whether a
/// browser was launched. Spawned with CREATE_NO_WINDOW: this code runs on a
/// machine where the app could not start, and a console flashing over the
/// dialog would be the worst last impression the app could make.
pub fn open_download_page() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        return std::process::Command::new("cmd")
            .args(["/C", "start", "", DOWNLOAD_URL])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// The one thing the user can do about a missing runtime, offered where they
/// are already looking. A branded in-app window is the one thing that cannot
/// be built here: drawing a window means loading the very runtime that is
/// missing. A dialog whose button opens the download is the honest version of
/// that idea, and it is one click instead of a URL to copy out of a message.
pub fn ask_to_install() -> bool {
    const OPEN: &str = "Open the download page";
    let answer = rfd::MessageDialog::new()
        .set_title("NeuraOS Desktop")
        .set_level(rfd::MessageLevel::Warning)
        .set_description(format!("{}\n\nOpen the download page now?", install_message()))
        .set_buttons(rfd::MessageButtons::OkCancelCustom(OPEN.to_string(), "Not now".to_string()))
        .show();
    match answer {
        rfd::MessageDialogResult::Custom(label) => label == OPEN && open_download_page(),
        rfd::MessageDialogResult::Ok => open_download_page(),
        _ => false,
    }
}
