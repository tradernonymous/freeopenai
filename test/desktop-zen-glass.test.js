// The NeuraOS shell pass: liquid glass, Zen mode, and the one fix the plan's
// "branded fallback window" could not have.
//
// The rules worth locking are the ones a future edit would quietly undo:
//  - glass is a property of FLOATING surfaces. The moment a chat bubble or a
//    code block is blurred, the app has traded readability for decoration, and
//    nothing else would notice;
//  - the ambient layer and every transform added for it sit behind the
//    reduced-motion guard, because none of it is information;
//  - Zen hides exactly the chrome it says it hides, and the way back is
//    hoverable rather than invisible;
//  - a machine without WebView2 can install it from the dialog, and the crash
//    log records what happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const CSS = read('desktop', 'src', 'index.css');
const APP = read('desktop', 'src', 'App.tsx');
const COMMANDS = read('desktop', 'src', 'commands.js');
const WEBVIEW2 = read('desktop', 'src-tauri', 'src', 'webview2.rs');
const MAIN_RS = read('desktop', 'src-tauri', 'src', 'main.rs');

// ---- a very small CSS reader --------------------------------------------
//
// The assertions below are about WHERE a declaration lives -- inside the
// reduced-motion query, in a theme block, on a floating surface -- so the file
// is read as rules and media blocks rather than as text to grep.

/** Comments are prose and contain commas; a reader that sees them becomes a
 *  selector parser that sees commas. They are removed before any scan. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The CSS with every `@media (...) { ... }` wrapper removed but its contents
 * kept. Media blocks nest rules, and the assertions here are about individual
 * rules -- "is this declaration inside the guard" is a later question, asked
 * by reading the guard's own contents.
 */
function unwrap(css) {
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf('@media', i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 0;
    let j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out += css.slice(open + 1, j);
    i = j + 1;
  }
}

/** The CSS with conditioned blocks deleted outright. */
function withoutMedia(css) {
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf('@media', i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 0;
    let j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
}

/** Everything inside `@media (...)` blocks whose condition matches `condition`. */
function mediaContent(condition, css = CSS) {
  const out = [];
  let at = css.indexOf(condition);
  while (at >= 0) {
    const open = css.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(css.slice(open + 1, i));
    at = css.indexOf(condition, i);
  }
  return out.join('\n');
}

/** The declarations of every rule whose selector list contains `selector`. */
function bodies(selector, css = CSS) {
  const found = [];
  for (const match of unwrap(stripComments(css)).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const list = match[1].split(',').map((part) => part.trim());
    if (list.includes(selector)) found.push(match[2]);
  }
  return found;
}

function declarations(selector, css = CSS) {
  return bodies(selector, css).join('\n');
}

const STILL = mediaContent('@media (prefers-reduced-motion: no-preference)');
const REST = stripComments(withoutMedia(CSS));

// ---- liquid glass -------------------------------------------------------

test('both themes answer the glass tokens, so neither borrows the other’s tint', () => {
  const root = bodies(':root').join('\n');
  const lightAt = CSS.indexOf('[data-theme="light"]');
  assert.ok(lightAt > 0, 'the light theme block exists');
  const light = CSS.slice(lightAt, lightAt + 1200);
  for (const token of ['--glass-bg', '--glass-bg-strong', '--glass-border', '--glass-light', '--glass-blur']) {
    assert.match(root, new RegExp(token + '\\s*:'), `${token} is defined for the dark shell`);
    assert.match(light, new RegExp(token + '\\s*:'), `${token} is answered in the light theme`);
  }
  // A translucent surface without a hairline border is just a smudge: the
  // border and the top lip are what keep a panel's edge visible.
  assert.match(root, /--glass-border:\s*rgba\(/, 'the glass border is a translucent hairline');
  assert.match(root, /--glass-light:\s*inset 0 1px 0/, 'and there is a light along its top lip');
});

test('glass belongs to floating surfaces, never to what is read at length', () => {
  const glassed = new Set();
  for (const match of unwrap(stripComments(CSS)).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/backdrop-filter:\s*blur/.test(match[2])) continue;
    for (const part of match[1].split(',')) {
      const selector = part.trim().replace(/^@[^{]*/, '').trim();
      if (selector && !selector.startsWith('@')) glassed.add(selector);
    }
  }

  const floating = [
    '.sidebar',
    '.titlebar',
    '.status-bar',
    '.right-panel',
    '.dock-slot',
    '.palette',
    '.mode-panel',
    '.model-panel',
    '.toast',
    '.palette-backdrop',
  ];
  for (const selector of floating) {
    assert.ok(glassed.has(selector), `${selector} is a floating surface and should be glassed`);
  }

  // The other half of the rule, and the one that actually protects the user:
  // nothing in the reading path may be blurred, whatever a later design pass
  // is tempted to do.
  const readable = ['.msg', '.message', '.code', '.code-block', '.composer', '.markdown', '.chat', '.textarea'];
  for (const selector of readable) {
    assert.ok(!glassed.has(selector), `${selector} carries content and must stay opaque`);
  }
});

test('the ambient layer is what makes the glass visible, and it stands still on request', () => {
  assert.match(declarations('.app::before'), /radial-gradient\(/, 'there is an ambient gradient behind the shell');
  assert.match(declarations('.app::before'), /pointer-events:\s*none/, 'and it never eats a click');
  assert.match(
    CSS,
    /\.titlebar,[\s\S]{0,200}z-index:\s*1;/,
    'the shell bands are lifted above the ambient layer so text is never tinted by it',
  );
  assert.match(CSS, /@keyframes ambient-drift/, 'the gradient drifts');
  assert.match(STILL, /@keyframes ambient-drift|animation:\s*ambient-drift/, 'but only when motion is wanted');
  assert.ok(
    !/animation:\s*ambient-drift/.test(REST),
    'the drift is inside the reduced-motion guard, not merely near it',
  );
});

test('the motion this pass added is all under the reduced-motion guard', () => {
  for (const selector of ['.sidebar-btn:hover', '.send-btn:hover:not(:disabled)', '.radial-item:hover']) {
    assert.match(
      declarations(selector, STILL),
      /transform:|transition:/,
      `${selector} is declared inside the guard`,
    );
    assert.ok(
      !/transition:/.test(declarations(selector, REST)),
      `${selector} does not also animate when motion is off`,
    );
  }

  // The peek pill is positioned with a transform and animated with a
  // transition, so it is the pair that has to be told apart: the transform is
  // layout and stays, the transition is motion and is guarded.
  assert.match(declarations('.zen-peek'), /transform: translateX\(-50%\)/, 'the pill is centred, always');
  assert.ok(!/transition:/.test(declarations('.zen-peek', REST)), 'but it does not fade when motion is off');
  assert.match(declarations('.zen-peek', STILL), /transition:/, 'and it does fade when motion is welcome');
});

test('a reader who asked for less gets panels, not glass', () => {
  const calm = mediaContent('(prefers-reduced-transparency: reduce)');
  assert.match(calm, /backdrop-filter:\s*none/, 'the blur is switched off');
  assert.match(calm, /\.app::before/, 'and the ambient layer leaves with it');
  // Both asks land on the same block: the answer to "less transparency" and
  // the answer to "more contrast" is the same opaque panel either way.
  assert.match(mediaContent('(prefers-contrast: more)'), /backdrop-filter:\s*none/, 'more contrast means the same thing');
});

// ---- zen mode -----------------------------------------------------------

test('the activity bar is 40px, and every glyph on it shares one centre line', () => {
  const root = bodies(':root').join('\n');
  assert.match(root, /--rail:\s*40px/, 'the rail is the width the plan asks for');
  // The pad is arithmetic on the two numbers it centres, so editing either one
  // cannot leave the glyphs behind: that is the regression this pins.
  assert.match(root, /--rail-pad:\s*calc\(\(var\(--rail\) - var\(--rail-icon\)\) \/ 2\)/);
  assert.match(root, /--rail-tile-pad:\s*calc\(\(var\(--rail\) - var\(--rail-tile\)\) \/ 2\)/);

  const onTheLine = ['.sidebar-nav', '.sidebar-brand', '.sidebar-search', '.sidebar-group-label'];
  for (const selector of onTheLine) {
    const declarations = bodies(selector).join('\n');
    const usesPad = /var\(--rail-pad\)/.test(declarations) || /var\(--rail-tile-pad\)/.test(declarations);
    assert.ok(usesPad, `${selector} must sit on the rail's centre line, not a hand-tuned number`);
  }

  // The rows carry no left padding of their own: the column is the nav's.
  assert.match(declarations('.sidebar-btn'), /padding:\s*9px 12px 9px 0/);

  // Collapsed, the width is what the icons are centred in.
  assert.match(declarations('.sidebar'), /width:\s*var\(--rail\)/);
  assert.match(declarations('.sidebar:hover'), /width:\s*var\(--rail-open\)/);
});

test('zen hides exactly the chrome it promises, and nothing else', () => {
  const hidden = declarations('.app.zen .status-bar');
  assert.match(hidden, /display:\s*none/, 'the chrome leaves in one rule');
  assert.match(CSS, /\.app\.zen \.titlebar/, 'the titlebar is part of it');
  assert.match(CSS, /\.app\.zen \.sidebar/, 'so is the rail');
  assert.match(CSS, /\.app\.zen \.status-bar/, 'and the status bar');
  // The screen itself must never be hidden: zen is chrome-free, not content-free.
  assert.ok(!/\.app\.zen \.main\b/.test(CSS), 'the canvas stays');
});

test('the way out of zen is hoverable while invisible', () => {
  const peek = declarations('.zen-peek');
  assert.match(peek, /opacity:\s*0/, 'it is invisible until the pointer arrives');
  assert.ok(!/visibility:\s*hidden/.test(peek), 'but not removed from hit testing');
  assert.ok(!/pointer-events:\s*none/.test(peek), 'and not un-hoverable');
  assert.match(declarations('.zen-peek:hover'), /opacity:\s*1/, 'hovering reveals it');
  assert.match(declarations('.zen-peek:focus-visible'), /opacity:\s*1/, 'and so does the keyboard');
});

test('zen mode is reachable from the keyboard and from the palette', () => {
  assert.match(COMMANDS, /id: 'toggle-zen'/, 'the palette lists it');
  assert.match(COMMANDS, /Ctrl\+Shift\+Z/, 'with its shortcut stated');
  const keymap = require('../desktop/src/keymap.js');
  const zen = keymap.BINDINGS.find((b) => b.id === 'zen');
  assert.equal(zen && zen.keys, 'Ctrl+Shift+Z', 'Ctrl+Shift+Z is bound');
  assert.equal(zen.when, 'always', 'and it works with shortcuts off and inside the palette');
  assert.match(APP, /case 'zen': setZen\(\(on\) => !on\)/, 'and it toggles rather than only entering');
  assert.match(APP, /case 'toggle-zen':/, 'the palette command resolves to the same state');
  assert.match(APP, /className=\{zen \? 'app zen' : 'app'\}/, 'the shell actually renders zen');
  assert.match(APP, /className="zen-peek"/, 'and the peek pill is mounted with it');
  // Escaping zen must not need the palette: the pill is the visible way back.
  assert.match(APP, /onClick=\{\(\) => setZen\(false\)\}/, 'clicking the pill leaves zen');
});

// ---- the WebView2 fallback ---------------------------------------------

test('a machine without WebView2 is offered the install, not just told about it', () => {
  assert.match(WEBVIEW2, /pub fn open_download_page\(\) -> bool/, 'the page can be opened');
  assert.match(WEBVIEW2, /creation_flags\(CREATE_NO_WINDOW\)/, 'without a console flashing over the dialog');
  assert.match(WEBVIEW2, /args\(\["\/C", "start", "", DOWNLOAD_URL\]\)/, 'and it opens the pinned download URL');
  assert.match(WEBVIEW2, /pub fn ask_to_install\(\) -> bool/, 'the dialog asks');
  assert.match(WEBVIEW2, /OkCancelCustom/, 'with a button that means something');
  assert.match(MAIN_RS, /webview2::ask_to_install\(\)/, 'the shell uses the dialog at boot');
  assert.match(MAIN_RS, /WebView2 install offered; download page opened/, 'and the outcome is recorded');
  assert.ok(
    !/set_description\(&webview2::install_message\(\)\)/.test(MAIN_RS),
    'the old tell-only dialog is gone, not merely joined by a second one',
  );
});
