// The radial menu: where it opens, and that it closes.
//
// A ring that opens half off-screen is worse than a dropdown, because the
// action the user wanted is the one that got clipped. The placement rule is
// pure, so it is checked here rather than by right-clicking near an edge and
// hoping somebody notices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const radial = require('../desktop/src/radial.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('the first item sits straight above the pointer and the rest follow clockwise', () => {
  const ring = radial.place({ x: 500, y: 400, count: 4, viewportWidth: 1200, viewportHeight: 900 });
  assert.equal(ring.items.length, 4);
  const first = ring.items[0];
  assert.ok(Math.abs(first.x - ring.cx) < 0.001, 'the first item is directly above the centre');
  assert.ok(first.y < ring.cy, 'above, not below');
  const gaps = ring.items.slice(1).map((point, i) => point.angle - ring.items[i].angle);
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - gaps[0]) < 0.001, 'the ring is evenly spaced: an action is always in the same place');
  }
});

test('the ring moves inside the window instead of being clipped by it', () => {
  const ring = radial.place({ x: 2, y: 3, count: 5, viewportWidth: 1000, viewportHeight: 700 });
  const half = ring.itemSize / 2;
  for (const point of ring.items) {
    assert.ok(point.x - half >= 0, 'no item hangs off the left edge');
    assert.ok(point.y - half >= 0, 'no item hangs off the top edge');
  }
  const far = radial.place({ x: 998, y: 697, count: 5, viewportWidth: 1000, viewportHeight: 700 });
  for (const point of far.items) {
    assert.ok(point.x + half <= 1000, 'no item hangs off the right edge');
    assert.ok(point.y + half <= 700, 'no item hangs off the bottom edge');
  }
});

test('a window too small for the ring centres it rather than going negative', () => {
  const ring = radial.place({ x: 10, y: 10, count: 4, viewportWidth: 80, viewportHeight: 60 });
  assert.equal(ring.cx, 40);
  assert.equal(ring.cy, 30);
  assert.ok(ring.items.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test('an empty menu still has a place to be', () => {
  const ring = radial.place({ x: 400, y: 300, count: 0, viewportWidth: 800, viewportHeight: 600 });
  assert.deepEqual(ring.items, []);
  assert.equal(ring.cx, 400, 'the pointer is still the centre when there is nothing to draw');
});

test('right-click in chat opens the ring, and every way out closes it', () => {
  const screen = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(screen, /onContextMenu=\{onMessagesContextMenu\}/, 'the transcript listens for right-click');
  assert.match(screen, /setRadial\(\{ x: e\.clientX, y: e\.clientY, items \}\)/, 'the ring opens where the pointer is');
  assert.match(screen, /<RadialMenu/, 'and it is mounted');
  assert.match(screen, /onClose=\{\(\) => setRadial\(null\)\}/, 'with a way to dismiss it');

  const menu = read('desktop', 'src', 'components', 'RadialMenu.tsx');
  assert.match(menu, /event\.key === 'Escape'/, 'Escape closes it');
  assert.match(menu, /radial\.place\(/, 'placement goes through the tested module');
  assert.match(menu, /role="menu"/, 'and it is a menu to assistive technology');
  assert.match(menu, /firstRef\.current\?\.focus\(\)/, 'the keyboard lands on the first action');

  // The actions the ring offers are about what was clicked, not about the app.
  for (const label of ['Copy', 'Explain', 'Rework']) {
    assert.match(screen, new RegExp(`label: '${label}'`), `${label} is one of the ring's actions`);
  }
});
