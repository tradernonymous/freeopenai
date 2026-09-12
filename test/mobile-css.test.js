// The mobile fixes live in CSS and one matchMedia, where a refactor can undo
// them without any test noticing — the page boots fine and looks wrong only on
// a phone. These pin the properties at the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the composer area never pads the bottom safe-area inset the body already pads', () => {
  // body { padding-bottom: env(safe-area-inset-bottom) } plus the same inset
  // again on .chat-input-area doubled the dead zone under the composer on
  // every phone with a home indicator.
  const blocks = [...HTML.matchAll(/\.chat-input-area\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(blocks.length >= 3, 'expected the base rule plus both media overrides -- re-point this test');
  for (const block of blocks) {
    assert.doesNotMatch(
      block,
      /safe-area-inset-bottom/,
      `.chat-input-area must not pad the inset the body already pads: ${block.trim()}`,
    );
  }
  // The body inset itself stays: it is the single source of the inset.
  assert.match(HTML, /body\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/);
});

test('a short landscape phone gets the off-canvas sidebar, not a third of the screen', () => {
  const landscape = HTML.match(/@media \(max-height: 520px\) and \(orientation: landscape\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(landscape, 'the landscape media block is gone -- re-point this test');
  assert.match(landscape[0], /\.history-sidebar\s*\{[^}]*position:\s*absolute/, 'the sidebar overlays instead of squeezing the transcript');
  assert.match(landscape[0], /\.history-scrim\s*\{[^}]*display:\s*block/, 'with the same scrim as portrait');
  assert.match(landscape[0], /\.chat-shell\.history-hidden \.history-sidebar\s*\{[^}]*translateX\(-102%\)/, 'and the same off-canvas hiding');
});

test('the open/closed default matches the screens where the sidebar overlays', () => {
  // The CSS says overlay for both (max-width: 640px) and short landscape; the
  // JS that decides whether the sidebar starts hidden must name both too, or
  // a landscape phone opens a cover over the chat it just rotated into.
  const fn = HTML.match(/function isNarrowScreen\(\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(fn, 'isNarrowScreen is gone -- re-point this test');
  assert.match(fn[0], /\(max-width: 640px\)/);
  assert.match(fn[0], /\(orientation: landscape\) and \(max-height: 520px\)/);
});

test('settings selects resist the iOS focus zoom on phones', () => {
  // iOS zooms any focused input under 16px; the composer inputs were already
  // guarded, the settings selects were not.
  const portrait = HTML.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(portrait, 'the portrait media block is gone -- re-point this test');
  assert.match(portrait[0], /\.settings-row select\s*\{[^}]*font-size:\s*16px/);
});

test('the chat card shrinks to the shell instead of overflowing it on a phone', () => {
  // .chat-card is a flex child of .chat-shell with the default min-width:auto.
  // The composer's toolbar is a row of flex-shrink:0 controls, so the card
  // refused to shrink below that toolbar's width on a phone, pushed the chat
  // bar's right edge (the menu button) past the viewport, and .chat-shell's
  // overflow:hidden clipped it. The toolbar scrolls now; the card must not
  // blow out to its min-content width.
  const block = HTML.match(/\.chat-card\s*\{[^}]*\}/);
  assert.ok(block, '.chat-card rule is gone -- re-point this test');
  assert.match(block[0], /min-width:\s*0/, 'the card must be allowed to shrink -- a refactor re-added min-width:auto');
});
