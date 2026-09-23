// The one version string. package.json, tauri.conf.json and Cargo.toml agree
// with it (the desktop wiring test asserts it), so the UI badge and the
// update check never drift from what CI actually built.
export const APP_VERSION = '2.11.0';
