// The hub (hub.js + hub.css): the mode switch, the Builds panel and the
// Knowledges hub. The DOM half runs in the browser smoke; what is checked here is
// the logic that decides what is shown, and that the page is actually wired to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hub = require('../hub.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'hub.css'), 'utf8');

test('a reply reads like a plan when it has steps', () => {
  assert.equal(hub.looksLikePlan('1. Add a test\n2. Write the code'), true);
  assert.equal(hub.looksLikePlan('Step 1: read\nStep 2: write'), true);
  assert.equal(hub.looksLikePlan('- one\n- two\n- [ ] three'), true);
  assert.equal(hub.looksLikePlan('The answer is 42.'), false);
  assert.equal(hub.looksLikePlan('1. only one step'), false);
  assert.equal(hub.looksLikePlan('- a\n- b'), false, 'two bullets is a list, not a plan');
  assert.equal(hub.looksLikePlan(null), false);
});

test('the badge puts builds waiting on you first', () => {
  assert.equal(hub.badgeFor([]), null);
  assert.equal(hub.badgeFor([{ status: 'done' }, { status: 'failed' }]), null);
  assert.deepEqual(hub.badgeFor([{ status: 'running' }]), { kind: 'running', text: '' });
  assert.deepEqual(hub.badgeFor([{ status: 'running' }, { status: 'awaiting_approval' }, { status: 'awaiting_input' }]), { kind: 'waiting', text: '2' });
  assert.equal(hub.badgeFor(undefined), null);
});

test('diff lines are tagged for colour', () => {
  assert.deepEqual(hub.diffLines(' same\n-old\n+new').map((l) => l.kind), ['ctx', 'del', 'add']);
  assert.deepEqual(hub.diffLines(''), [{ kind: 'ctx', text: '' }]);
});

test('status labels and row titles read as words', () => {
  assert.equal(hub.statusLabel('awaiting_approval'), 'Needs approval');
  assert.equal(hub.statusLabel('something_new'), 'something_new');
  const row = hub.planTitle({ steps: [{ title: 'Make a README', status: 'done' }, { title: 'Check it', status: 'pending' }] });
  assert.deepEqual(row, { title: 'Make a README', progress: '1/2 steps' });
  assert.deepEqual(hub.planTitle({}), { title: 'Build', progress: '' });
  assert.equal(hub.timeAgo(1000, 1000 + 30 * 1000), 'just now');
  assert.equal(hub.timeAgo(0, 2 * 3600 * 1000), '2 h ago');
});

test('the desktop app is recognised, and remembered across the login redirect', () => {
  assert.equal(hub.appModeFrom('?app=desktop', null), 'desktop');
  assert.equal(hub.appModeFrom('', 'desktop'), 'desktop', 'the login redirect drops the query; the saved flag keeps the layout');
  assert.equal(hub.appModeFrom('?app=web', 'desktop'), '', 'and it can be turned off');
  assert.equal(hub.appModeFrom('', null), '');
  assert.equal(hub.appModeFrom('?app=evil', null), '');
});

test('keyboard shortcuts switch modes and panels, and leave typing alone', () => {
  const key = (code, mods = {}) => ({ code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
  assert.deepEqual(hub.shortcutFor(key('Digit2', { altKey: true })), { kind: 'mode', mode: 'plan' });
  assert.deepEqual(hub.shortcutFor(key('Digit3', { altKey: true })), { kind: 'mode', mode: 'build' });
  assert.deepEqual(hub.shortcutFor(key('KeyB', { ctrlKey: true, shiftKey: true })), { kind: 'panel', tab: 'builds' });
  assert.deepEqual(hub.shortcutFor(key('KeyK', { metaKey: true, shiftKey: true })), { kind: 'panel', tab: 'knowledges' });
  assert.equal(hub.shortcutFor(key('Digit2')), null, 'a plain 2 is typing');
  assert.equal(hub.shortcutFor(key('KeyB', { ctrlKey: true })), null, 'Ctrl+B is left to the page');
  assert.equal(hub.shortcutFor(null), null);
  assert.ok(hub.SHORTCUTS.length >= 3, 'the shortcuts are listed for people to find');
});

test('the page loads the hub and hands it what it needs', () => {
  assert.match(html, /<script src="hub\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="hub\.css">/);
  assert.ok(html.indexOf('hub.css') > html.indexOf('</style>'), 'the hub stylesheet comes after the inline styles');
  assert.match(html, /window\.NeuraOSPage = \{/);
  for (const key of ['modes: MODES', 'toolGroups: TOOL_GROUPS', 'modeToolGroups: MODE_TOOL_GROUPS', 'chatCommands: CHAT_COMMANDS', 'setMode:']) {
    assert.ok(html.includes(key), 'bridge exposes ' + key);
  }
  assert.match(html, /NeuraOSHub\.syncMode\(selectedMode\)/, 'the switch follows every mode change');
  assert.match(html, /NeuraOSHub\.decorateActions\(bar\)/, 'replies get the Build action');
});

test('picking a mode directly has the same effects as cycling to it', () => {
  const setter = html.slice(appJs.indexOf('function setChatMode('), html.indexOf('window.NeuraOSPage'));
  assert.match(setter, /isValidMode\(id\)/, 'an unknown mode is ignored');
  assert.match(setter, /rememberPreference\('freeopenaiMode'/);
  assert.match(setter, /updateModeChip\(\)/);
});

test('model and server text is never written as HTML', () => {
  // innerHTML is used for the fixed icon strings only.
  const uses = js.split('\n').filter((line) => /innerHTML/.test(line) && !/^\s*\/\//.test(line));
  assert.ok(uses.length >= 1);
  for (const line of uses) assert.match(line, /ICONS\[/, 'innerHTML only ever takes an icon: ' + line.trim());
});

test('the hub talks to the build contract the phone uses', () => {
  assert.match(js, /const API = '\/api\/build\/sessions'/);
  assert.match(js, /'\/events'/);
  assert.match(js, /'\/input'/);
  assert.match(js, /'\/cancel'/);
  assert.match(js, /decision: 'approve'/);
  assert.match(js, /decision: 'reject'/);
  assert.match(js, /requestId: event\.requestId/, 'answers name the request they answer');
  // The next approval can arrive over the stream before the answer's response
  // does; clearing unconditionally wiped it (seen in the browser).
  const send = js.slice(js.indexOf('async function sendInput('), js.indexOf('async function cancelBuild('));
  assert.match(send, /state\.pending\.requestId === payload\.requestId\) clearAsk\(\)/);
});

test('the hub styles respect reduced motion and small screens', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /html\[data-theme="light"\]/, 'the accents have light-theme values');
});
