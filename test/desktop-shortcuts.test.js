// The Alt+N shortcuts. README said Alt+1…6, docs/desktop.md said Alt+1…7
// without Code, the palette said Images was Alt+2 and Settings Alt+7, and the
// sidebar (the thing the shell actually listens to) said Code was Alt+2 and
// Settings Alt+8. One list now: NAV_ITEMS in src/Sidebar.tsx. Everything else
// is derived from it or, for prose, held to it here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// The sidebar is TypeScript, so the list is read out of the source rather than
// required: one row per `{ id: 'x', label: 'Y', icon: 'z', keys: 'Alt+N' }`.
function navItems() {
  const source = read('desktop', 'src', 'Sidebar.tsx');
  const block = source.slice(source.indexOf('export const NAV_ITEMS'), source.indexOf('];', source.indexOf('export const NAV_ITEMS')));
  const rows = [];
  const row = /\{ id: '([a-z]+)', label: '([^']+)', icon: '[a-z]+', keys: '([^']+)' \}/g;
  let m;
  while ((m = row.exec(block))) rows.push({ id: m[1], label: m[2], keys: m[3] });
  return rows;
}

test('the sidebar list is the source, and every key on it is unique', () => {
  const items = navItems();
  // Five destinations (Phase 2.6); the other views are their tabs.
  assert.equal(items.length, 5, `found ${items.length} destinations`);
  const keys = items.map((i) => i.keys);
  assert.equal(new Set(keys).size, keys.length, 'two screens share a key');
  for (const key of keys) assert.match(key, /^Alt\+[1-9A-Z]$/);
});

test('the shell listens for the keys the sidebar shows, not a second list', () => {
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /navForKey\(e\.key\)/);
  assert.ok(!/const order: View\[\] = \[/.test(app), 'App.tsx must not carry its own screen order');
  assert.match(app, /keys=\{navKeys\(\)\}/, 'the palette is handed the same keys');
});

test('the palette writes no Alt keys of its own', () => {
  const commands = require('../desktop/src/commands.js');
  const source = read('desktop', 'src', 'commands.js');
  assert.ok(!/keys: 'Alt\+/.test(source), 'commands.js must not hard-code Alt keys');
  const items = navItems();
  for (const item of items) {
    assert.ok(commands.COMMANDS.some((c) => c.id === `go-${item.id}` && c.palette === item.id), `palette has go-${item.id}`);
  }
  const keys = Object.fromEntries(items.map((i) => [i.id, i.keys]));
  const settings = commands.search('settings', { keys }).find((c) => c.id === 'go-settings');
  assert.equal(settings.keys, keys.settings);
  const bare = commands.search('settings', {}).find((c) => c.id === 'go-settings');
  assert.equal(bare.keys, undefined);
});

test('README and docs/desktop.md say what the sidebar says', () => {
  const items = navItems();
  const docs = read('docs', 'desktop.md');
  for (const item of items) {
    assert.ok(docs.includes(`| \`${item.keys}\` | ${item.label} |`), `docs/desktop.md lists ${item.keys} → ${item.label}`);
  }
  const numbered = items.filter((i) => /^Alt\+\d$/.test(i.keys)).map((i) => Number(i.keys.slice(4)));
  const top = Math.max(...numbered);
  assert.ok(read('README.md').includes(`\`Alt+1…${top}\``), `README says Alt+1…${top}`);
  assert.ok(!/Alt\+1[….]+[0-9]/.test(docs.replace(new RegExp(`Alt\+1…${top}`, 'g'), '')), 'docs carry no other Alt range');
});
