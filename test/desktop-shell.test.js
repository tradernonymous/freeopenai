// The app's own design bar, applied to the app.
//
// This repo ships a brand engine (contrast) and an anti-slop linter for the
// artifacts it generates. A design tool that does not pass its own rules is
// exactly the thing a reviewer notices -- and the shell used to fail both: the
// sidebar's icons were emoji, and the muted text token measured 3.88:1 where
// AA wants 4.5. Both are fixed, and both are now gated here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const slop = require('../desktop/src/design/slop.js');
const brand = require('../desktop/src/design/brand.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'desktop', 'src');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function frontendFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return frontendFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test('every frontend file passes the repo\'s own anti-slop linter', () => {
  const offenders = [];
  for (const file of frontendFiles(SRC)) {
    const findings = slop.lint(fs.readFileSync(file, 'utf8'));
    if (findings.length) {
      offenders.push(`${path.relative(SRC, file)}: ${findings.map((f) => f.id).join(', ')}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the desktop shell must pass the linter it ships for generated artifacts',
  );
});

/** The file without its comments: prose may quote an emoji, a render may not. */
function code(file) {
  return read('desktop', 'src', file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

test('emoji are not the icon system', () => {
  // The rule that caught this is `emoji-icons`; these are the surfaces that
  // used to carry them.
  for (const file of ['Sidebar.tsx', 'App.tsx', 'screens/ChatScreen.tsx', 'screens/BuildScreen.tsx', 'screens/ImagesScreen.tsx', 'screens/DesignScreen.tsx', 'components/FileTree.tsx']) {
    assert.ok(
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FF0B}\u{2715}]/u.test(code(file)),
      `${file} still draws an icon with a glyph`,
    );
  }
  // The set that replaced them is one consistent grid.
  const icons = read('desktop', 'src', 'components', 'Icon.tsx');
  assert.match(icons, /viewBox="0 0 24 24"/);
  assert.match(icons, /strokeWidth=\{1\.6\}/);
  assert.match(icons, /stroke="currentColor"/, 'an icon inherits the colour of the state it is in');
});

// ---- the contrast bar ----------------------------------------------------

function tokensOf(selector) {
  const css = read('desktop', 'src', 'index.css');
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `index.css declares ${selector}`);
  const body = css.slice(at, css.indexOf('}', at));
  const out = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

// Every pair the shell actually renders text in.
const PAIRS = [
  ['text-1', 'bg-0'], ['text-1', 'bg-1'], ['text-1', 'bg-2'],
  ['text-2', 'bg-1'], ['text-2', 'bg-2'],
  ['text-3', 'bg-1'], ['text-3', 'bg-2'],
  ['accent', 'bg-0'], ['accent', 'bg-1'],
  ['ok', 'bg-1'], ['warn', 'bg-1'], ['err', 'bg-1'],
];

for (const [theme, selector] of [['dark', ':root {'], ['light', '[data-theme="light"]']]) {
  test(`${theme} theme: every text token pair meets WCAG AA`, () => {
    const tokens = tokensOf(selector);
    const failures = [];
    for (const [fg, bg] of PAIRS) {
      const ratio = brand.contrastRatio(tokens[fg], tokens[bg]);
      if (ratio === null || ratio < 4.5) {
        failures.push(`${fg} on ${bg}: ${ratio === null ? 'unparsable' : ratio.toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, [], 'status and hint text is small text and must clear 4.5:1');
  });
}

test('the tokens the shell uses are defined in both themes', () => {
  const dark = tokensOf(':root {');
  const light = tokensOf('[data-theme="light"]');
  for (const key of ['bg-0', 'bg-1', 'bg-2', 'border', 'text-1', 'text-2', 'text-3', 'accent', 'ok', 'warn', 'err']) {
    assert.ok(dark[key], `dark theme defines --${key}`);
    assert.ok(light[key], `light theme defines --${key}`);
  }
});

// ---- the shell's shape ---------------------------------------------------

test('the shell is chrome plus screens, in that order', () => {
  const shell = read('desktop', 'src', 'App.tsx');
  assert.match(shell, /<TitleBar/);
  assert.match(shell, /<Sidebar/);
  assert.match(shell, /<StatusBar/, 'the status bar is mounted');
  assert.match(shell, /<Toasts/);
  // The status bar answers "which engine, and is it answering?" without a trip
  // to Settings.
  // The shell passes what the bar reports; the bar only renders it.
  assert.match(shell, /engine=\{api\.getServer\(\)\}/);
  // The ACTIONABLE state, not just the reachable one: an engine that answers
  // "healthy" while refusing every call wants a sign-in, and saying "connected"
  // there is the same half-truth the banner used to tell.
  assert.match(shell, /shell\.reason === 'signed-out' \? 'signed-out'/);
  assert.match(shell, /outcome \? outcome\.kind : 'checking'/);
  const status = read('desktop', 'src', 'components', 'StatusBar.tsx');
  assert.match(status, /engine: string/, 'the bar takes the engine address as a prop');
});

test('a choice is one control, not a row of buttons', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  // Phase 2: the mode is a coloured label inside the composer, cycled with Tab,
  // and the header that held the mode and model pills is gone.
  assert.match(chat, /<Composer/);
  assert.ok(!/className="mode-tab /.test(chat), 'the mode tabs are gone');
  assert.ok(!/<header className="screen-header">/.test(chat), 'the chat header is gone');
  assert.ok(!/<ModePicker/.test(chat), 'the mode pill is replaced by the composer label');
  const box = read('desktop', 'src', 'components', 'Composer.tsx');
  assert.match(box, /grammar\.cycleMode\(mode, e\.shiftKey\)/, 'Tab / Shift+Tab cycles the mode');
  assert.match(box, /grammar\.leaveMode\(/, 'Backspace at the start or Esc leaves it');
  assert.match(box, /modeInfo\.hint/, 'the label explains the mode where it is shown');
  const composer = require('../desktop/src/composer.js');
  assert.match(composer.modeById('plan').hint, /Draft a plan first/, 'each mode still explains itself');
});

test('a failed turn is reported once, in the turn it belongs to', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  // No second red bar repeating the same failure at the bottom of the screen.
  assert.ok(!/className="stream-error"/.test(chat), 'the duplicate bottom error bar is gone');
  assert.ok(!/setStreamError/.test(chat), 'and so is its state');
  // The failure card in the message carries the whole report, and names what
  // was asked of which service -- never whichever provider worded the error.
  assert.match(chat, /msg\.failure\.upstream/);
  assert.match(chat, /failure\.attribute\(/);
  // The free tier's budget is a fact beside the composer, not a warning.
  assert.match(chat, /composer-note/);
});

test('the sidebar says what each row is and how to reach it', () => {
  const sidebar = read('desktop', 'src', 'Sidebar.tsx');
  assert.match(sidebar, /aria-current/, 'the active screen is announced');
  assert.match(sidebar, /aria-pressed/, 'so is a toggled panel');
  assert.match(sidebar, /sidebar-keys/, 'and each row shows its shortcut');
});
