// Desktop backlog fixes NEURA-021..024 and 026.
//
//   021  chat edits inside the 400 ms debounce survive a quit: flush() sends
//        them at once, pagehide/beforeunload call it, and the tray Quit waits
//        for the page (app-quitting -> flush -> quit_ready) before exiting;
//   022  a chat key that cannot open the stored chats is a clear, one-time
//        choice (start fresh keeping the old file, or stay on browser storage),
//        never a new key made over them and never a deleted file;
//   024  disabled buttons are >= 3:1 in both themes and still look disabled;
//   026  no doc points at the old src/keymap.js.
// (023, the Docker script-file mode, is in desktop-phase12-code.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chats = require('../desktop/src/chats.js');
const cc = require('../desktop/src/chat-crypto.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

const session = (id, updatedAt, extra = {}) => ({
  id,
  title: 'chat ' + id,
  messages: [{ role: 'user', content: 'hello ' + id }],
  updatedAt,
  ...extra,
});

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function fakeBackend(initial = []) {
  const rows = new Map(initial.map((s) => [s.id, clone(s)]));
  const log = { put: [], remove: [] };
  return {
    rows,
    log,
    async list() { return [...rows.values()].map(clone); },
    async put(sessions) { log.put.push(sessions.map((s) => s.id)); sessions.forEach((s) => rows.set(s.id, clone(s))); },
    async remove(ids) { log.remove.push(ids.slice()); ids.forEach((id) => rows.delete(id)); },
  };
}

function unreadableError(reason = 'missing', rows = 3) {
  const e = new Error('the chat key is missing from the credential store');
  e.code = chats.UNREADABLE;
  e.reason = reason;
  e.rows = rows;
  return e;
}

test.beforeEach(() => chats.detach());
test.afterEach(() => chats.detach());

// ---- NEURA-021 ---------------------------------------------------------------

test('NEURA-021: flush() writes the rows the debounce is holding, at once', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend([session('a', 1)]);
  await chats.hydrate(backend, { storage, delay: 60_000 });
  chats.writeStore(null, [session('b', 2), ...chats.readStore()]);
  chats.writeStore(null, chats.readStore().map((s) => (s.id === 'a' ? { ...s, title: 'edited', updatedAt: 3 } : s)));
  assert.equal(backend.log.put.length, 0, 'held by the 60 s debounce');
  assert.equal(await chats.flush(), true);
  assert.deepEqual(backend.log.put.map((ids) => ids.slice().sort()), [['a', 'b']]);
  assert.equal(backend.rows.get('a').title, 'edited');
  // The debounce timer went with it: nothing is sent twice.
  assert.equal(await chats.flush(), true);
  assert.equal(backend.log.put.length, 1);
});

test('NEURA-021: pagehide and beforeunload flush; detach stops listening', async () => {
  const handlers = {};
  const removed = [];
  globalThis.addEventListener = (type, fn) => { handlers[type] = fn; };
  globalThis.removeEventListener = (type) => { removed.push(type); };
  try {
    const backend = fakeBackend([]);
    await chats.hydrate(backend, { storage: memoryStorage(), delay: 60_000 });
    assert.equal(typeof handlers.pagehide, 'function');
    assert.equal(typeof handlers.beforeunload, 'function');
    chats.writeStore(null, [session('late', 5)]);
    handlers.pagehide();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(backend.rows.has('late'), 'the page going away sent the pending edit');
    chats.writeStore(null, [session('later', 6), ...chats.readStore()]);
    handlers.beforeunload();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(backend.rows.has('later'));
    chats.detach();
    assert.ok(removed.includes('pagehide') && removed.includes('beforeunload'));
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});

test('NEURA-021: the tray Quit asks the page to flush and waits for quit_ready (source wiring)', () => {
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  const quitArm = main.slice(main.indexOf('"quit" => {'), main.indexOf('"show" => {'));
  assert.ok(quitArm.length > 0, 'the tray Quit arm exists');
  assert.match(quitArm, /QUITTING\.swap\(true, Ordering::SeqCst\)/, 'a second Quit is ignored');
  assert.match(quitArm, /app\.emit\("app-quitting", \(\)\)/);
  assert.match(quitArm, /std::thread::spawn\(move \|\|/, 'the wait is off the event loop');
  assert.match(quitArm, /rx\.recv_timeout\(QUIT_FLUSH_WAIT\)[\s\S]*handle\.exit\(0\)/, 'exit after the page answers or the wait ends');
  assert.doesNotMatch(quitArm, /^\s*app\.exit\(0\);/m, 'no immediate exit left');
  assert.match(main, /const QUIT_FLUSH_WAIT: std::time::Duration = std::time::Duration::from_millis\(800\);/);
  assert.match(main, /#\[tauri::command\]\s*fn quit_ready\(\)/);
  assert.match(main, /tx\.send\(\(\)\)/);
  assert.match(main, /^\s*quit_ready,$/m, 'registered with the invoke handler');

  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /subscribe<unknown>\('app-quitting'/);
  assert.match(bridge, /call\('quit_ready'\)/);
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /onAppQuitting\(\(\) => \{\s*chats\.flush\(\)[\s\S]{0,80}?quitReady\(\)/);
});

// ---- NEURA-022 ---------------------------------------------------------------

test('NEURA-022: recoveryFor offers the two actions only for an unreadable store', () => {
  assert.equal(chats.recoveryFor(null), null);
  assert.equal(chats.recoveryFor(new Error('credential store: locked')), null, 'other failures keep the plain notice');
  const plan = chats.recoveryFor(unreadableError('missing', 12));
  assert.equal(plan.reason, 'missing');
  assert.equal(plan.rows, 12);
  assert.match(plan.text, /missing from the system credential store/);
  assert.match(plan.text, /12 saved chats/);
  assert.match(plan.text, /Nothing has been deleted/);
  assert.match(plan.text, /chats\.unreadable-<time>\.sqlite3/);
  assert.deepEqual(plan.actions, [
    { id: 'start-fresh', label: 'Start fresh (keep the old file)' },
    { id: 'keep-local', label: 'Keep using browser storage for now' },
  ]);
  assert.match(chats.recoveryFor(unreadableError('wrong-key', 1)).text, /does not open your saved chats \(1 saved chat\)/);
  assert.equal(cc.UNREADABLE, chats.UNREADABLE, 'chat-crypto and chats agree on the code');
});

test('NEURA-022: openBackend never makes a key over chats it cannot open', async () => {
  const sealed = [{ id: 'a', updated_at: 1, blob: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' }];
  const call = (rows) => async (command) => {
    if (command === 'chat_store_list') return rows;
    throw new Error('unexpected ' + command);
  };
  const vault = (initial) => {
    const v = { value: initial, sets: 0 };
    return { v, store: { get: async () => v.value, set: async (x) => { v.sets += 1; v.value = x; } } };
  };

  // Missing key, rows present: refuse, keep everything.
  const missing = vault(null);
  await assert.rejects(cc.openBackend({ call: call(sealed), store: missing.store }), (e) => {
    assert.equal(e.code, cc.UNREADABLE);
    assert.equal(e.reason, 'missing');
    assert.equal(e.rows, 1);
    return true;
  });
  assert.equal(missing.v.sets, 0, 'no new key was stored');

  // Not a 256-bit key, rows present: refuse, the old value is left alone.
  const short = cc.toBase64(new Uint8Array(16));
  const unusable = vault(short);
  await assert.rejects(cc.openBackend({ call: call(sealed), store: unusable.store }), (e) => e.code === cc.UNREADABLE && e.reason === 'unusable');
  assert.equal(unusable.v.value, short);

  // First run (no key, no rows), and an unusable key over an empty file: a key is made.
  const fresh = vault(null);
  const b1 = await cc.openBackend({ call: call([]), store: fresh.store });
  assert.equal(typeof b1.list, 'function');
  assert.equal(cc.fromBase64(fresh.v.value).length, 32);
  const replaced = vault(short);
  await cc.openBackend({ call: call([]), store: replaced.store });
  assert.equal(cc.fromBase64(replaced.v.value).length, 32);

  // A real key that opens none of the rows: list() says so with the same code.
  const wrong = vault(await cc.exportKey(await cc.generateKey()));
  const other = await cc.generateKey();
  const rows = [{ id: 'x', updated_at: 1, blob: await cc.encrypt(other, JSON.stringify(session('x', 1))) }];
  const b2 = await cc.openBackend({ call: call(rows), store: wrong.store });
  await assert.rejects(b2.list(), (e) => e.code === cc.UNREADABLE && e.reason === 'wrong-key');
});

test('NEURA-022: an unreadable store asks once and leaves localStorage as it was', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('local', 4)]);
  const before = storage.getItem(chats.STORE_KEY);
  const plans = [];
  const notices = [];
  const failing = async () => { throw unreadableError('missing', 3); };
  const result = await chats.hydrate(failing, { storage, onRecovery: (p) => plans.push(p), onNotice: (t) => notices.push(t) });
  assert.equal(result.mode, 'local');
  assert.equal(result.recovery, true);
  assert.equal(plans.length, 1);
  assert.equal(notices.length, 0, 'the recovery notice replaces the plain one');
  assert.deepEqual(chats.recovery(), plans[0]);
  assert.equal(storage.getItem(chats.STORE_KEY), before);
  await chats.hydrate(failing, { storage });
  assert.equal(plans.length, 1, 'one notice, not one per attempt');
});

test('NEURA-022: "keep browser storage" changes nothing; "start fresh" sets aside, then moves the chats over', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('meanwhile', 9)]);
  await chats.hydrate(async () => { throw unreadableError(); }, { storage, delay: 0 });

  // Keep local: nothing is renamed.
  let asides = 0;
  const kept = await chats.recover('keep-local', { setAside: async () => { asides += 1; return 'x'; }, backend: fakeBackend([]) });
  assert.deepEqual(kept, { mode: 'local', migrated: 0, choice: 'keep-local', done: true });
  assert.equal(asides, 0);
  assert.equal(chats.recovery(), null);
  assert.equal(chats.persistent(), false);

  // A later launch asks again; this time start fresh.
  chats.detach();
  await chats.hydrate(async () => { throw unreadableError(); }, { storage, delay: 0 });
  const order = [];
  const fresh = fakeBackend([]);
  const result = await chats.recover('start-fresh', {
    setAside: async () => { order.push('set-aside'); return 'chats.unreadable-1700000000.sqlite3'; },
    backend: async () => { order.push('backend'); return fresh; },
  });
  assert.deepEqual(order, ['set-aside', 'backend'], 'the old file is out of the way before a new key or store exists');
  assert.equal(result.mode, 'shell');
  assert.equal(result.migrated, 1);
  assert.equal(result.movedTo, 'chats.unreadable-1700000000.sqlite3');
  assert.ok(fresh.rows.has('meanwhile'), 'chats written to browser storage moved into the new store');
  assert.equal(chats.recovery(), null);
});

test('NEURA-022: a set-aside that fails keeps the notice and the history where they were', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('keep', 2)]);
  await chats.hydrate(async () => { throw unreadableError(); }, { storage });
  let opened = false;
  await assert.rejects(chats.recover('start-fresh', {
    setAside: async () => { throw new Error('the file is in use'); },
    backend: async () => { opened = true; return fakeBackend([]); },
  }), /in use/);
  assert.equal(opened, false);
  assert.notEqual(chats.recovery(), null, 'still offered');
  assert.equal(chats.persistent(), false);
  assert.deepEqual(chats.readStore().map((s) => s.id), ['keep']);
  await assert.rejects(chats.recover('start-fresh', {}), /needs setAside and backend/);
});

test('NEURA-022: the shell renames, never deletes; the notice and the export hint are wired', () => {
  const rs = read('desktop', 'src-tauri', 'src', 'chat_store.rs');
  assert.match(rs, /pub fn chat_store_set_aside\(app: tauri::AppHandle\) -> Result<String, String>/);
  assert.match(rs, /chats\.unreadable-\{\}\.sqlite3/);
  assert.match(rs, /std::fs::rename\(&main, dir\.join\(&name\)\)/);
  assert.match(rs, /PRAGMA wal_checkpoint\(TRUNCATE\)/, 'the WAL is folded in before the rename');
  assert.doesNotMatch(rs, /remove_file\(/, 'no file is ever deleted');
  assert.match(rs, /\{\}\.unreadable-\{\}", KEY_NAME, stamp/, 'the old key is copied aside before the live entry is cleared');
  assert.match(rs, /fn set_aside_renames_and_never_overwrites\(\)/);
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /chat_store::chat_store_set_aside,/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /call<string>\('chat_store_set_aside'\)/);
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /onRecovery: \(plan\) => setChatRecovery\(plan\)/);
  assert.match(app, /chats\.recover\(choice, \{ setAside: chatStoreSetAside, backend: chatStoreBackend \}\)/);
  assert.match(app, /role="alert"/);
  const history = read('desktop', 'src', 'components', 'SessionManager.tsx');
  assert.match(history, /Export now and then/);
});

// ---- NEURA-024 ---------------------------------------------------------------

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]] = m[2];
  return out;
}

test('NEURA-024: disabled buttons are >= 3:1 on every surface in both themes, and look disabled', () => {
  const css = read('desktop', 'src', 'index.css');
  const dark = tokens(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
  const lightStart = css.indexOf('[data-theme="light"] {');
  const light = tokens(css.slice(lightStart, css.indexOf('}', lightStart)));
  for (const [name, theme] of [['dark', dark], ['light', light]]) {
    assert.ok(theme['disabled-fg'], name + ' defines --disabled-fg');
    for (const bg of ['bg-0', 'bg-1', 'bg-2', 'bg-3']) {
      const ratio = contrast(theme['disabled-fg'], theme[bg]);
      assert.ok(ratio >= 3, `${name} --disabled-fg on --${bg} is ${ratio.toFixed(2)}:1`);
    }
    // Dimmer than live text, so it does not read as enabled.
    assert.ok(contrast(theme['disabled-fg'], theme['bg-1']) < contrast(theme['text-2'], theme['bg-1']));
  }
  const rule = css.match(/button:disabled,\s*button\.primary:disabled\s*\{([^}]*)\}/);
  assert.ok(rule, 'one global rule covers plain and primary buttons');
  assert.match(rule[1], /opacity:\s*1;/);
  assert.match(rule[1], /color:\s*var\(--disabled-fg\);/);
  assert.match(rule[1], /border-color:\s*var\(--disabled-fg\);/);
  assert.match(rule[1], /border-style:\s*dashed;/, 'dashed: unmistakably not an enabled button');
  assert.match(rule[1], /background:\s*transparent;/);
  assert.doesNotMatch(css, /button:disabled\s*\{\s*opacity:\s*0\.5/, 'the faint look is gone');
  assert.doesNotMatch(css, /\.update-install:disabled\s*\{[^}]*opacity\s*:/);
  const card = read('desktop', 'src', 'components', 'AppearanceCard.tsx');
  assert.match(card, /<button type="button" onClick=\{reset\} disabled=\{hue === DEFAULT_ACCENT_HUE\}>Reset<\/button>/);
});

// ---- NEURA-026 ---------------------------------------------------------------

test('NEURA-026: docs point at shared/keymap.js, never the old src/keymap.js', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'shared', 'keymap.js')));
  const docs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && entry.name !== 'BACKLOG.md') docs.push(full);
    }
  };
  walk(path.join(ROOT, 'docs'));
  for (const file of docs) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!/keymap\.js/.test(line)) continue;
      assert.doesNotMatch(line.replace(/shared\/keymap\.js/g, ''), /keymap\.js/, `${path.relative(ROOT, file)}: ${line.trim().slice(0, 80)}`);
    }
  }
  assert.match(read('docs', 'desktop.md'), /\(\[`shared\/keymap\.js`\]\(\.\.\/shared\/keymap\.js\)\)/);
});
