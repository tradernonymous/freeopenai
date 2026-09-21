// Phase 2: the keyboard grammar. The key resolver (src/keymap.js) and the
// composer's modes, `/` and `@` menus (src/composer.js) are pure, so what a
// key press or a typed character MEANS is tested here; the components only
// render the answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const keymap = require('../desktop/src/keymap.js');
const composer = require('../desktop/src/composer.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function memoryStore() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

// ---- keymap ------------------------------------------------------------------

test('a press becomes one combo spelling, whatever the platform or case', () => {
  assert.equal(keymap.comboOf(key('k', { ctrlKey: true })), 'Ctrl+K');
  assert.equal(keymap.comboOf(key('k', { metaKey: true })), 'Ctrl+K', 'Cmd is Ctrl');
  assert.equal(keymap.comboOf(key('Z', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Z');
  assert.equal(keymap.comboOf(key('Control', { ctrlKey: true })), '', 'a bare modifier is not a combo');
  assert.equal(keymap.normalise('shift+ctrl+z'), 'Ctrl+Shift+Z');
});

test('the resolver maps presses to actions, and Alt+N to the caller\'s list', () => {
  const nav = (e) => ({ 1: 'chat', 3: 'design' })[e.key] || null;
  assert.deepEqual(keymap.resolveKey({}, key('k', { ctrlKey: true })), { action: 'palette' });
  assert.deepEqual(keymap.resolveKey({ nav }, key('3', { altKey: true })), { action: 'nav', to: 'design' });
  assert.equal(keymap.resolveKey({ nav }, key('9', { altKey: true })), null);
  assert.equal(keymap.resolveKey({ nav }, key('3', { altKey: true, ctrlKey: true })), null, 'Ctrl+Alt is not Alt');
  assert.equal(keymap.resolveKey({}, key('a')), null, 'typing is never a shortcut');
});

test('switched off, only the ways back still answer', () => {
  const off = { enabled: false, nav: () => 'chat' };
  assert.equal(keymap.resolveKey(off, key('n', { ctrlKey: true })), null);
  assert.equal(keymap.resolveKey(off, key('1', { altKey: true })), null);
  assert.deepEqual(keymap.resolveKey(off, key('k', { ctrlKey: true })), { action: 'palette' });
  assert.deepEqual(keymap.resolveKey(off, key('Escape')), { action: 'escape' });
  assert.deepEqual(keymap.resolveKey(off, key('z', { ctrlKey: true, shiftKey: true })), { action: 'zen' });
  // The palette owns the keyboard while it is open, the same way.
  assert.equal(keymap.resolveKey({ paletteOpen: true }, key('n', { ctrlKey: true })), null);
});

test('remaps apply, persist, and cannot move the fixed rows', () => {
  const store = memoryStore();
  keymap.setOverride('new-chat', 'ctrl+alt+n', store);
  keymap.setOverride('escape', 'Ctrl+E', store);
  const table = keymap.withOverrides(keymap.readOverrides(store));
  assert.equal(table.find((b) => b.id === 'new-chat').keys, 'Ctrl+Alt+N');
  assert.equal(table.find((b) => b.id === 'escape').keys, 'Escape', 'Escape is not remappable');
  assert.deepEqual(keymap.resolveKey({ bindings: table }, key('n', { ctrlKey: true, altKey: true })), { action: 'new-chat' });
  assert.equal(keymap.resolveKey({ bindings: table }, key('n', { ctrlKey: true })), null, 'the old combo is free');
  keymap.setOverride('new-chat', null, store);
  assert.equal(keymap.withOverrides(keymap.readOverrides(store)).find((b) => b.id === 'new-chat').keys, 'Ctrl+N');
  keymap.setEnabled(false, store);
  assert.equal(keymap.enabled(store), false);
  keymap.setEnabled(true, store);
  assert.equal(keymap.enabled(store), true);
});

test('clashes are named: two actions on one combo, a bare key, a navigation key', () => {
  assert.deepEqual(keymap.conflicts(keymap.BINDINGS), [], 'the shipped table is clean');
  const clash = keymap.conflicts([{ id: 'a', keys: 'Ctrl+N' }, { id: 'b', keys: 'ctrl+n' }]);
  assert.deepEqual(clash[0].ids, ['a', 'b']);
  assert.match(keymap.conflicts([{ id: 'a', keys: 'x' }])[0].reason, /typing/);
  const reserved = [{ id: 'go to Chat', keys: 'Alt+1' }];
  assert.deepEqual(keymap.conflicts([{ id: 'a', keys: 'Alt+1' }], reserved)[0].ids, ['a', 'go to Chat']);
});

test('the shell resolves keys through the table, not its own listeners', () => {
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /keymap\.resolveKey\(/);
  assert.equal((app.match(/addEventListener\('keydown'/g) || []).length, 1, 'one keydown listener');
  const settings = read('desktop', 'src', 'screens', 'SettingsScreen.tsx');
  assert.match(settings, /<ShortcutsCard \/>/, 'the table is visible and remappable in Settings');
});

// ---- modes ---------------------------------------------------------------------

test('Tab cycles the agent modes; Shell and Design step back into the cycle', () => {
  assert.equal(composer.cycleMode('chat'), 'plan');
  assert.equal(composer.cycleMode('plan'), 'build');
  assert.equal(composer.cycleMode('build'), 'chat');
  assert.equal(composer.cycleMode('chat', true), 'build');
  assert.equal(composer.cycleMode('shell'), 'chat');
});

test('! enters Shell; Backspace at the start or Esc leaves any mode', () => {
  assert.deepEqual(composer.modeFromTyping('chat', '!'), { mode: 'shell', text: '' });
  assert.equal(composer.modeFromTyping('chat', '!x'), null, 'only a lone ! at the start');
  assert.equal(composer.leaveMode('shell', 'Backspace', 0), 'chat');
  assert.equal(composer.leaveMode('shell', 'Backspace', 3), null, 'mid-text Backspace just deletes');
  assert.equal(composer.leaveMode('plan', 'Escape', 5), 'chat');
  assert.equal(composer.leaveMode('chat', 'Escape', 0), null, 'Esc in Chat is left for Stop');
});

// ---- / -------------------------------------------------------------------------

test('the / menu opens on /word, ranks exact and prefix first, and closes at the argument', () => {
  assert.equal(composer.slashMenu('/plan')[0].id, 'plan');
  assert.equal(composer.slashMenu('/cl')[0].id, 'new', '/clear is an alias of /new');
  assert.ok(composer.slashMenu('/').length > 5, 'a bare / lists commands');
  assert.deepEqual(composer.slashMenu('/plan the thing'), [], 'an argument closes the menu');
  assert.deepEqual(composer.slashMenu('hello /plan'), [], 'only at the start');
  const skills = [composer.skillRow({ id: 's1', name: 'Frontend Design' })];
  assert.equal(composer.slashMenu('/skill:fr', skills)[0].id, 'skill:frontend-design');
});

test('a typed command parses with its argument; unknown text is a message', () => {
  const parsed = composer.parseSlash('/plan ship the importer');
  assert.equal(parsed.command.id, 'plan');
  assert.equal(parsed.arg, 'ship the importer');
  assert.equal(composer.parseSlash('/sh ls').command.id, 'shell');
  assert.equal(composer.parseSlash('/nope'), null);
  assert.equal(composer.parseSlash('not a command'), null);
});

test('Interview -> Plan -> Implement -> Review is a flow each step names', () => {
  assert.equal(composer.nextStep('interview').id, 'plan');
  assert.equal(composer.nextStep('plan').id, 'implement');
  assert.equal(composer.nextStep('implement').id, 'review');
  assert.equal(composer.nextStep('review'), null, 'the flow ends at review');
  for (const cmd of composer.SLASH) {
    if (cmd.next) assert.ok(composer.parseSlash('/' + cmd.next), `${cmd.id} points at a real command`);
  }
});

test('every command the menu offers has a branch or a mode in ChatScreen', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  for (const cmd of composer.SLASH) {
    if (cmd.mode || cmd.insertText) continue;
    assert.match(chat, new RegExp(`case '${cmd.id}':`), `/${cmd.id} does something`);
  }
});

// ---- @ -------------------------------------------------------------------------

test('@ finds the word under the caret and completes it in place', () => {
  assert.deepEqual(composer.mentionAt('ask @qw', 7), { start: 4, query: 'qw' });
  assert.equal(composer.mentionAt('mail me@example', 15), null, 'an address is not a mention');
  assert.equal(composer.mentionAt('@a b', 4), null, 'after a space the mention is over');
  const done = composer.completeMention('ask @qw now', 4, 7, '@qwen3');
  assert.equal(done.text, 'ask @qwen3 now');
  assert.equal(done.caret, 10);
});

test('the @ menu ranks across kinds and matches words anywhere', () => {
  const sources = [
    { kind: 'file', id: 'qwen-notes.md', label: 'qwen-notes.md' },
    { kind: 'model', id: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b' },
    { kind: 'mcp', id: 'docs', label: 'docs' },
  ];
  assert.equal(composer.mentionMenu('qwen', sources)[0].kind, 'model', 'a model outranks a file at the same match');
  assert.equal(composer.mentionMenu('qwen coder', sources)[0].id, 'qwen2.5-coder:7b');
  assert.deepEqual(composer.mentionMenu('zzz', sources), []);
  assert.equal(composer.mentionMenu('', sources).length, 3);
});

// ---- the thread ----------------------------------------------------------------

test('/copy and /export carry the tool calls and their results', () => {
  const md = composer.threadMarkdown({
    title: 'T',
    messages: [
      { role: 'user', content: 'find it' },
      { role: 'assistant', model: 'm', content: 'found', tools: [{ name: 'web_search', status: 'done', args: { q: 'x' }, result: 'r1' }] },
    ],
  });
  assert.match(md, /^# T/);
  assert.match(md, /Tool `web_search`/);
  assert.match(md, /"q": "x"/);
  assert.match(md, /r1/);
});

test('Up recalls the last message without its attachment', () => {
  assert.equal(composer.lastUserText([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'second\n\n--- attached ---\nbig' },
  ]), 'second');
  assert.equal(composer.lastUserText([]), '');
});

test('shell output is shown in the thread but rides the next message to the model', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /export function turnsFor\(/);
  assert.match(chat, /if \(m\.note\)/, 'notes are never sent as turns');
  assert.match(chat, /Command output from the open folder/);
  assert.match(chat, /const turns = turnsFor\(history\)/);
  assert.match(chat, /const turns = turnsFor\(msgs\)/, 'retry sends the same turns');
});

test('Plan mode is offered only tools that change nothing', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /active\.mode !== 'plan' \|\| \(!toolsLib\.ASKS\[t\.function\.name\] && !t\.function\.name\.startsWith\('mcp__'\)\)/);
});

// ---- destinations ----------------------------------------------------------------

test('five destinations, and every view lives in exactly one', () => {
  const sidebar = read('desktop', 'src', 'Sidebar.tsx');
  const block = sidebar.slice(sidebar.indexOf('export const SUB_VIEWS'), sidebar.indexOf('];', sidebar.indexOf('export const SUB_VIEWS')));
  const rows = [...block.matchAll(/\{ id: '([a-z]+)', label: '[^']+', parent: '([a-z]+)' \}/g)].map((m) => ({ id: m[1], parent: m[2] }));
  const views = ['chat', 'code', 'design', 'library', 'settings', 'build', 'local', 'files', 'images'];
  assert.deepEqual(rows.map((r) => r.id).sort(), views.slice().sort(), 'every former screen is still reachable');
  const parents = new Set(rows.map((r) => r.parent));
  assert.deepEqual([...parents].sort(), ['chat', 'code', 'design', 'library', 'settings']);
  const commands = require('../desktop/src/commands.js');
  for (const view of views) {
    assert.ok(commands.COMMANDS.some((c) => c.palette === view), `Ctrl+K reaches ${view}`);
  }
});
