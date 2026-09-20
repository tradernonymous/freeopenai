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

// ---- wiring -------------------------------------------------------------

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
