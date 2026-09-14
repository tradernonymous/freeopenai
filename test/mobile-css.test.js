// The mobile fixes live in CSS and one matchMedia, where a refactor can undo
// them without any test noticing — the page boots fine and looks wrong only on
// a phone. These pin the properties at the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// The one prelude that names a small screen. A landscape phone is normally
// wider than 640px -- 844x390 is typical -- so keying the ergonomic fixes to
// width alone left it with a mouse-sized UI. Both conditions are named here,
// and the JS reads the same string.
const SMALL_CONDITION = '(max-width: 640px), (max-height: 520px) and (orientation: landscape)';
const SMALL_PRELUDE = '@media ' + SMALL_CONDITION;
const SMALL = HTML.slice(HTML.indexOf(SMALL_PRELUDE), HTML.indexOf('@media (max-width: 380px)'));
const LANDSCAPE = HTML.slice(HTML.indexOf('@media (max-height: 520px) and (orientation: landscape) {'));

// Every `selector { ... }` pair inside a media block, so an assertion can ask
// about a rule rather than about a slice of text that a reorder would move.
// Comments go first: a trailing comment would otherwise be read as part of the
// next rule's selector list, and an exact-match assertion would miss.
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(clean))) {
    out.push({
      selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
      body: m[2],
    });
  }
  return out;
}

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

test('CSS and JS name the same small screen, and the JS adds nothing of its own', () => {
  // The JS that decides whether a side panel starts open has to answer the same
  // question the CSS just answered, or a phone rotated into landscape opens a
  // cover over the chat. It drifted before by carrying a (hover: none) test the
  // CSS does not have, which is how a short landscape window got an overlay
  // that started open.
  const declared = HTML.match(/const SMALL_SCREEN_QUERY = '([^']+)'/);
  assert.ok(declared, 'SMALL_SCREEN_QUERY is gone -- re-point this test');
  assert.equal(declared[1], SMALL_CONDITION, 'the JS condition and the CSS prelude have drifted apart');

  const fn = HTML.match(/function isNarrowScreen\(\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(fn, 'isNarrowScreen is gone -- re-point this test');
  assert.match(fn[0], /matchMedia\(SMALL_SCREEN_QUERY\)/, 'isNarrowScreen must read the shared condition');
  assert.doesNotMatch(fn[0], /hover:\s*none/, 'the CSS has no pointer test here, so the JS must not invent one');
});

test('a landscape phone gets the off-canvas drawers, not a third of the screen', () => {
  // The off-canvas shape is shared by both small screens, so it lives in the
  // shared block; the landscape block only narrows the share of the width.
  assert.match(SMALL, /\.history-sidebar\s*\{[^}]*position:\s*absolute; top: 0; bottom: 0; left: 0/);
  assert.match(SMALL, /\.chat-shell\.history-hidden \.history-sidebar\s*\{[^}]*translateX\(-102%\)/);
  assert.match(SMALL, /\.session-panel\s*\{[^}]*position:\s*absolute; top: 0; bottom: 0; right: 0/);
  assert.match(SMALL, /\.chat-shell\.session-hidden \.session-panel\s*\{[^}]*translateX\(102%\)/);
  assert.match(SMALL, /\.history-scrim\s*\{[^}]*display:\s*block/);
  assert.match(SMALL, /\.session-scrim\s*\{[^}]*display:\s*block/);
  assert.match(SMALL, /\.chat-shell\.history-hidden \.history-scrim\s*\{[^}]*pointer-events:\s*none/);
  assert.match(SMALL, /\.chat-shell\.session-hidden \.session-scrim\s*\{[^}]*pointer-events:\s*none/);

  assert.ok(LANDSCAPE.length > 0, 'the landscape block is gone -- re-point this test');
  assert.match(LANDSCAPE, /\.history-sidebar,[\s\S]*?width: 34%/);
  assert.match(LANDSCAPE, /\.session-panel,[\s\S]*?width: 34%/);
});

test('every field resists the iOS focus zoom, in both orientations', () => {
  // iOS zooms any focused field under 16px, which turns a dropdown into a
  // zoomed viewport. The composer's fields had the guard in the portrait block;
  // the settings and GitHub ones did not, so a phone zoomed them on focus.
  const guarded = rules(SMALL)
    .filter((r) => /font-size:\s*16px/.test(r.body))
    .flatMap((r) => r.selectors);
  for (const field of [
    '.composer-input',
    '.effort-select',
    '#providerSelect',
    '.settings-row select',
    '.github-browser-row select',
    '.github-browser-row input',
    '#githubFileContent',
    '.model-dropdown-search',
    '.palette input',
    '.mask-prompt',
  ]) {
    assert.ok(
      guarded.includes(field),
      `${field} needs the 16px guard inside the shared small-screen block`,
    );
  }
});

test('every control in the composer row is one height on a small screen', () => {
  // A 44px select beside a 40px model chip beside a 30px automatic chip: three
  // heights in one row is most of what made a phone toolbar look assembled
  // rather than designed.
  const row = ['.model-trigger', '.effort-chip', '.mode-chip', '.session-chip', '.effort-select', '#providerSelect'];
  const covered = rules(SMALL)
    .filter((r) => /min-height:\s*var\(--touch\)/.test(r.body))
    .flatMap((r) => r.selectors);
  for (const sel of row) {
    assert.ok(covered.includes(sel), `${sel} must be a finger target in the shared layer`);
  }
  // Landscape goes one notch shorter -- the whole strip together, rather than
  // one control at a time.
  const shortened = rules(LANDSCAPE)
    .filter((r) => /min-height:\s*38px/.test(r.body))
    .flatMap((r) => r.selectors);
  for (const sel of row) {
    assert.ok(shortened.includes(sel), `${sel} must shorten with the rest of the strip in landscape`);
  }
  // And the one native widget in the row shares the control radius.
  const select = HTML.match(/\n        \.effort-select \{[^}]*\}/);
  assert.ok(select, '.effort-select is gone -- re-point this test');
  assert.match(select[0], /border-radius: var\(--ctl-r\)/);
});

test('a finger-sized target is one number, not a scatter of 44px literals', () => {
  assert.match(HTML, /--touch:\s*44px/, 'the touch token is gone -- re-point this test');
  const sized = rules(SMALL).filter((r) => /min-height:\s*var\(--touch\)/.test(r.body));
  assert.ok(sized.length, 'the shared block must size its selects with var(--touch)');
  assert.match(SMALL, /\.settings-row select\s*\{[^}]*min-height:\s*var\(--touch\)/);
});

test('a screen with no hover reveals its own delete controls', () => {
  // The history delete and the todo remove are hover-only by default, which on
  // a touchscreen is never. Keyed to the pointer rather than the width, because
  // a touchscreen laptop has no hover either.
  const noHover = HTML.match(/@media \(hover: none\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(noHover, 'the (hover: none) block is gone -- re-point this test');
  assert.match(noHover[0], /\.history-item \.history-delete, \.todo-remove\s*\{\s*opacity:\s*1/);
});

test('the bar height is a token, so no block can set a different one by hand', () => {
  assert.match(HTML, /--bar-h:\s*44px/);
  assert.match(HTML, /\.chat-bar\s*\{[^}]*height:\s*var\(--bar-h\)/);
  assert.match(SMALL, /:root\s*\{\s*--bar-h:\s*52px/);
  assert.match(LANDSCAPE, /:root\s*\{\s*--bar-h:\s*46px/);
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
