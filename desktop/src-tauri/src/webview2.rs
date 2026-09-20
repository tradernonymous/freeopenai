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
        "FreeAI4U needs the free Microsoft WebView2 runtime, which is missing on this PC.\n\n\
         Install it once from:\n{}\n\nThen start FreeAI4U again. (The installer version of \
         FreeAI4U installs it automatically.)",
        DOWNLOAD_URL
    )
}
