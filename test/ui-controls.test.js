// The control system, the settings rail and three UI bugs that a refactor would
// quietly bring back: an invisible user bubble in the light theme, reasoning
// text at 7px, and a backdrop-filter that paints a surface nobody can see
// through. None of these can fail a boot test -- they only show up as "the app
// looks wrong", which is what makes them worth pinning.
const test = require('node:test');
const assert = require('node:assert/strict');

const { HTML, loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

test('the three icon buttons are one rule, and it uses the control radius', () => {
  // .icon-btn, .menu-trigger-btn and .modal-close were three copies of the same
  // seven declarations, which is how a dialog's close button drifts away from
  // the button beside it in the bar.
  const base = HTML.match(/\.icon-btn, \.menu-trigger-btn, \.modal-close \{[^}]*\}/);
  assert.ok(base, 'the icon buttons no longer share one rule -- re-point this test');
  assert.match(base[0], /width: 32px; height: 32px/);
  assert.match(base[0], /border-radius: var\(--ctl-r\)/);
  assert.doesNotMatch(HTML, /\.modal-close \{ width: 32px/, 'a second copy of the rule is back');
});

test('a labelled button is the same control as a chip, only wider', () => {
  const labelled = HTML.match(/\.icon-btn-text \{[^}]*\}/);
  assert.ok(labelled, '.icon-btn-text is gone -- re-point this test');
  for (const token of ['height: var(--ctl-h)', 'border-radius: var(--ctl-r)', 'background: var(--ctl-bg)', 'border: 1px solid var(--ctl-edge)']) {
    assert.ok(labelled[0].includes(token), `.icon-btn-text must draw ${token} from the shared control tokens`);
  }
});

test('the reasoning is legible, and its summary is a real control', () => {
  // 7px reasoning text and a 9px summary were strays from a smaller type scale;
  // the summary is what you tap to open the scratchpad.
  const text = HTML.match(/\.reasoning-text \{[^}]*\}/);
  assert.ok(text, '.reasoning-text is gone -- re-point this test');
  const textSize = Number((text[0].match(/font-size:\s*([\d.]+)px/) || [])[1]);
  assert.ok(textSize >= 10, `reasoning text is ${textSize}px, which is not readable`);

  const summary = HTML.match(/\.message-reasoning > summary \{[^}]*\}/);
  assert.ok(summary, 'the reasoning summary is gone -- re-point this test');
  const summarySize = Number((summary[0].match(/font-size:\s*([\d.]+)px/) || [])[1]);
  assert.ok(summarySize >= 11, `the summary that opens it is ${summarySize}px`);
});

test('a user bubble is themed, not hard-coded white', () => {
  // The bubble is a tint over whatever surface is behind it. Hard-coded white
  // over the light theme's near-white surface left no bubble at all.
  const light = HTML.slice(HTML.indexOf('html[data-theme="light"] {'), HTML.indexOf('html[data-theme="light"] .message-text'));
  assert.match(light, /--bubble-user:/, 'the light theme must say what a bubble is');
  assert.match(light, /--bubble-edge:/);

  const bubble = HTML.match(/\.message\.user \{[^}]*\}/);
  assert.ok(bubble, '.message.user is gone -- re-point this test');
  assert.match(bubble[0], /background: var\(--bubble-user\)/);
  assert.match(bubble[0], /border: 1px solid var\(--bubble-edge\)/);
});

test('the chat bar runs no backdrop-filter it cannot see through', () => {
  // The bar set a translucent background and a blur, then overrode the
  // background two lines later -- so every frame of a scrolling transcript paid
  // for a compositing pass that tinted nothing.
  const bar = HTML.match(/\.chat-bar \{[^}]*\}/);
  assert.ok(bar, '.chat-bar is gone -- re-point this test');
  assert.doesNotMatch(bar[0], /backdrop-filter\s*:/, 'the blur was the whole cost, and nothing can see through the bar');
  assert.match(bar[0], /background: var\(--bg-elevated\)/);
});

test('every settings section in the rail has a heading to land on, and back', () => {
  const chips = [...HTML.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);
  const headings = [...HTML.matchAll(/id="settingsSection([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(chips.length >= 5, 'the settings rail is gone -- re-point this test');

  const capitalise = (slug) => slug.charAt(0).toUpperCase() + slug.slice(1);
  assert.deepEqual(
    chips.map(capitalise).sort(),
    headings.sort(),
    'a rail chip with no heading is a button that does nothing; a heading with no chip is unreachable',
  );

  // The rail has to sit outside the scrolling body, or it scrolls away with the
  // rows it is meant to navigate -- which makes it furniture rather than a rail.
  const nav = HTML.indexOf('class="settings-nav"');
  const body = HTML.indexOf('<div class="settings-body">', HTML.indexOf('id="viewSettings"'));
  assert.ok(nav > 0 && body > 0 && nav < body, 'the rail must sit above the scrolling settings body');
});

test('the rail scrolls to the named heading', () => {
  assertScannerCanRead(['jumpToSettingsSection']);
  const calls = [];
  let asked = null;
  const deps = {
    document: {
      getElementById(id) {
        asked = id;
        return id === 'settingsSectionChat' ? { scrollIntoView: (opts) => calls.push(opts) } : null;
      },
    },
    window: { matchMedia: () => ({ matches: false }) },
  };
  assertSandboxCovers(['jumpToSettingsSection'], deps);
  const { jumpToSettingsSection } = loadFromIndex(['jumpToSettingsSection'], deps);

  jumpToSettingsSection('chat');
  assert.equal(asked, 'settingsSectionChat', 'the slug has to reach the heading id');
  assert.deepEqual(calls, [{ block: 'start', behavior: 'smooth' }]);

  // A heading that is not there is a no-op, not a throw: the page is also
  // driven by a stub DOM in the tests next door.
  jumpToSettingsSection('nowhere');
  assert.equal(calls.length, 1);
});

test('the palette can be opened without a keyboard', () => {
  // Ctrl+P opens the app's jump-to-anything, and a phone has no Ctrl+P. The
  // drawer closes first so the palette is not sitting behind the panel.
  assert.match(HTML, /onclick="openPaletteFromDrawer\(\)"/, 'the drawer needs a row that opens the palette');
  assertScannerCanRead(['openPaletteFromDrawer']);
  const order = [];
  const deps = { closeDrawer: () => order.push('close'), openPalette: () => order.push('open') };
  assertSandboxCovers(['openPaletteFromDrawer'], deps);
  const { openPaletteFromDrawer } = loadFromIndex(['openPaletteFromDrawer'], deps);
  openPaletteFromDrawer();
  assert.deepEqual(order, ['close', 'open']);
});
