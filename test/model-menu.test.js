// The model menu was anchored to a trigger in the composer toolbar, which
// scrolls its own contents, so an absolutely positioned menu was clipped by it
// and ran off the bottom of the screen: about one row of a long list was
// reachable. The placement maths lives in chatlib so it can be checked here
// rather than by eye in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  placeDropdown,
  MODEL_MENU_MAX_HEIGHT,
} = require('../chatlib.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// The composer sits at the foot of the window, which is the whole reason the
// menu cannot open downward.
const COMPOSER_TRIGGER = { top: 918, bottom: 946, right: 609, left: 400 };
const DESKTOP = { width: 870, height: 1000 };

test('the menu opens upward from a trigger at the foot of the window', () => {
  const spot = placeDropdown(COMPOSER_TRIGGER, DESKTOP);
  assert.equal(spot.openUp, true);
  assert.equal(spot.top, null, 'nothing is placed below the trigger');
  assert.equal(spot.bottom, 1000 - 918 + 6, 'measured up from the trigger');
  // Everything it asks for has to fit in the window, or the last rows are
  // unreachable again.
  assert.ok(spot.bottom + spot.maxHeight <= DESKTOP.height, 'the whole menu fits above the trigger');
  assert.equal(spot.maxHeight, MODEL_MENU_MAX_HEIGHT);
});

test('it still opens downward when there is genuinely more room below', () => {
  const trigger = { top: 100, bottom: 128, right: 400, left: 200 };
  const spot = placeDropdown(trigger, { width: 900, height: 1000 });
  assert.equal(spot.openUp, false);
  assert.equal(spot.bottom, null);
  assert.equal(spot.top, 134, 'just under the trigger');
  assert.ok(spot.top + spot.maxHeight <= 1000);
});

test('a trigger in the middle of a tall window prefers downward', () => {
  // Both sides are roomy; flipping up here would be a surprise, not a fix.
  const spot = placeDropdown({ top: 450, bottom: 478, right: 400, left: 200 }, { width: 900, height: 1000 });
  assert.equal(spot.openUp, false);
});

test('the menu is never taller than the space it has', () => {
  // A short window above the trigger: better a little menu than one running off
  // the top of the screen.
  const spot = placeDropdown({ top: 200, bottom: 228, right: 400, left: 200 }, { width: 900, height: 300 });
  assert.ok(spot.maxHeight <= 200 - 6 - 8, `expected at most ${200 - 14}, got ${spot.maxHeight}`);
  // And it bottoms out at the minimum rather than collapsing to nothing.
  const roomy = placeDropdown(COMPOSER_TRIGGER, DESKTOP);
  assert.ok(roomy.maxHeight >= 180);
});

test('the menu stays inside the window horizontally', () => {
  // A trigger hard against the right edge of a narrow window is the case that
  // pushed the old menu off screen.
  const rightEdge = placeDropdown({ top: 500, bottom: 528, right: 386, left: 200 }, { width: 390, height: 800 });
  assert.ok(rightEdge.left >= 0, 'not off the left edge');
  assert.ok(rightEdge.left + rightEdge.width <= 390, 'not off the right edge');
  assert.ok(rightEdge.width <= 390 - 16);
  // A trigger nearer the left edge is what actually needs the clamp: aligning
  // the menu's right edge to it lands the menu off the left of the window.
  const leftEdge = placeDropdown({ top: 500, bottom: 528, right: 60, left: 8 }, { width: 390, height: 800 });
  assert.ok(leftEdge.left >= 0, `pulled back onto the screen, got ${leftEdge.left}`);
  assert.ok(leftEdge.left + leftEdge.width <= 390, 'and not shoved off the other side');
});

test('it survives a trigger or viewport it cannot measure', () => {
  // Called on resize and on open; a missing measurement must not throw mid-turn.
  for (const spot of [placeDropdown(null, null), placeDropdown(undefined, DESKTOP), placeDropdown(COMPOSER_TRIGGER, {})]) {
    assert.ok(Number.isFinite(spot.left) && Number.isFinite(spot.width) && Number.isFinite(spot.maxHeight));
  }
});

test('an offset margin configuration is honoured', () => {
  const spot = placeDropdown(COMPOSER_TRIGGER, DESKTOP, { margin: 20, gap: 12, width: 300 });
  assert.equal(spot.width, 300);
  assert.equal(spot.bottom, 1000 - 918 + 12);
  assert.ok(spot.left >= 20);
});

// The cause, not just the symptom: the menu is clipped by the toolbar it hangs
// from whenever it is absolutely positioned inside it, however good the maths.
test('the model menu is fixed to the viewport, never absolute in the toolbar', () => {
  const blocks = [...HTML.matchAll(/\.model-dropdown\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(blocks.length, 'index.html no longer styles .model-dropdown -- re-point this test');
  for (const block of blocks) {
    assert.match(block, /position:\s*fixed/, `a .model-dropdown rule is not fixed to the viewport: ${block.trim().slice(0, 80)}`);
    assert.doesNotMatch(block, /position:\s*absolute/);
  }
  // And nothing may position it with viewport-unit offsets that ignore the
  // trigger, which is what sent it off the bottom of the screen.
  assert.doesNotMatch(HTML, /\.model-dropdown\s*\{[^}]*top:\s*calc\(100%\s*\+\s*6px\)/);
});

test('opening the menu computes its placement rather than relying on CSS alone', () => {
  // A menu that is never placed falls back to the stylesheet's guess, which is
  // how the first version ended up clipped with no way to reach the rest.
  const open = HTML.match(/function openModelDropdown\(\)\s*\{([\s\S]*?)\n        \}/);
  assert.ok(open, 'index.html no longer defines openModelDropdown() -- re-point this test');
  assert.match(open[1], /positionModelDropdown\(\)/, 'openModelDropdown must position the menu it opens');
  // Both popups share the one resize listener, so a rotated phone re-places
  // whichever of them is open.
  assert.match(
    HTML,
    /window\.addEventListener\('resize',[\s\S]{0,120}positionModelDropdown\(\);/,
    'and re-place it when the window changes',
  );
});
