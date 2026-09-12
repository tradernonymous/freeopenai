// The attach menu opened invisibly. It was positioned above the paperclip, and
// the row it lives in scrolls horizontally on a phone — a scroll container clips
// anything outside its own box, which is exactly where a menu above the trigger
// sits. Clicking the paperclip therefore did nothing at all, on every screen
// size, while the page booted fine and lint passed.
//
// Two halves have to stay true together for this to work, so both are pinned:
// the menu is fixed to the viewport, and the row that would clip it still
// scrolls. Plus the placement itself, which is now the only thing deciding
// where it lands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  placeDropdown,
  ATTACH_MENU_WIDTH,
  ATTACH_MENU_MIN_HEIGHT,
  ATTACH_MENU_MAX_HEIGHT,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the attach menu is fixed to the viewport, not trapped in the scrolling row', () => {
  const block = HTML.match(/\.attach-menu\s*\{[^}]*\}/);
  assert.ok(block, '.attach-menu is gone -- re-point this test');
  assert.match(block[0], /position:\s*fixed/, 'an absolutely positioned menu here is clipped by the controls row');
  assert.doesNotMatch(block[0], /position:\s*absolute/);

  // The reason it must be fixed, asserted rather than described: without the
  // scrolling row there would be nothing to clip it.
  const controls = HTML.match(/\.composer-controls\s*\{[^}]*\}/);
  assert.ok(controls, '.composer-controls is gone -- re-point this test');
  assert.match(controls[0], /overflow-x:\s*auto/);

  // And the trigger really is inside that row, or the two facts never meet.
  const row = HTML.indexOf('class="composer-controls"');
  const trigger = HTML.indexOf('id="attachTrigger"');
  const menu = HTML.indexOf('id="attachMenu"');
  assert.ok(row !== -1 && trigger > row && menu > trigger, 'the menu must still live inside the scrolling row for this test to mean anything');
});

test('opening the menu places it, and a resize re-places it', () => {
  const open = HTML.match(/function openAttachMenu\(\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(open, 'openAttachMenu is gone -- re-point this test');
  assert.match(open[0], /positionAttachMenu\(\)/, 'the CSS fallback is not a real position');
  // The same treatment the model menu already gets: a rotated phone moves the
  // trigger out from under an open menu.
  assert.match(HTML, /addEventListener\('resize',[\s\S]{0,120}positionModelDropdown\(\);[\s\S]{0,120}positionAttachMenu\(\);/);
});

const NAMES = ['positionAttachMenu'];

function harness({ open = true, rect = { left: 20, right: 64, top: 796, bottom: 840 }, view = { width: 1100, height: 900 } } = {}) {
  const written = {};
  const deps = {
    // The real geometry helper, so this exercises the shipped placement rather
    // than a description of it.
    placeDropdown,
    ATTACH_MENU_WIDTH,
    ATTACH_MENU_MIN_HEIGHT,
    ATTACH_MENU_MAX_HEIGHT,
    attachMenu: {
      classList: { contains: () => open },
      style: new Proxy(
        {},
        {
          set(_target, prop, value) {
            written[prop] = value;
            return true;
          },
        },
      ),
    },
    attachTrigger: { getBoundingClientRect: () => rect },
    window: { innerWidth: view.width, innerHeight: view.height },
  };
  return { written, deps, ...loadFromIndex(NAMES, deps) };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('the menu opens above the paperclip, left-aligned to it', () => {
  const h = harness();
  h.positionAttachMenu();
  assert.equal(h.written.left, '20px', 'anchored to the trigger, not mirrored to its right edge');
  assert.equal(h.written.right, 'auto');
  assert.equal(h.written.width, ATTACH_MENU_WIDTH + 'px');
  assert.equal(h.written.maxWidth, ATTACH_MENU_WIDTH + 'px');
  assert.equal(h.written.maxHeight, ATTACH_MENU_MAX_HEIGHT + 'px');
  // Upward: below the composer there is only the edge of the screen.
  assert.equal(h.written.top, 'auto');
  assert.equal(h.written.bottom, '110px');
});

test('a menu that will not fit above opens downward instead of off-screen', () => {
  // A phone in landscape: the composer sits near the top and there is almost no
  // room above it.
  const h = harness({ rect: { left: 20, right: 64, top: 20, bottom: 64 }, view: { width: 800, height: 380 } });
  h.positionAttachMenu();
  assert.equal(h.written.bottom, 'auto');
  assert.equal(h.written.top, '70px');
  assert.ok(parseInt(h.written.maxHeight, 10) > 0, 'and it is never given a nonsense height');
});

test('a closed menu is not placed at all', () => {
  const h = harness({ open: false });
  h.positionAttachMenu();
  assert.deepEqual(h.written, {});
});

test('a placement that would hang off the side is pulled back inside the window', () => {
  const h = harness({ rect: { left: 300, right: 344, top: 796, bottom: 840 }, view: { width: 375, height: 800 } });
  h.positionAttachMenu();
  const left = parseInt(h.written.left, 10);
  const width = parseInt(h.written.width, 10);
  assert.ok(left >= 8);
  assert.ok(left + width <= 375 - 8);
  assert.ok(width <= 375 - 16);
});
