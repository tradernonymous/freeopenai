// NEURA-040 for the Android app: test/backlog.test.js already proves every
// TODO(NEURA-xxx) marker anywhere names an open backlog item, but its "no
// bare TODO" rule covers only the desktop, shared/ and server.js. The Android
// sources get the same rule here: open work is a docs/BACKLOG.md row (and a
// TODO(NEURA-xxx) marker at the spot), never a TODO nobody tracks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ANDROID = path.join(__dirname, '..', 'android', 'app', 'src');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(kt|kts|xml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the Android sources carry no bare TODO comments', () => {
  const files = walk(ANDROID, []);
  assert.ok(files.length > 50, 'the Android sources were found, so this test is checking something');
  const bare = /(?:\/\/|\/\*|<!--)\s*(?:TODO|FIXME)(?!\(NEURA-\d{3}\))\b/;
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!bare.test(line), `${path.relative(path.join(__dirname, '..'), file)}:${i + 1} has a TODO without a backlog id`);
    });
  }
});
