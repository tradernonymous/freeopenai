// The control system, the settings rail and three UI bugs that a refactor would
// quietly bring back: an invisible user bubble in the light theme, reasoning
// text at 7px, and a backdrop-filter that paints a surface nobody can see
// through. None of these can fail a boot test -- they only show up as "the app
// looks wrong", which is what makes them worth pinning.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const { HTML, sourceOf, loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('the three icon buttons are one rule, and it uses the control radius', () => {
  // .icon-btn, .menu-trigger-btn and .modal-close were three copies of the same
  // seven declarations, which is how a dialog's close button drifts away from
  // the button beside it in the bar.
  const base = CSS.match(/\.icon-btn, \.menu-trigger-btn, \.modal-close \{[^}]*\}/);
  assert.ok(base, 'the icon buttons no longer share one rule -- re-point this test');
  assert.match(base[0], /width: 32px; height: 32px/);
  assert.match(base[0], /border-radius: var\(--ctl-r\)/);
  assert.doesNotMatch(HTML, /\.modal-close \{ width: 32px/, 'a second copy of the rule is back');
});

test('a labelled button is the same control as a chip, only wider', () => {
  const labelled = CSS.match(/\.icon-btn-text \{[^}]*\}/);
  assert.ok(labelled, '.icon-btn-text is gone -- re-point this test');
  for (const token of ['height: var(--ctl-h)', 'border-radius: var(--ctl-r)', 'background: var(--ctl-bg)', 'border: 1px solid var(--ctl-edge)']) {
    assert.ok(labelled[0].includes(token), `.icon-btn-text must draw ${token} from the shared control tokens`);
  }
});

test('the reasoning is legible, and its summary is a real control', () => {
  // 7px reasoning text and a 9px summary were strays from a smaller type scale;
  // the summary is what you tap to open the scratchpad.
  const text = CSS.match(/\.reasoning-text \{[^}]*\}/);
  assert.ok(text, '.reasoning-text is gone -- re-point this test');
  const textSize = Number((text[0].match(/font-size:\s*([\d.]+)px/) || [])[1]);
  assert.ok(textSize >= 10, `reasoning text is ${textSize}px, which is not readable`);

  const summary = CSS.match(/\.message-reasoning > summary \{[^}]*\}/);
  assert.ok(summary, 'the reasoning summary is gone -- re-point this test');
  const summarySize = Number((summary[0].match(/font-size:\s*([\d.]+)px/) || [])[1]);
  assert.ok(summarySize >= 11, `the summary that opens it is ${summarySize}px`);
});

test('a user bubble is themed, not hard-coded white', () => {
  // The bubble is a tint over whatever surface is behind it. Hard-coded white
  // over the light theme's near-white surface left no bubble at all.
  const light = CSS.slice(CSS.indexOf('html[data-theme="light"] {'), CSS.indexOf('html[data-theme="light"] .message-text'));
  assert.match(light, /--bubble-user:/, 'the light theme must say what a bubble is');
  assert.match(light, /--bubble-edge:/);

  const bubble = CSS.match(/\.message\.user \{[^}]*\}/);
  assert.ok(bubble, '.message.user is gone -- re-point this test');
  assert.match(bubble[0], /background: var\(--bubble-user\)/);
  assert.match(bubble[0], /border: 1px solid var\(--bubble-edge\)/);
});

test('the chat bar runs no backdrop-filter it cannot see through', () => {
  // The bar set a translucent background and a blur, then overrode the
  // background two lines later -- so every frame of a scrolling transcript paid
  // for a compositing pass that tinted nothing.
  const bar = CSS.match(/\.chat-bar \{[^}]*\}/);
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

test('the transcript is a window inside the app frame, and a phone gets the screen', () => {
  // Full bleed at every size: the chat view carries no inset, which is what
  // the browser smoke asserts per viewport. An inset here used to read as "the
  // page" rather than a conversation with a size; the window-inside-a-frame
  // claim now lives in the card's own bounds, not the view's padding.
  assert.match(CSS, /#viewChat \{ padding: 0; \}/, 'the chat view lost its full bleed');
  // Full bleed means a flush card too: no radius, no border, no shadow. The
  // rounded floating card this used to pin belonged to the inset layout.
  assert.match(CSS, /#viewChat \.chat-card \{ border-radius: 0; border: none; box-shadow: none; \}/);

  // The small-screen layer keeps it there: a phone's transcript wants every pixel.
  const small = CSS.slice(CSS.indexOf('@media (max-width: 640px), (max-height: 520px) and (orientation: landscape) {'));
  assert.match(small, /#viewChat \{ padding: 0; \}/);

  // And the card must never clip its popups: the model picker and the attach
  // menu hang below the composer, so both are position: fixed -- viewport
  // relative, which is what frees the card to keep overflow: hidden for its
  // own rounded corners. An absolute popup inside this card would be cut off.
  const card = CSS.match(/\.chat-card \{[^}]*\}/);
  assert.ok(card, '.chat-card is gone -- re-point this test');
  assert.match(card[0], /overflow: hidden/);
  for (const rule of [/\.model-dropdown \{[^}]*\}/, /\.attach-menu \{[^}]*\}/]) {
    const popup = CSS.match(rule);
    assert.ok(popup, rule + ' is gone -- re-point this test');
    assert.match(popup[0], /position: fixed/, 'the popup must escape the card');
  }
});

test('the way back to the newest output tracks the reading column', () => {
  const pill = CSS.match(/\.scroll-bottom \{[^}]*\}/);
  assert.ok(pill, '.scroll-bottom is gone -- re-point this test');
  // Anchored to the measure: on a wide screen the column is centred, so a pill
  // at the window's right edge floats nowhere near the text it returns you to.
  assert.match(pill[0], /right: max\(16px, calc\(\(100% - var\(--measure\)\) \/ 2 \+ 16px\)\)/);
  assert.match(pill[0], /display: none/);
  assert.match(CSS, /\.scroll-bottom\.visible \{ display: inline-flex; \}/, 'the pill needs a state the wiring can turn on');
  // It sits above the composer, which is the element it is positioned against.
  const area = CSS.match(/\.chat-input-area \{[^}]*\}/);
  assert.ok(area, '.chat-input-area is gone -- re-point this test');
  assert.match(area[0], /position: relative/);
});

test('restoring a saved chat does not animate every bubble in', () => {
  // Building a long conversation is a two-hundred-element slide-in for content
  // the reader has already read.
  assert.match(CSS, /\.chat-messages\.no-anim \.message \{ animation: none; \}/);
  const restore = sourceOf('renderActiveConversation');
  assert.match(restore, /classList\.add\('no-anim'\)/);
  assert.match(restore, /requestAnimationFrame\(\(\) => chatMessages\.classList\.remove\('no-anim'\)\)/, 'the class has to come off before the next message animates');
});

test('the busy row names the step instead of three dots and silence', () => {
  // The dots say "busy", which is the same for a two-second lookup and a stuck
  // provider; the label says what is happening. It is built by the typing
  // indicator at runtime, so the assertion reads the builder, not static HTML.
  assert.match(APP_JS, /<div class="typing-label" id="typingLabel">/);
  assert.match(CSS, /\.typing-label \{[^}]*\}/, 'the label has no rule, so it cannot truncate on a phone');
  assert.match(sourceOf('setActivity'), /getElementById\('typingLabel'\)/);
  // The tool loop names the step it is running...
  assert.match(sourceOf('runChatWithTools'), /setActivity\(line\)/);
  // ...and the streamed reply says it is writing.
  assert.match(sourceOf('createStreamRenderer'), /setActivity\('Writing the reply/);
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
