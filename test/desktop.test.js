// The Tauri desktop app (desktop/): the decisions CI can check without a Rust
// toolchain. The shell is Rust, but its configuration, the frontend's engine
// wiring and the packaging contract are all data -- and data can be tested
// here, so a wiring mistake (a route the engine does not have, a config the
// installer ignores) fails a test instead of shipping a blank window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.join(__dirname, '..', 'desktop');

function read(...parts) {
  return fs.readFileSync(path.join(DESKTOP, ...parts), 'utf8');
}

// The Rust shell is several modules (main.rs wires, crash.rs records failures,
// webview2.rs checks the runtime, save.rs writes files). A rule belongs to the
// shell, not to whichever file currently holds it, so the shell assertions read
// them together -- moving a concern between modules must not break a test.
const SHELL_MODULES = ['main.rs', 'crash.rs', 'webview2.rs', 'save.rs'];
function shellSource(...only) {
  const files = only.length ? only : SHELL_MODULES;
  return files.map((f) => read('src-tauri', 'src', f)).join('\n/* ---- module ---- */\n');
}

test('tauri.conf.json: the installer installs WebView2 (the blank-screen fix)', () => {
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  assert.equal(
    conf.bundle?.windows?.webviewInstallMode?.type,
    'downloadBootstrapper',
    'a machine without the WebView2 runtime gets it from the installer; without this the window opens blank and closes',
  );
});

test('tauri.conf.json: no updater plugin is configured (nothing signs updates)', () => {
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  assert.equal(conf.plugins?.updater, undefined, 'an unconfigured updater is a dead failure class');
});

test('tauri.conf.json: NSIS ships and the window settings are sane', () => {
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  assert.ok(conf.bundle.targets.includes('nsis'));
  assert.ok(conf.bundle.active);
  assert.equal(conf.productName, 'NeuraOS Desktop');
  assert.ok(conf.app.windows[0].width >= 1000, 'the chat needs room');
});

test('the shell checks the WebView2 runtime before opening a window', () => {
  const mainRs = shellSource('main.rs');
  const shell = shellSource();
  assert.match(shell, /F3017226-FE2A-4295-8BDF-00C3A9A7E4C5/, 'the runtime registry key');
  assert.match(shell, /HKEY_CURRENT_USER[\s\S]*HKEY_LOCAL_MACHINE|HKEY_LOCAL_MACHINE[\s\S]*HKEY_CURRENT_USER/, 'both hives');
  assert.match(shell, /go\.microsoft\.com/, 'the message names the fix');
  assert.match(mainRs, /webview2::version\(\)/, 'the check runs from main, before the window');
  assert.ok(!shell.includes('tauri_plugin_updater'), 'the updater plugin is gone from the shell too');
});

test('the UI version constant matches the built version (update check + badges)', () => {
  const pkg = JSON.parse(read('package.json'));
  const src = read('src', 'version.ts');
  const m = src.match(/APP_VERSION = '([0-9.]+)'/);
  assert.ok(m, 'version.ts exports APP_VERSION');
  assert.equal(m[1], pkg.version);
});

test('tauri.conf.json: only deep-link has a plugin config (the window-state startup panic)', () => {
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  // window-state and store reject config maps -- `{}` under their key panics
  // every launch. deep-link is the one plugin that MUST be configured here:
  // the scheme list is what the installer registers.
  assert.deepEqual(Object.keys(conf.plugins || {}), ['deep-link'],
    'window-state/store reject config maps; only deep-link may be configured');
  assert.deepEqual(conf.plugins['deep-link'], { desktop: { schemes: ['neuraos'] } });
});

test('the shell: release is windowed (no console flash) and never expect()s at boot', () => {
  assert.match(shellSource('main.rs'), /windows_subsystem\s*=\s*"windows"/,
    'the release exe must not open a console window');
  assert.ok(!/\.expect\(/.test(shellSource()),
    'a boot failure must become a dialog + crash log, never a silent death');
});

test('versions agree across package.json, tauri.conf.json and Cargo.toml', () => {
  const pkg = JSON.parse(read('package.json'));
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  const cargo = read('src-tauri', 'Cargo.toml');
  assert.equal(pkg.version, conf.version);
  assert.match(cargo, new RegExp('^version\\s*=\\s*"' + pkg.version + '"', 'm'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version, 'the lockfile carries the same version');
});

test('the old Node SEA launcher is gone, root and branch', () => {
  assert.equal(fs.existsSync(path.join(DESKTOP, 'freeai4u-desktop.js')), false);
  assert.equal(fs.existsSync(path.join(DESKTOP, 'sea-config.json')), false);
  assert.equal(fs.existsSync(path.join(DESKTOP, 'tools', 'set-gui-subsystem.js')), false);
  const gitignore = fs.readFileSync(path.join(DESKTOP, '..', '.gitignore'), 'utf8');
  assert.ok(!gitignore.includes('sea-prep.blob'), 'the SEA build artifacts left .gitignore too');
  const workflow = fs.readFileSync(path.join(DESKTOP, '..', '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.ok(!workflow.includes('set-gui-subsystem'), 'CI no longer patches a node.exe copy');
});

// ---- the engine wiring: every fetch the frontend can make must be a route
// the server actually serves ----------------------------------------------

function apiRoutesOf(source) {
  const routes = new Set();
  const request = /request\((['"`])([^'"`]+)\1/g;
  let m;
  while ((m = request.exec(source))) {
    const template = m[2];
    // request('/api/...') or request(`/api/build/sessions/${...}/input`)
    const literal = template.match(/\/api\/[a-z0-9\-/]*(?:\?.*)?/i);
    if (literal) routes.add(literal[0].replace(/\/$/, ''));
  }
  return routes;
}

test('every engine route the desktop calls exists on the server', () => {
  const api = read('src', 'api.ts');
  const called = [...apiRoutesOf(api)];
  assert.ok(called.length >= 25, 'the client covers the engine surface, found ' + called.length);
  const server = fs.readFileSync(path.join(DESKTOP, '..', 'server.js'), 'utf8');
  for (const route of called) {
    const bare = route.split('?')[0];
    assert.ok(
      server.includes(`'${bare}'`) || server.includes(`"${bare}"`),
      `desktop calls ${bare} but server.js never routes it`,
    );
  }
});

test('the stream client targets the provider-scoped chat route with SSE', () => {
  const api = read('src', 'api.ts');
  assert.match(api, /\/api\/llm\/chat\?provider=/, 'chat is per provider on this engine');
  assert.match(api, /stream: true/);
  assert.match(api, /\[DONE\]/, 'the relay ends with the DONE sentinel');
  assert.match(api, /text\/event-stream/, 'a non-streamed reply is still handled');
});

test('builds go through the session store with approvals, not chat', () => {
  const api = read('src', 'api.ts');
  assert.match(api, /\/api\/build\/sessions/, 'the store');
  assert.match(api, /\/input/, 'approve/reject/answers');
  assert.match(api, /\/cancel/, 'stop a build');
  assert.match(api, /\/events/, 'the live SSE stream');
  const chat = read('src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /buildRun\(\{ plan/, 'Build mode starts a real build session');
  assert.ok(!/mode:\s*['"]build['"]\s*,?\s*\n\s*\}\)/.test(chat), 'chat bodies carry no invented mode field');
});

test('the server URL is a setting with the https-except-localhost rule', () => {
  const api = read('src', 'api.ts');
  assert.match(api, /freeai4u\.server/, 'persisted under a stable key');
  assert.match(api, /normalizeServer/, 'one rule, applied on save and on load');
  assert.match(api, /DEFAULT_SERVER/, 'the default engine ships in the file, not in a config the user must find');
});

test('normalizeServer (shared logic, mirrored from the client): https anywhere, http only local', () => {
  // The rule is small enough to pin here; the TS file is the source of truth.
  function normalizeServer(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch { return null; }
    if (url.username || url.password) return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && local) return url.origin;
    return null;
  }
  assert.equal(normalizeServer('https://freeopenai-production.up.railway.app/'), 'https://freeopenai-production.up.railway.app');
  assert.equal(normalizeServer('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeServer('http://example.com'), null, 'plain http off-machine would leak the login');
  assert.equal(normalizeServer('https://user:pw@example.com'), null);
  assert.equal(normalizeServer('not a url'), null);
});

test('markdown rendering escapes before it decorates', () => {
  const md = read('src', 'markdown.ts');
  assert.match(md, /escapeHtml/, 'every renderer path starts from escaped text');
  assert.match(md, /&lt;/, 'the escape table covers angle brackets');
  assert.match(md, /dangerouslySetInnerHTML|renderMarkdown/, 'the chat screen consumes the renderer');
});

test('chat sessions persist locally through the store, with the stable key', () => {
  const store = read('src', 'chats.js');
  assert.match(store, /freeai4u\.chats/, 'History, import and export all read this one key');
  const chat = read('src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /chats\.(readStore|writeStore)/, 'the screen uses the store, not its own copy');
  assert.match(chat, /draft/, 'an unsent draft survives a restart');
  assert.match(chat, /AbortController/, 'Stop actually stops the stream');
});

test('the frontend still builds (tsc + vite), so CI compiles what it ships', () => {
  // CI runs `npm run build` in desktop/ before packaging; here we only assert
  // the script chain exists so a renamed script fails loudly.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.build, 'tsc && vite build');
  assert.equal(pkg.scripts['tauri:build'], 'tauri build');
});

// ---- Phase 0 hardening: one test per fixed defect ------------------------

test('the crash log lives in the app directory, is capped, and is named in the dialog', () => {
  const shell = shellSource();
  assert.ok(!shell.includes('C:/Users/Public'),
    'a public, not-always-writable path defeats the "no silent deaths" promise');
  assert.match(shell, /LOCALAPPDATA|app_log_dir/, 'it follows the user profile (or Tauri app dir)');
  assert.match(shell, /CRASH_LOG_MAX_BYTES/, 'a crash loop must not fill the disk');
  assert.match(shell, /log rotated|create_dir_all/, 'rotation + a created directory');
  assert.match(shellSource('main.rs'), /crash::hint\(\)/, 'the error dialog points at the real file');
});

test('quitting is a clean exit, and only quitting closes the window', () => {
  const main = shellSource('main.rs');
  assert.ok(!main.includes('std::process::exit'),
    'process::exit skips window-state persistence and orphans WebView2 children');
  assert.match(main, /QUITTING\.store/, 'the quit path raises the flag');
  assert.match(main, /app\.exit\(0\)/, 'and exits through Tauri');
  assert.match(main, /QUITTING\.load[\s\S]{0,200}prevent_close/,
    'the close handler still hides (tray-style) unless the app is quitting');
});

test('the save dialog derives its filters from the file, and always offers all files', () => {
  const save = shellSource('save.rs');
  assert.match(save, /fn extension_for/, 'the extension comes from the name/mime');
  assert.match(save, /extension_for\(&file_name, &mime\)/, 'and is actually used');
  assert.match(save, /add_filter\("All files"/, 'a wrong guess cannot make a file unsaveable');
  assert.doesNotMatch(save, /let _ = mime;/, 'mime is no longer discarded');
});

test('terminal results are matched by identity, and the output shown is the real one', () => {
  const term = read('src', 'components', 'Terminal.tsx');
  assert.match(term, /h\.id === id/, 'a result lands on the entry that asked for it');
  assert.doesNotMatch(term, /h\.cmd === cmd/, 'the by-value match is gone');
  assert.doesNotMatch(term, /res\.output/, 'the engine never sends `output`');
  assert.match(term, /runResult\.formatRun\(/, 'the response is formatted by the module');
  assert.doesNotMatch(term, /useState\('\.'\)/, 'the decorative cwd is gone');

  // The formatting rules themselves live in run-result.js and are tested below.
  const formatter = read('src', 'run-result.js');
  assert.match(formatter, /stdout/, 'stdout reaches the screen');
  assert.match(formatter, /stderr/, 'so does stderr');
  assert.match(formatter, /exitCode/, 'and the exit code');
});

// ---- the terminal's formatter (run-result.js) ----------------------------

test('a run response becomes the block the terminal shows', () => {
  const runResult = require('../desktop/src/run-result.js');
  const ok = runResult.formatRun({ stdout: 'hello\n', stderr: '', exitCode: 0, durationMs: 12 });
  assert.equal(ok.kind, 'out');
  assert.match(ok.out, /hello/);
  assert.match(ok.out, /12ms/);

  const failed = runResult.formatRun({ stdout: 'partial', stderr: 'boom\n', exitCode: 2 });
  assert.equal(failed.kind, 'err', 'a non-zero exit is an error line');
  assert.match(failed.out, /boom/);
  assert.match(failed.out, /exit 2/);

  const silent = runResult.formatRun({ stdout: '', stderr: '', exitCode: 0 });
  assert.equal(silent.out, 'ok', 'a command that printed nothing says so');

  const timedOut = runResult.formatRun({ stdout: '', stderr: '', exitCode: null, timedOut: true });
  assert.match(timedOut.out, /timed out/);
  const truncated = runResult.formatRun({ stdout: 'x', exitCode: 0, stdoutTruncated: true });
  assert.match(truncated.out, /truncated/);
});

test('provider and model fallbacks are persisted, not just shown', () => {
  const chat = read('src', 'screens', 'ChatScreen.tsx');
  const providerEffect = chat.slice(chat.indexOf('// ---- load engine catalogue'));
  assert.match(providerEffect, /saveSessions\(next\)/,
    'a fallback the user never sees again must survive a restart');
  assert.match(providerEffect, /provider: chat\[0\]\?\.id \|\| ''/, 'the fallback itself is unchanged');
  assert.match(chat, /startBuild[\s\S]{0,400}setAttached\(''\)/, 'a build consumes the staged attachment');
});
