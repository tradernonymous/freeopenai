// Experience polish, pinned where a later edit would quietly undo it.
//
// Two of these are bugs this pass found in the shipped page: a status line whose
// timer lived in a `let` at the bottom of the script (showStatus runs during
// startup, so the read was a temporal-dead-zone throw that aborted the rest of
// the boot), and a lightbox that only a mouse could open.
const test = require('node:test');
const assert = require('node:assert/strict');

const { HTML, sourceOf, loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

function makeClassList() {
  const set = new Set();
  return {
    contains: (name) => set.has(name),
    toggle(name, on) { if (on) set.add(name); else set.delete(name); },
    remove: (name) => set.delete(name),
  };
}

test('a failure stays on screen; only the passing messages expire', () => {
  // "Image generation needs NARA_IMAGE_MODEL" that vanishes after 2.5s is a
  // message that named the fix and then took it away.
  assertScannerCanRead(['showStatus']);
  const timers = [];
  const cleared = [];
  const deps = {
    statusDot: { className: '' },
    statusMessage: { textContent: '', classList: makeClassList() },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => cleared.push(id),
  };
  assertSandboxCovers(['showStatus'], deps);
  const { showStatus } = loadFromIndex(['showStatus'], deps);

  showStatus('success', 'Copied');
  assert.equal(deps.statusMessage.textContent, 'Copied');
  assert.equal(deps.statusMessage.classList.contains('error'), false);
  assert.equal(timers.length, 1, 'a passing message schedules its own removal');
  assert.equal(timers[0].ms, 2500);

  showStatus('error', 'Image generation needs NARA_IMAGE_MODEL — set it, or sign in to Puter');
  assert.equal(deps.statusMessage.textContent, 'Image generation needs NARA_IMAGE_MODEL — set it, or sign in to Puter');
  assert.equal(deps.statusMessage.classList.contains('error'), true, 'a failure has to look like one');
  assert.equal(deps.statusDot.className, 'status-dot error');
  assert.equal(timers.length, 1, 'the failure was scheduled to disappear');
  assert.deepEqual(cleared, [1], 'the pending "Ready" reset has to be cancelled by a newer message');

  // A later success takes the message over and does expire again.
  showStatus('success', 'Saved');
  assert.equal(deps.statusMessage.classList.contains('error'), false, 'the failure colour has to clear');
  assert.equal(timers.length, 2);
  timers[1].fn();
  assert.equal(deps.statusMessage.textContent, 'Ready');
  assert.equal(deps.statusDot.className, 'status-dot');
});

test('a picture with something to report keeps its sentence on screen', () => {
  // "asked for 16:9 (1536x864), drawn 1:1 (1024×1024) — cut to 16:9 (1024×576)" is
  // read *after* the picture appears, and the bar is one ellipsised line: 2.5
  // seconds of it is a sentence nobody finishes. It is an explanation, so it goes
  // when the next thing happens, exactly like a failure.
  assertScannerCanRead(['showStatus', 'showImageOutcome', 'imageOutcomeStatus']);
  const timers = [];
  const deps = {
    statusDot: { className: '' },
    statusMessage: { textContent: '', classList: makeClassList() },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  assertSandboxCovers(['showStatus', 'showImageOutcome', 'imageOutcomeStatus'], deps);
  const page = loadFromIndex(['showStatus', 'showImageOutcome', 'imageOutcomeStatus'], deps);

  page.showImageOutcome('Image ready', { drewWith: 'Puter', notes: ['asked for 16:9 (1536x864), drawn 1:1 (1024×1024) — cut to 16:9 (1024×576)'] });
  assert.match(deps.statusMessage.textContent, /^Image ready — Puter; asked for 16:9/);
  assert.match(deps.statusMessage.textContent, /cut to 16:9 \(1024×576\)$/);
  assert.equal(timers.length, 0, 'the explanation must not be scheduled to vanish');
  assert.equal(deps.statusMessage.classList.contains('error'), false, 'a caveat is not a failure');

  // A clean draw is a confirmation, and confirmations still get out of the way.
  page.showImageOutcome('Image ready', { drewWith: 'Puter', notes: [] });
  assert.equal(deps.statusMessage.textContent, 'Image ready — Puter');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2500);

});

test('the status timer is not a page-scope binding', () => {
  // The page calls showStatus while booting, before the bottom of the script has
  // run. A `let statusResetTimer` down there is in its temporal dead zone at that
  // moment, and the throw took the rest of initializeApp with it.
  const source = sourceOf('showStatus');
  assert.match(source, /showStatus\.timer/, 'the timer has to hang off the function, not a later `let`');
  assert.doesNotMatch(source, /statusResetTimer/);
});

test('the hero teaches the three things a blank composer cannot show', () => {
  for (const [label, fn] of [['Generate an image', 'startImageTurn'], ['Plan before building', 'startPlanTurn'], ['Add a skill', 'startSkillBrowse']]) {
    assert.ok(HTML.includes(`onclick="${fn}()"`), `${fn}() is not wired to a starter chip`);
    assert.ok(HTML.includes(label), `the ${fn}() chip has no label saying what it does`);
  }
  const hero = HTML.slice(HTML.indexOf('id="emptyState"'), HTML.indexOf('class="chat-input-area"'));
  // The one discoverability note with no visible control behind it.
  assert.match(hero, /<kbd>Ctrl<\/kbd>\+<kbd>P<\/kbd>/);
});

test('a starter turns its subject on instead of describing it', () => {
  assertScannerCanRead(['startImageTurn', 'startPlanTurn']);
  const statuses = [];
  const deps = {
    imageMode: false,
    selectedMode: 'chat',
    chatInput: { focused: false, focus() { this.focused = true; } },
    toggleImageMode: () => { deps.imageMode = true; },
    updateModeChip: () => { deps.chipRedrawn = true; },
    ensureSkillsLoaded: () => { deps.skillsLoaded = true; },
    localStorage: { setItem() { /* recorded below */ } },
    rememberPreference: (key, value) => { deps.localStorage.setItem(key, value); return true; },
    showStatus: (kind, text) => statuses.push(`${kind}: ${text}`),
  };
  assertSandboxCovers(['startImageTurn', 'startPlanTurn'], deps);
  const { startImageTurn, startPlanTurn } = loadFromIndex(['startImageTurn', 'startPlanTurn'], deps);

  startImageTurn();
  assert.equal(deps.imageMode, true, 'the chip has to leave image mode on');
  assert.equal(deps.chatInput.focused, true, 'the cursor goes where the next keystroke goes');
  assert.match(statuses[0], /^info: Image mode/);
  // Idempotent: a second click must not turn the mode back off.
  startImageTurn();
  assert.equal(deps.imageMode, true);
  assert.equal(statuses.length, 2);

  startPlanTurn();
  assert.equal(deps.selectedMode, 'plan');
  assert.equal(deps.chipRedrawn, true);
  assert.equal(deps.skillsLoaded, true, 'Plan carries skills, so the library is fetched now');
  assert.match(statuses[2], /^info: Plan mode/);
});

test('a picture opens with Enter or Space, not only with a click', () => {
  // The lightbox is where saving, copying and editing live, so a mouse-only
  // lightbox made all three mouse-only.
  assertScannerCanRead(['makeImageOpener']);
  const opened = [];
  const listeners = {};
  const el = {
    tabIndex: -1,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const deps = { openImageLightbox: (src, alt) => opened.push(`${src}|${alt}`) };
  assertSandboxCovers(['makeImageOpener'], deps);
  const { makeImageOpener } = loadFromIndex(['makeImageOpener'], deps);

  makeImageOpener(el, 'data:image/png;base64,x', 'a wide picture');
  assert.equal(el.tabIndex, 0, 'a picture that opens has to be reachable');
  assert.equal(el.attrs.role, 'button');
  assert.match(el.attrs['aria-label'], /a wide picture/);
  assert.equal(el.attrs['aria-label'], 'Open image: a wide picture');

  listeners.click[0]();
  assert.deepEqual(opened, ['data:image/png;base64,x|a wide picture']);

  let prevented = 0;
  listeners.keydown[0]({ key: 'a', preventDefault: () => { prevented++; } });
  assert.equal(opened.length, 1, 'a stray key opened the lightbox');
  for (const key of ['Enter', ' ']) listeners.keydown[0]({ key, preventDefault: () => { prevented++; } });
  assert.equal(opened.length, 3, 'Enter and Space both open it');
  assert.equal(prevented, 2, 'Space has to be prevented, or it also scrolls the transcript');
});

test('every control shares one focus ring and one press', () => {
  const ring = HTML.match(/\.hero-card:focus-visible, [^{]*\{[^}]*\}/);
  assert.ok(ring, 'the shared focus ring is gone -- re-point this test');
  for (const selectors of ['.hero-start:focus-visible', '.drawer-nav-btn:focus-visible', '.dl-menu button:focus-visible', '.theme-menu button:focus-visible', '.gallery-tile:focus-visible', '.message-image:focus-visible', '.history-item:focus-visible']) {
    assert.ok(ring[0].includes(selectors), `${selectors} has hover but no focus state`);
  }
  assert.match(ring[0], /box-shadow: var\(--glow\)/);

  const press = HTML.match(/\.hero-card:active,[^{]*\{[^}]*\}/);
  assert.ok(press, 'the press feedback is gone -- re-point this test');
  assert.match(press[0], /transform: translateY\(1px\)/);
  for (const selectors of ['.icon-btn:active', '.icon-btn-text:active', '.drawer-nav-btn:active', '.composer-send:active:not\(:disabled\)']) {
    assert.ok(press[0].includes(selectors), `${selectors} does not acknowledge a press`);
  }
});

test('an empty sidebar says what will fill it', () => {
  assert.ok(HTML.includes('No chats yet. Describe anything in the composer and it is saved here'), 'the empty sidebar copy is back to answering a question nobody asked');
  assert.doesNotMatch(HTML, /'No chats yet\.'/, 'the one-line empty state is back');
});

test('dead rules for a hero that has no icon or heading stay gone', () => {
  // A redesign removed the icon and the h3 but left their rules matching
  // nothing, which reads as styling that is doing something.
  assert.doesNotMatch(HTML, /\.empty-state svg \{/);
  assert.doesNotMatch(HTML, /\.empty-state h3 \{/);
  const hero = HTML.slice(HTML.indexOf('id="emptyState"'), HTML.indexOf('class="chat-input-area"'));
  assert.doesNotMatch(hero, /<svg[^>]*class="empty-/, 'the hero gained an icon without its rule');
  assert.doesNotMatch(hero, /<h3/, 'the hero gained an h3 without its rule');
});
