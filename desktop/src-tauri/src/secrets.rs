// Secrets in the operating system's credential store, not in localStorage.
//
// The Hugging Face token used to sit in localStorage as plain text, where a
// webview XSS or a copied profile folder reads it. The OS already has a place
// for this -- Credential Manager on Windows, the Keychain on macOS, the kernel
// keyring on Linux -- and the `keyring` crate is the one door to all three.
//
// Three rules:
//
//   * one service name, so every secret this app stores can be found (and
//     removed) under it, and never collides with another program's;
//   * a missing secret is `None`, not an error: "not signed in" is a normal
//     state, and the frontend should not have to parse error strings to
//     learn it;
//   * keys are short identifiers chosen by this app (`hf_token`), never
//     user-supplied strings, so a page cannot ask for another entry.
use keyring::Entry;

pub const SERVICE: &str = "NeuraOS Desktop";

/// The keys this app may store. A name outside this list is refused, which
/// keeps the store from becoming a general-purpose one.
pub const KEYS: &[&str] = &["hf_token", "hf_user"];

fn entry(key: &str) -> Result<Entry, String> {
    if !KEYS.contains(&key) {
        return Err(format!("{} is not a secret this app stores", key));
    }
    Entry::new(SERVICE, key).map_err(|e| format!("credential store: {}", e))
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("credential store: {}", e)),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return secret_delete(key);
    }
    entry(&key)?
        .set_password(&value)
        .map_err(|e| format!("credential store: {}", e))
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("credential store: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_keys_are_accepted() {
        assert!(entry("hf_token").is_ok());
        assert!(entry("not_a_key").is_err());
        assert!(entry("../other").is_err());
    }

    #[test]
    fn the_service_name_is_the_products() {
        assert!(SERVICE.contains("NeuraOS"));
    }
}
