// Chat history import/export. The bug this locks down: the old merge was
// [...existing, ...incoming] then .slice(-60) on the END, so importing a few
// OLD chats could push the newest existing ones out of the window -- an import
// silently destroying history -- and any object with an `id` was accepted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chats = require('../desktop/src/chats.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const session = (id, updatedAt, extra = {}) => ({
  id,
  title: 'chat ' + id,
  messages: [{ role: 'user', content: 'hi', ts: updatedAt }],
  provider: 'p',
  model: 'm',
  mode: 'chat',
  draft: '',
  updatedAt,
  ...extra,
});

test('importing old chats cannot evict the newest existing ones', () => {
  const existing = [session('new', 10_000_000)];
  const old = [];
  for (let i = 0; i < 70; i += 1) old.push(session('old-' + i, 1000 + i));
  const result = chats.merge(existing, old, 60);
  assert.equal(result.total, 60);
  assert.ok(result.sessions.some((s) => s.id === 'new'), 'the newest existing chat survives');
  assert.ok(!result.sessions.some((s) => s.id === 'old-0'), 'the oldest imported chat is the one dropped');
  assert.equal(result.trimmed, 11);
});

test('the newer copy of a session id wins, from either side', () => {
  const existing = [session('same', 5000, { title: 'kept' })];
  const stale = [session('same', 1000, { title: 'stale' })];
  const kept = chats.merge(existing, stale, 60);
  assert.equal(kept.sessions.length, 1);
  assert.equal(kept.sessions[0].title, 'kept', 'an older import does not overwrite');
  assert.equal(kept.updated, 0);

  const fresher = [session('same', 9000, { title: 'fresh' })];
  const updated = chats.merge(existing, fresher, 60);
  assert.equal(updated.sessions[0].title, 'fresh');
  assert.equal(updated.updated, 1);
  assert.equal(updated.total, 1);
});

test('a hand-edited file cannot smuggle in non-sessions or clashing ids', () => {
  const incoming = [
    session('real', 3000),
    { id: 'no-messages', title: 'garbage' },
    { title: 'no id', messages: [] },
    { id: 'bad-messages', messages: [{ role: 42 }] },
    null,
    'not an object',
    session('real', 2000),
  ];
  assert.deepEqual(chats.sanitize(incoming).map((s) => s.id), ['real']);
  const result = chats.merge([], incoming, 60);
  assert.equal(result.total, 1);
  assert.equal(result.skipped > 0, true, 'the junk is reported, not silently absorbed');
});

test('an export of one session, or of {sessions:[...]}, still imports', () => {
  assert.equal(chats.sanitize({ sessions: [session('a', 1)] }).length, 1);
  assert.equal(chats.sanitize({ nope: true }).length, 0);
  const wrapper = chats.merge([], { sessions: [session('a', 1)] }, 60);
  assert.equal(wrapper.total, 1);
});

test('the summary says what happened, including what was dropped', () => {
  const empty = chats.merge([], [], 60);
  assert.match(chats.summary(empty), /nothing new/);
  const some = chats.merge([], [session('a', 1)], 60);
  assert.match(chats.summary(some), /1 new/);
  assert.match(chats.summary(some), /1 chat\(s\) kept/);
});

// ---- export -------------------------------------------------------------

test('export puts the anchor in the document and releases the object URL', () => {
  const children = [];
  const anchor = { href: '', download: '', style: {}, clicks: 0, click() { this.clicks += 1; } };
  const doc = {
    body: {
      appendChild: (el) => { children.push(el); },
      removeChild: (el) => { const i = children.indexOf(el); if (i >= 0) children.splice(i, 1); },
    },
    createElement: () => anchor,
  };
  const revoked = [];
  const urls = { createObjectURL: () => 'blob:test', revokeObjectURL: (u) => revoked.push(u) };

  const ok = chats.downloadJson('freeai4u-chats.json', '[]', { document: doc, URL: urls });
  assert.equal(ok, true);
  assert.equal(anchor.clicks, 1, 'the click happened');
  assert.equal(anchor.download, 'freeai4u-chats.json');
  assert.deepEqual(children, [], 'the anchor is removed again');
  assert.deepEqual(revoked, ['blob:test'], 'the object URL does not leak for the life of the window');
  assert.equal(chats.downloadJson('x.json', '[]', { document: null }), false);
});

// ---- the store: one owner -----------------------------------------------

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

const stored = (id, updatedAt, extra = {}) => ({
  id,
  title: id,
  messages: [{ role: 'user', content: 'hi' }],
  provider: 'p',
  model: 'm',
  mode: 'chat',
  draft: '',
  updatedAt,
  ...extra,
});

test('the store round-trips, and caps what it writes', () => {
  const storage = memoryStorage();
  let rows = [stored('a', 3), stored('b', 2)];
  const cap = chats.MAX_SESSIONS;
  assert.ok(cap >= 500, 'tool-heavy transcripts need more than the old 60');
  for (let i = 0; i < cap + 10; i += 1) rows.push(stored('old-' + i, i));
  assert.equal(chats.writeStore(storage, rows), true);

  const loaded = chats.readStore(storage);
  assert.equal(loaded.length, cap, 'the cap holds on write and on read');
  assert.equal(loaded[0].id, 'a', 'order is preserved: the screen prepends, so the head is newest');
  assert.ok(loaded.some((s) => s.id === 'old-' + (cap - 3)), 'the last entry inside the cap is still there');
  assert.ok(!loaded.some((s) => s.id === 'old-' + (cap + 9)), 'the tail -- the oldest -- is what the cap drops');
  assert.deepEqual(chats.readStore(memoryStorage()), [], 'an empty store is an empty list');
});

test('reading our own store is forgiving, importing a file is not', () => {
  const storage = memoryStorage();
  // Our own data may predate a field; it is not untrusted input, and dropping a
  // chat the user has been using would be data loss.
  storage.setItem(chats.STORE_KEY, JSON.stringify([
    { id: 'kept', messages: [] },
    { id: '', messages: [] },
    { messages: [] },
    'not an object',
  ]));
  assert.deepEqual(chats.readStore(storage).map((s) => s.id), ['kept']);
  assert.equal(chats.isStoredSession({ id: 'kept', messages: [] }), true);
  assert.equal(chats.isStoredSession({ id: 'kept', messages: [] }), true);

  // An imported file is untrusted: a message with no role, or a non-string
  // content, is refused instead of rendering as a blank bubble.
  assert.equal(chats.isChatSession({ id: 'x', messages: [{ role: 1 }] }), false);
  assert.equal(chats.isChatSession({ id: 'x', messages: [{ role: 'user', content: {} }] }), false);
  assert.equal(chats.isChatSession({ id: 'x', messages: [{ role: 'user', content: 'ok' }] }), true);
});

test('the history list orders by recency without touching its input', () => {
  const rows = [stored('old', 1), stored('new', 9), stored('mid', 5)];
  const sorted = chats.byRecency(rows);
  assert.deepEqual(sorted.map((s) => s.id), ['new', 'mid', 'old']);
  assert.deepEqual(rows.map((s) => s.id), ['old', 'new', 'mid'], 'the caller\'s array is not reordered');
});

// ---- wiring -------------------------------------------------------------

test('exactly one module knows where the chat store lives', () => {
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(entry.name)) sources.push(full);
    }
  })(path.join(ROOT, 'desktop', 'src'));

  const owners = sources.filter((file) => fs.readFileSync(file, 'utf8').includes('freeai4u.chats'));
  assert.deepEqual(owners.map((f) => path.basename(f)), ['chats.js'],
    'the key belongs to the store; four files used to spell it out');
});

test('every reader of the history goes through the store', () => {
  const readers = [
    ['desktop', 'src', 'App.tsx'],
    ['desktop', 'src', 'screens', 'ChatScreen.tsx'],
    ['desktop', 'src', 'screens', 'LibraryScreen.tsx'],
    ['desktop', 'src', 'components', 'SessionManager.tsx'],
  ];
  for (const parts of readers) {
    const src = read(...parts);
    const label = parts.join('/');
    assert.match(src, /import '.*chats\.js'/, `${label} loads the store`);
    // The local name may differ (Library already has a `chats` state), so this
    // checks the call into the store, not the alias a screen chose.
    assert.match(src, /\.(readStore|writeStore|byRecency|merge)\(/, `${label} uses the store`);
    assert.doesNotMatch(src, /localStorage\.(get|set)Item\('freeai4u\.chats'/,
      `${parts.join('/')} does not parse the store itself`);
  }
});


test('App uses the module for both halves of import/export', () => {
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /chats\.downloadJson/, 'export goes through the tested helper');
  assert.match(app, /chats\.merge/, 'the merge is the tested one');
  assert.doesNotMatch(app, /byId\.set\(s\.id, s\)\);\s*$/m, 'the raw by-id merge is gone');
  assert.match(app, /chats\.CHATS_CHANGED_EVENT|CHATS_CHANGED_EVENT/, 'an import notifies open screens');
});

test('the chat screen reloads after an import and prunes ghost ids', () => {
  const screen = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(screen, /CHATS_CHANGED_EVENT/, 'it listens for an import');
  assert.match(screen, /!sessions\.some\(\(s\) => s\.id === activeId\)/, 'a pruned id falls back to a real session');
  assert.doesNotMatch(screen, /const saved = loadSessions\(\);/, 'localStorage is parsed once, not twice');
});

test('a full localStorage loses the oldest chats, never the newest, and says so', () => {
  // A storage that refuses anything over ~2 KB, the way WebView2 refuses a
  // write past its quota: by throwing.
  const small = memoryStorage();
  const limit = 2000;
  const setItem = small.setItem.bind(small);
  small.setItem = (key, value) => {
    if (String(value).length > limit) throw new Error('QuotaExceededError');
    setItem(key, value);
  };
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push(stored('s' + i, 100 - i));

  const report = chats.writeStoreReport(small, rows);
  assert.equal(report.ok, true);
  assert.equal(report.quota, true, 'the quota was hit and reported');
  assert.ok(report.kept > 0 && report.kept < 40, `kept ${report.kept}`);
  assert.equal(report.kept + report.dropped, 40);
  const loaded = chats.readStore(small);
  assert.equal(loaded[0].id, 's0', 'the head -- the newest -- survives');
  assert.equal(loaded.length, report.kept);

  // One session too big for the quota on its own: honest failure, not a hang.
  const huge = stored('huge', 1, { messages: [{ role: 'user', content: 'x'.repeat(limit) }] });
  assert.deepEqual(chats.writeStoreReport(small, [huge]), { ok: false, kept: 0, dropped: 1, quota: true });
  assert.equal(chats.writeStore(small, [huge]), false);
});
