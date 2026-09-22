// Phase 5: desktop-native reach -- the capability that lets shell events reach
// the frontend at all, the Quick window on a global hotkey, and system
// notifications. The Rust is compiled only by the Desktop workflow, so what can
// be held here is the wiring and the security boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('the app windows may listen to shell events; the remote sign-in window may not', () => {
  const cap = JSON.parse(read('desktop', 'src-tauri', 'capabilities', 'default.json'));
  assert.deepEqual(cap.windows.slice().sort(), ['main', 'quick']);
  assert.ok(cap.permissions.includes('core:default'), 'core:default carries event listen');
  assert.ok(!cap.windows.includes('connect'), 'the GitHub window shows remote pages and gets nothing');
  assert.ok(!cap.remote, 'no remote origin is granted IPC');
});

test('the Quick window: a global hotkey, a small window, remappable', () => {
  const quick = read('desktop', 'src-tauri', 'src', 'quick.rs');
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  const cargo = read('desktop', 'src-tauri', 'Cargo.toml');
  assert.match(cargo, /tauri-plugin-global-shortcut = "2"/);
  assert.match(cargo, /tauri-plugin-notification = "2"/);
  assert.match(quick, /DEFAULT_HOTKEY: &str = "alt\+space"/);
  assert.match(quick, /WebviewWindowBuilder::new\(app, "quick"/);
  assert.match(quick, /\.always_on_top\(true\)/);
  assert.match(quick, /shortcuts\.unregister\(old\)/, 'a remap releases the old chord');
  assert.match(main, /\.plugin\(quick::plugin\(\)\)/);
  assert.match(main, /quick::register\(app\.handle\(\), quick::DEFAULT_HOTKEY\)/);
  for (const cmd of ['quick_hotkey_set', 'quick_hide', 'main_show', 'notify']) {
    assert.match(main, new RegExp(`quick::${cmd}`), `${cmd} is registered`);
  }
  const entry = read('desktop', 'src', 'main.tsx');
  assert.match(entry, /isQuickWindow\(\) \? <QuickAsk \/> : <App \/>/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /currentWindow\?\.label/, 'the window knows itself by its label');
});

test('a Quick answer continues in the main window as a real chat', () => {
  const quick = read('desktop', 'src', 'screens', 'QuickAsk.tsx');
  // Through the store's hand-off: saved, and left for the main window's copy
  // of the store to take in (the Quick window is its own webview).
  assert.match(quick, /chats\.handOff\(session\)/);
  assert.match(quick, /QUICK_HANDOFF_KEY/);
  assert.match(quick, /mainShow\(\)/);
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /addEventListener\('storage', onStorage\)/, 'the main window hears the hand-off');
  assert.match(app, /quickHotkeySet\(stored\)/, 'a remapped hotkey is re-taken at start');
});

test('notifications only when the window is not in front, for approvals and long replies', () => {
  const quick = read('desktop', 'src-tauri', 'src', 'quick.rs');
  assert.match(quick, /if in_front \{\s*return false;/);
  assert.match(quick, /request_user_attention/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /notifyUser\('NeuraOS needs your OK'/);
  assert.match(chat, /Date\.now\(\) - startedAt > 15000\) notifyUser\('Reply ready'/);
});

test('read aloud uses the voices Windows has, and can be stopped', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /new SpeechSynthesisUtterance\(/);
  assert.match(chat, /synth\.cancel\(\)/);
  assert.match(chat, /id: 'speak'/);
});
