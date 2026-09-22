// Phase 12b: chat history out of localStorage into an encrypted SQLite file.
//
// What this locks down:
//   * chat-crypto: AES-GCM round trip, a wrong key fails loudly, every write a
//     fresh IV, the key made once and kept in the credential store;
//   * chats.js: the in-memory cache answers the synchronous readStore/writeStore
//     every screen calls, a debounced flush sends only what changed, the
//     localStorage history moves over and is removed only after it reads back,
//     and any backend failure lands back on localStorage without losing chats;
//   * the Rust side exists and is wired (source checks: no cargo on this PC).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chats = require('../desktop/src/chats.js');
const cc = require('../desktop/src/chat-crypto.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

const session = (id, updatedAt, extra = {}) => ({
  id,
  title: 'chat ' + id,
  messages: [{ role: 'user', content: 'hello ' + id }],
  provider: 'p',
  model: 'm',
  mode: 'chat',
  draft: '',
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
  const log = { list: 0, put: [], remove: [] };
  return {
    rows,
    log,
    failPut: false,
    failList: false,
    dropOnPut: false,
    async list() {
      log.list += 1;
      if (this.failList) throw new Error('db locked');
      return [...rows.values()].map(clone);
    },
    async put(sessions) {
      log.put.push(sessions.map((s) => s.id));
      if (this.failPut) throw new Error('disk full');
      if (this.dropOnPut) return;
      sessions.forEach((s) => rows.set(s.id, clone(s)));
    },
    async remove(ids) {
      log.remove.push(ids.slice());
      ids.forEach((id) => rows.delete(id));
    },
  };
}

// Each test gets a clean store; the module is a singleton, as in the app.
test.beforeEach(() => chats.detach());
test.afterEach(() => chats.detach());

// ---- chat-crypto ----------------------------------------------------------

test('a chat encrypts and decrypts back to the same text', async () => {
  const key = await cc.generateKey();
  const text = JSON.stringify(session('a', 1, { messages: [{ role: 'user', content: 'héllo — 世界' }] }));
  const blob = await cc.encrypt(key, text);
  assert.equal(typeof blob, 'string');
  assert.ok(!blob.includes('hello'), 'the blob is not the plain text');
  assert.equal(await cc.decrypt(key, blob), text);

  // Pictures make chats megabytes long; the base64 path must not choke.
  const big = 'x'.repeat(2 * 1024 * 1024);
  assert.equal(await cc.decrypt(key, await cc.encrypt(key, big)), big);
});

test('a wrong key, or a damaged blob, fails instead of returning garbage', async () => {
  const key = await cc.generateKey();
  const other = await cc.generateKey();
  const blob = await cc.encrypt(key, 'secret');
  await assert.rejects(cc.decrypt(other, blob));
  const bytes = cc.fromBase64(blob);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(cc.decrypt(key, cc.toBase64(bytes)), 'the GCM tag catches tampering');
  await assert.rejects(cc.decrypt(key, 'AAAA'), 'too short to hold an IV');
});

test('every encryption uses a fresh 12-byte IV', async () => {
  const key = await cc.generateKey();
  const ivs = new Set();
  const blobs = new Set();
  for (let i = 0; i < 50; i += 1) {
    const blob = await cc.encrypt(key, 'same text');
    blobs.add(blob);
    ivs.add(Buffer.from(cc.fromBase64(blob).subarray(0, cc.IV_BYTES)).toString('hex'));
  }
  assert.equal(cc.IV_BYTES, 12);
  assert.equal(ivs.size, 50, 'no IV repeats');
  assert.equal(blobs.size, 50, 'the same text never seals the same way twice');
});

test('the key is made once, kept in the credential store, and reused', async () => {
  const vault = new Map();
  const store = {
    get: async () => vault.get('chat_key') ?? null,
    set: async (v) => { vault.set('chat_key', v); },
  };
  const first = await cc.loadOrCreateKey(store);
  const saved = vault.get('chat_key');
  assert.equal(cc.fromBase64(saved).length, 32, 'a 256-bit key');
  const blob = await cc.encrypt(first, 'kept');
  const second = await cc.loadOrCreateKey(store);
  assert.equal(vault.get('chat_key'), saved, 'the stored key is not replaced');
  assert.equal(await cc.decrypt(second, blob), 'kept', 'the next launch opens the chats');

  // A store that does not keep what it is given is an error, not a silent new key.
  const leaky = { get: async () => null, set: async () => {} };
  await assert.rejects(cc.loadOrCreateKey(leaky), /did not keep/);
  await assert.rejects(cc.importKey(cc.toBase64(new Uint8Array(16))), /256-bit/);
});

test('the shell backend stores ciphertext rows and reads sessions back', async () => {
  const key = await cc.generateKey();
  const db = new Map();
  const calls = [];
  const call = async (command, args) => {
    calls.push(command);
    if (command === 'chat_store_put') { args.rows.forEach((r) => db.set(r.id, r)); return args.rows.length; }
    if (command === 'chat_store_list') return [...db.values()];
    if (command === 'chat_store_delete') { args.ids.forEach((id) => db.delete(id)); return args.ids.length; }
    if (command === 'chat_store_clear') { const n = db.size; db.clear(); return n; }
    throw new Error('unknown ' + command);
  };
  const backend = cc.backend({ call, key });
  await backend.put([session('a', 5), session('b', 7)]);
  const row = db.get('a');
  assert.deepEqual(Object.keys(row).sort(), ['blob', 'id', 'updated_at']);
  assert.equal(row.updated_at, 5);
  assert.ok(!row.blob.includes('hello'), 'the database never sees a message');
  const back = await backend.list();
  assert.deepEqual(back.map((s) => s.id).sort(), ['a', 'b']);
  assert.equal(back.find((s) => s.id === 'a').messages[0].content, 'hello a');
  await backend.remove(['a']);
  assert.deepEqual([...db.keys()], ['b']);

  // Rows that no key here opens: the wrong key, said out loud.
  const stranger = cc.backend({ call, key: await cc.generateKey() });
  await assert.rejects(stranger.list(), /does not open/);
  await backend.clear();
  assert.deepEqual(await stranger.list(), [], 'an empty store is fine with any key');
});

// ---- chats.js: cache + flush ------------------------------------------------

test('hydrate reads the backend into the cache and readStore answers from it', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend([session('old', 1), session('new', 9)]);
  const events = [];
  globalThis.dispatchEvent = (e) => { events.push(e.type); return true; };
  try {
    const result = await chats.hydrate(backend, { storage, delay: 0 });
    assert.deepEqual(result, { mode: 'shell', migrated: 0 });
  } finally {
    delete globalThis.dispatchEvent;
  }
  assert.equal(chats.persistent(), true);
  assert.deepEqual(chats.readStore().map((s) => s.id), ['new', 'old'], 'newest first');
  assert.deepEqual(events, [chats.CHATS_CHANGED_EVENT], 'History redraws once the store lands');
  assert.equal(storage.map.size, 0, 'nothing is written to localStorage');
});

test('writes update the cache at once and flush only what changed', async () => {
  const storage = memoryStorage();
  const a = session('a', 1);
  const b = session('b', 2);
  const backend = fakeBackend([a, b]);
  await chats.hydrate(backend, { storage, delay: 5 });
  const base = chats.readStore();

  // Three quick writes: the cache follows each, the backend hears once.
  const edited = { ...base.find((s) => s.id === 'a'), title: 'renamed', updatedAt: 3 };
  chats.writeStore(null, [edited, base.find((s) => s.id === 'b')]);
  assert.equal(chats.readStore().find((s) => s.id === 'a').title, 'renamed', 'synchronous for callers');
  const c = session('c', 4);
  chats.writeStore(null, [c, ...chats.readStore()]);
  const report = chats.writeStoreReport(null, [c, ...chats.readStore().filter((s) => s.id !== 'c')]);
  assert.deepEqual(report, { ok: true, kept: 3, dropped: 0, quota: false });
  assert.equal(backend.log.put.length, 0, 'debounced: nothing sent yet');

  await new Promise((r) => setTimeout(r, 30));
  await chats.flush();
  assert.deepEqual(backend.log.put.map((ids) => ids.slice().sort()), [['a', 'c']], 'b did not change and was not re-sent');
  assert.equal(backend.rows.get('a').title, 'renamed');

  // A delete is a remove; an unchanged list sends nothing.
  chats.writeStore(null, chats.readStore().filter((s) => s.id !== 'b'));
  await chats.flush();
  assert.deepEqual(backend.log.remove, [['b']]);
  const puts = backend.log.put.length;
  chats.writeStore(null, chats.readStore());
  await chats.flush();
  assert.equal(backend.log.put.length, puts);
  assert.equal(backend.log.remove.length, 1);
  assert.equal(storage.map.size, 0);
});

test('first run: localStorage chats move to the backend, then the old copy goes', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('x', 5), session('y', 3)]);
  const backend = fakeBackend([]);
  const result = await chats.hydrate(backend, { storage, delay: 0 });
  assert.deepEqual(result, { mode: 'shell', migrated: 2 });
  assert.deepEqual([...backend.rows.keys()].sort(), ['x', 'y']);
  assert.ok(backend.log.list >= 2, 'the write was read back before anything was removed');
  assert.equal(storage.getItem(chats.STORE_KEY), null, 'the localStorage copy is removed');
  assert.deepEqual(chats.readStore().map((s) => s.id), ['x', 'y']);
});

test('a migration that does not read back keeps localStorage and stays there', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('x', 5)]);
  const before = storage.getItem(chats.STORE_KEY);
  const backend = fakeBackend([]);
  backend.dropOnPut = true; // accepts the write, keeps nothing
  const notices = [];
  const result = await chats.hydrate(backend, { storage, onNotice: (t) => notices.push(t) });
  assert.equal(result.mode, 'local');
  assert.match(result.error, /did not read back/);
  assert.equal(storage.getItem(chats.STORE_KEY), before, 'not one chat was removed');
  assert.equal(chats.persistent(), false);
  assert.deepEqual(chats.readStore().map((s) => s.id), ['x'], 'the history still reads, from localStorage');
  assert.equal(notices.length, 1);
});

test('the backend is the newer copy: an older localStorage chat does not overwrite it', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('same', 1, { title: 'stale' }), session('only-local', 2)]);
  const backend = fakeBackend([session('same', 9, { title: 'fresh' })]);
  await chats.hydrate(backend, { storage, delay: 0 });
  assert.deepEqual(backend.log.put, [['only-local']]);
  assert.equal(chats.readStore().find((s) => s.id === 'same').title, 'fresh');
});

test('no shell, or a backend that fails to open, leaves localStorage as it was', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('x', 5)]);
  assert.deepEqual(await chats.hydrate(null, { storage }), { mode: 'local', migrated: 0 });

  const notices = [];
  const failing = async () => { throw new Error('credential store: locked'); };
  const result = await chats.hydrate(failing, { storage, onNotice: (t) => notices.push(t) });
  assert.equal(result.mode, 'local');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /browser storage/);

  const listFails = fakeBackend([]);
  listFails.failList = true;
  await chats.hydrate(listFails, { storage });
  assert.equal(notices.length, 1, 'said once, not on every failure');
  assert.equal(chats.persistent(), false);
  chats.writeStore(null, [session('y', 6), ...chats.readStore()]);
  assert.deepEqual(chats.readStore(storage).map((s) => s.id), ['y', 'x'], 'writes go to localStorage, unchanged');
});

test('a flush that fails falls back to localStorage with every chat kept', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend([session('a', 1)]);
  const notices = [];
  await chats.hydrate(backend, { storage, delay: 0, onNotice: (t) => notices.push(t) });
  backend.failPut = true;
  chats.writeStore(null, [session('b', 2), ...chats.readStore()]);
  assert.equal(await chats.flush(), false);
  assert.equal(chats.persistent(), false);
  assert.deepEqual(chats.readStore(storage).map((s) => s.id), ['b', 'a'], 'the cache was written to localStorage');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /browser storage/);
});

test('hydrate runs once even when two callers ask', async () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('x', 5)]);
  const backend = fakeBackend([]);
  const [one, two] = await Promise.all([
    chats.hydrate(backend, { storage, delay: 0 }),
    chats.hydrate(backend, { storage, delay: 0 }),
  ]);
  assert.deepEqual(one, two);
  assert.equal(backend.log.put.length, 1, 'one migration, not two racing');
});

test('a hand-off from another window reaches this one through the inbox', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend([session('a', 1)]);
  await chats.hydrate(backend, { storage, delay: 0 });
  // The Quick window's copy of the module ran handOff: it left the chat here.
  storage.setItem('freeai4u.chats.inbox', JSON.stringify([session('quick', 50)]));
  assert.equal(chats.absorb(), true);
  assert.equal(chats.readStore()[0].id, 'quick', 'in the cache before the open-chat event');
  assert.equal(storage.getItem('freeai4u.chats.inbox'), null, 'the inbox is emptied');
  assert.equal(storage.getItem(chats.STORE_KEY), null, 'the history key is never touched');
  await chats.flush();
  assert.ok(backend.rows.has('quick'));

  // handOff itself, in shell mode: this store and the inbox.
  assert.equal(chats.handOff(session('q2', 60)), true);
  assert.equal(chats.readStore()[0].id, 'q2');
  assert.deepEqual(JSON.parse(storage.getItem('freeai4u.chats.inbox')).map((s) => s.id), ['q2']);
});

test('without the shell a hand-off is the old localStorage write', () => {
  const storage = memoryStorage();
  chats.writeStore(storage, [session('a', 1)]);
  return chats.hydrate(null, { storage }).then(() => {
    assert.equal(chats.handOff(session('quick', 5)), true);
    assert.deepEqual(chats.readStore().map((s) => s.id), ['quick', 'a']);
  });
});

test('refresh takes newer chats another window wrote, and deletes nothing', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend([session('a', 1), session('b', 2)]);
  await chats.hydrate(backend, { storage, delay: 0 });
  backend.rows.set('c', session('c', 3));
  backend.rows.set('a', session('a', 7, { title: 'edited elsewhere' }));
  backend.rows.delete('b');
  assert.equal(await chats.refresh(), true);
  const ids = chats.readStore().map((s) => s.id);
  assert.deepEqual(ids, ['a', 'c', 'b']);
  assert.equal(chats.readStore()[0].title, 'edited elsewhere');
  await chats.flush();
  assert.deepEqual(backend.log.put, [], 'what was read is not written back');
});

// ---- the modules load the way the bundle loads them -----------------------

test('chat-crypto publishes its global under the bundle\'s module shim', () => {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('desktop', 'src', 'chat-crypto.js'), sandbox);
  assert.equal(typeof sandbox.FreeAI4UChatCrypto.encrypt, 'function');
  const src = read('desktop', 'src', 'chat-crypto.js');
  assert.match(src, /if \(root\) root\.FreeAI4UChatCrypto = api;/);
  assert.match(src, /AES-GCM/);
  assert.match(src, /length: 256/);
});

// ---- wiring: Rust and the app ------------------------------------------------

test('the Rust store: bundled SQLite, WAL, one transaction per batch', () => {
  const cargo = read('desktop', 'src-tauri', 'Cargo.toml');
  assert.match(cargo, /rusqlite = \{ version = "0\.31", features = \["bundled"\] \}/);
  const rs = read('desktop', 'src-tauri', 'src', 'chat_store.rs');
  assert.match(rs, /PRAGMA journal_mode=WAL/);
  assert.match(rs, /CREATE TABLE IF NOT EXISTS chats \(\s*id TEXT PRIMARY KEY,\s*updated_at INTEGER NOT NULL,\s*blob TEXT NOT NULL/);
  assert.match(rs, /conn\.transaction\(\)/);
  assert.match(rs, /tx\.commit\(\)/);
  assert.match(rs, /ON CONFLICT\(id\) DO UPDATE/);
  assert.match(rs, /chats\.sqlite3/);
  assert.match(rs, /app_data_dir\(\)/);
  assert.match(rs, /OnceLock<Mutex<Option<Connection>>>/);
  assert.match(rs, /open_in_memory/, 'unit-tested against an in-memory database');
  for (const cmd of ['chat_store_list', 'chat_store_put', 'chat_store_delete', 'chat_store_clear', 'chat_store_key_get', 'chat_store_key_set']) {
    assert.match(rs, new RegExp(`pub fn ${cmd}\\(`), `${cmd} exists`);
  }
  assert.match(rs, /crate::secrets::SERVICE/, 'the key sits under the app\'s credential service');
});

test('main.rs registers the module and every command', () => {
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /^mod chat_store;$/m);
  for (const cmd of ['chat_store_list', 'chat_store_put', 'chat_store_delete', 'chat_store_clear', 'chat_store_key_get', 'chat_store_key_set']) {
    assert.match(main, new RegExp(`chat_store::${cmd},`), `${cmd} is registered`);
  }
});

test('the app hydrates at boot, and images are kept only when the store is SQLite', () => {
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /export async function chatStoreBackend\(/);
  // NEURA-022: openBackend, which never makes a key over rows it cannot open.
  assert.match(bridge, /openBackend\(\{[\s\S]{0,120}?store: \{ get: chatStoreKeyGet, set: chatStoreKeySet \}/);
  const app = read('desktop', 'src', 'App.tsx');
  assert.equal((app.match(/chats\.hydrate\(/g) || []).length, 1, 'one hydrate call');
  const screen = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(screen, /chats\.persistent\(\) \? sessions :/);
  const quick = read('desktop', 'src', 'screens', 'QuickAsk.tsx');
  assert.match(quick, /chats\.hydrate\(chatStoreBackend\)/, 'the Quick window reads the same store');
});
