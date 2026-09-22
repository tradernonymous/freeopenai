// The command palette (Ctrl+K). Before it, the whole keyboard story was
// Alt+1..6, and every panel was reachable only by finding its button. The rules
// tested here are the ones a user feels: a fragment finds the screen, word order
// does not matter, a chat and a skill are as reachable as a button, and the best
// match is first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const commands = require('../desktop/src/commands.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const SCREENS = ['chat', 'code', 'images', 'build', 'local', 'design', 'library', 'files', 'evals', 'agents', 'recipes', 'parallel', 'settings'];

test('the registry is well formed', () => {
  assert.ok(commands.COMMANDS.length >= 10, 'the palette covers more than the sidebar');
  const ids = commands.COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const entry of commands.COMMANDS) {
    assert.ok(entry.group && entry.title, `${entry.id} needs a group and a title`);
    assert.ok(entry.hint, `${entry.id} should say what it does`);
    if (entry.palette) {
      assert.ok(SCREENS.includes(entry.palette), `${entry.id} points at a real screen`);
    }
  }
  // Every screen is reachable from the keyboard.
  for (const screen of SCREENS) {
    assert.ok(
      commands.COMMANDS.some((c) => c.palette === screen),
      `${screen} has a palette entry`,
    );
  }
});

test('an empty query lists the surface, capped so the list stays scannable', () => {
  const results = commands.search('');
  assert.equal(results.length, commands.MAX_RESULTS);
  assert.equal(results[0].id, 'go-chat');
});

test('a fragment finds the screen, wherever it is in the name', () => {
  assert.equal(commands.search('imag')[0].id, 'go-images');
  assert.equal(commands.search('sett')[0].id, 'go-settings');
  assert.equal(commands.search('dark')[0].id, 'toggle-theme', 'the hint is searchable too');
});

test('word order does not matter, and words may come from title or hint', () => {
  assert.equal(commands.search('gen pic')[0].id, 'go-images', 'words out of order, from the hint');
  assert.equal(commands.search('new chat')[0].id, 'new-chat');
  // Every word has to land somewhere: a query with a word nothing matches is
  // not a weak match, it is no match.
  assert.deepEqual(commands.search('images zzz'), []);
});

test('nothing matching is an empty list, not everything', () => {
  assert.deepEqual(commands.search('zqx'), []);
});

test('a chat and a skill are row-shaped without the palette knowing what they are', () => {
  const chat = commands.chatCommand({ id: 'c1', title: 'Refactor the parser' });
  assert.equal(chat.group, 'Chats');
  assert.equal(chat.chat, 'c1');
  const skill = commands.skillCommand({ id: 'review', name: 'Review' });
  assert.equal(skill.group, 'Skills');
  assert.equal(skill.skill, 'review');
  // And they are searchable alongside the fixed commands.
  const found = commands.search('refactor', { extra: [chat] });
  assert.equal(found[0].id, 'open-chat:c1');
  const bySkill = commands.search('review', { extra: [skill] });
  assert.equal(bySkill[0].id, 'open-skill:review');
});

test('a title match outranks a mention in a hint', () => {
  const extra = [commands.chatCommand({ id: 'c9', title: 'Design notes' })];
  const results = commands.search('design', { extra });
  assert.equal(results[0].id, 'go-design', 'the screen named Design wins');
});

test('every command in the registry actually resolves to something', () => {
  const shell = read('desktop', 'src', 'App.tsx');
  // A palette row that matches nothing is a dead entry: the list promises an
  // action and the shell silently does nothing. Every id is therefore either a
  // screen (palette), a chat, a skill, or has its own branch in the shell.
  for (const entry of commands.COMMANDS) {
    if (entry.palette || entry.chat || entry.skill) continue;
    assert.match(
      shell,
      new RegExp(`case '${entry.id}':`),
      `${entry.id} is listed in the palette but the shell has no branch for it`,
    );
  }
});

test('the palette is wired: Ctrl+K opens it, every action resolves', () => {
  const shell = read('desktop', 'src', 'App.tsx');
  // Keys come from one table (src/keymap.js); the shell only acts on the answer.
  const keymap = require('../desktop/src/keymap.js');
  assert.ok(keymap.BINDINGS.some((b) => b.id === 'palette' && b.keys === 'Ctrl+K'), 'Ctrl+K is bound');
  assert.match(shell, /keymap\.resolveKey\(/, 'the shell asks the resolver');
  assert.match(shell, /case 'palette': setPaletteOpen\(\(open\) => !open\)/, 'and it toggles');
  assert.match(shell, /<CommandPalette/, 'the palette is mounted');
  assert.match(shell, /openPalette/, 'and the sidebar/status bar can open it');
  // Every action key in the registry has a branch in the shell (or navigates).
  const palette = read('desktop', 'src', 'components', 'CommandPalette.tsx');
  assert.match(palette, /commands\.search\(query/, 'matching goes through the module, not the component');
  assert.match(palette, /ArrowDown|ArrowUp/, 'the list is walkable from the keyboard');
  assert.match(palette, /Escape/, 'and closable');
});
