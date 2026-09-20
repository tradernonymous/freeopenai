// Toasts replaced `setHint(...)` plus a bare setTimeout in the sidebar: feedback
// that a screen reader could not see, nobody could dismiss, and that vanished
// four seconds later. These are the queue's rules.
const test = require('node:test');
const assert = require('node:assert/strict');

const toasts = require('../desktop/src/toasts.js');

const NOW = 1_800_000_000_000;

test('a message is added with a kind and the time it arrived', () => {
  const rows = toasts.push([], { kind: 'ok', text: 'Exported.' }, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'Exported.');
  assert.equal(rows[0].kind, 'ok');
  assert.equal(rows[0].at, NOW);
  assert.ok(rows[0].id, 'it can be dismissed, so it needs an id');
});

test('saying the same thing twice refreshes it instead of stacking a copy', () => {
  let rows = toasts.push([], { kind: 'warn', text: 'Sign in first.' }, NOW);
  rows = toasts.push(rows, { kind: 'warn', text: 'Sign in first.' }, NOW + 1000);
  assert.equal(rows.length, 1, 'one message on screen, not two');
  assert.equal(rows[0].at, NOW + 1000, 'the clock restarts from the newest repeat');
});

test('the same words after a while are a new message again', () => {
  let rows = toasts.push([], { kind: 'warn', text: 'Sign in first.' }, NOW);
  rows = toasts.push(rows, { kind: 'warn', text: 'Sign in first.' }, NOW + toasts.REPEAT_WINDOW_MS + 1);
  assert.equal(rows.length, 2);
});

test('an empty message is not a message', () => {
  assert.deepEqual(toasts.push([], { text: '   ' }, NOW), []);
});

test('the queue never grows past what a person can read at once', () => {
  let rows = [];
  for (let i = 0; i < toasts.MAX_VISIBLE + 3; i += 1) {
    rows = toasts.push(rows, { kind: 'info', text: `message ${i}` }, NOW + i);
  }
  assert.equal(rows.length, toasts.MAX_VISIBLE);
  assert.equal(rows[rows.length - 1].text, `message ${toasts.MAX_VISIBLE + 2}`, 'the newest survive');
  assert.ok(!rows.some((r) => r.text === 'message 0'), 'the oldest is the one that goes');
});

test('an ordinary toast ages out; a sticky one waits to be dismissed', () => {
  const rows = toasts.push(
    toasts.push([], { kind: 'info', text: 'Downloading…' }, NOW),
    { kind: 'error', text: 'Download failed', sticky: true },
    NOW,
  );
  const aged = toasts.expired(rows, NOW + toasts.DEFAULT_MS, toasts.DEFAULT_MS);
  assert.deepEqual(aged.map((r) => r.text), ['Downloading…']);
  // A failure someone has to act on stays.
  const after = toasts.prune(rows, NOW + toasts.DEFAULT_MS);
  assert.deepEqual(after.map((r) => r.text), ['Download failed']);
});

test('dismissing removes exactly one message', () => {
  let rows = toasts.push(toasts.push([], { kind: 'info', text: 'one' }, NOW), { kind: 'info', text: 'two' }, NOW);
  rows = toasts.dismiss(rows, rows[0].id);
  assert.deepEqual(rows.map((r) => r.text), ['two']);
});

test('each kind has an icon, and an unknown kind still gets one', () => {
  for (const kind of ['info', 'ok', 'warn', 'error', 'nonsense']) {
    assert.equal(typeof toasts.iconFor(kind), 'string');
  }
});

test('the component renders the queue and nothing of its own', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'components', 'Toasts.tsx'), 'utf8');
  assert.match(source, /toasts\.push/, 'rules come from the module');
  assert.match(source, /toasts\.prune/);
  assert.match(source, /aria-live="polite"/, 'a screen reader is told');
  // The old sidebar hint is gone: it was the thing this replaced.
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'Sidebar.tsx'), 'utf8');
  assert.ok(!sidebar.includes('sidebar-hint'), 'the four-second hint is gone');
});
