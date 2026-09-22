// NEURA-040: docs/BACKLOG.md and the code agree. Every `TODO(NEURA-xxx)`
// marker names an item that is still open in the backlog; an item moved to
// Done leaves no marker behind; and the surfaces this repo's desktop session
// owns carry no bare TODO comments -- open work is a backlog row, not a
// note nobody tracks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKLOG = fs.readFileSync(path.join(ROOT, 'docs', 'BACKLOG.md'), 'utf8').replace(/\r\n/g, '\n');

// Rows above the "## Done" heading are open; ids in Done are closed.
const [openPart, donePart = ''] = BACKLOG.split(/\n## Done\b/);
const idsIn = (text) => new Set((text.match(/^\| (NEURA-\d{3}) \|/gm) || []).map((row) => row.slice(2, 11)));
const OPEN = idsIn(openPart);
const CLOSED = new Set((donePart.match(/NEURA-\d{3}/g) || []));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'gen', 'build', '.gradle', 'workspace']);
const CODE = /\.(js|ts|tsx|rs|kt|kts|css|html|yml|yaml|sh)$/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.maestro') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = walk(ROOT, []).filter((f) => !f.endsWith(path.join('test', 'backlog.test.js')));
// A marker is a comment: // TODO(NEURA-012) or /* TODO(NEURA-012) or # TODO(NEURA-012).
const MARKER = /(?:\/\/|\/\*|#)\s*TODO\((NEURA-\d{3})\)/g;

test('the backlog has open items and ids are unique', () => {
  assert.ok(OPEN.size > 0, 'open items were parsed');
  const rows = openPart.match(/^\| (NEURA-\d{3}) \|/gm) || [];
  assert.equal(rows.length, OPEN.size, 'no id appears twice among open items');
  for (const id of OPEN) assert.ok(!CLOSED.has(id), `${id} is both open and done`);
});

test('every TODO(NEURA-xxx) marker names an open backlog item', () => {
  const found = [];
  for (const file of FILES) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(MARKER)) found.push({ id: m[1], file: path.relative(ROOT, file) });
  }
  assert.ok(found.length > 0, 'at least one marker exists, so this test is checking something');
  for (const { id, file } of found) {
    assert.ok(OPEN.has(id), `${file}: ${id} is not an open item in docs/BACKLOG.md`);
  }
});

test('the desktop, shared modules and engine carry no bare TODO comments', () => {
  const owned = FILES.filter((f) => {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    return rel.startsWith('desktop/src/') || rel.startsWith('desktop/src-tauri/src/') || rel.startsWith('shared/') || rel === 'server.js';
  });
  const bare = /(?:\/\/|\/\*)\s*TODO(?!\(NEURA-\d{3}\))\b/;
  for (const file of owned) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      assert.ok(!bare.test(line), `${path.relative(ROOT, file)}:${i + 1} has a TODO without a backlog id`);
    });
  }
});
