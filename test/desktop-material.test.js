// NEURA-050: the window material, end to end.
//
// Mica is the one look in this app that the page cannot decide by itself: a
// translucent sidebar over a window with no DWM backdrop is a sidebar over
// nothing. The chain is shell -> page -> stylesheet, and each link is asserted
// here, because a break in any of them is invisible in the dev browser (which
// has no shell and is therefore always solid) and only shows on a real
// Windows 10 machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('desktop', 'src', 'index.css');
const THEME = read('desktop', 'src', 'theme.ts');
const BOOT = read('desktop', 'src', 'main.tsx');
const BRIDGE = read('desktop', 'src', 'bridge.ts');
const MAIN_RS = read('desktop', 'src-tauri', 'src', 'main.rs');
const CONF = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));

test('the shell decides, and the page asks', () => {
  assert.match(MAIN_RS, /fn window_has_mica\(\) -> bool \{\s*mica::supported\(\)/,
    'the command answers from the same guard that withdraws the effect');
  assert.match(MAIN_RS, /generate_handler!\[\s*window_has_mica,/,
    'the command is registered, or the page would only ever get an error');
  assert.match(BRIDGE, /export async function windowHasMica\(\): Promise<boolean>/,
    'the page has a typed way to ask');
  assert.match(BRIDGE, /if \(!hasShell\(\)\) return false;/,
    'no shell means no Mica rather than a thrown boot');
});

test('the first paint is solid and only then upgraded', () => {
  const solidFirst = BOOT.indexOf('applyMaterial(readMaterial(), false)');
  const askLater = BOOT.indexOf('windowHasMica()');
  assert.ok(solidFirst > 0, 'boot paints a material before React renders');
  assert.ok(askLater > solidFirst,
    'the shell is asked after the solid paint: the other order flashes the wallpaper through a window that may not have a backdrop');
  assert.match(BOOT, /\.catch\(/, 'a shell that does not answer leaves the app solid');
});

test('mica is painted only when both the person and the window agree', () => {
  assert.match(THEME, /wanted === 'mica' && hasMica \? 'mica' : 'solid'/,
    'either half missing means solid');
  assert.match(THEME, /setAttribute\('data-material', effective\)/,
    'the effective material, not the wish, reaches the stylesheet');
  assert.equal(CONF.app.windows[0].windowEffects.effects[0], 'mica',
    'the window is still built with the effect the guard can withdraw');
});

test('only the chrome goes translucent, and reduced transparency opts out', () => {
  const block = CSS.slice(CSS.indexOf('@media not (prefers-reduced-transparency: reduce)'));
  assert.ok(block.length > 0, 'the Mica rules live inside the not-reduced query');
  for (const selector of ['.titlebar', '.sidebar', '.status-bar']) {
    assert.ok(block.includes(`html[data-material="mica"] ${selector}`), `${selector} is translucent under Mica`);
  }
  assert.match(block, /html\[data-material="mica"\] \.main \{\s*background: var\(--bg-0\);/,
    'the content pane stays opaque, so chat and code never sit on wallpaper');
  // The rules are additive and scoped: nothing outside the attribute changes.
  assert.ok(!/^\s*html \{\s*background: transparent/m.test(CSS), 'a solid window is never made transparent');
});

test('the gloss is dark-theme only and follows reduced transparency', () => {
  assert.match(CSS, /--gloss: linear-gradient\(/, 'the dark theme has a gloss wash');
  assert.match(CSS, /\[data-theme="light"\] \{\n(?:.*\n)*?\s*--gloss: none;/,
    'the light theme has none: a white wash on a light surface is grey, not gloss');
  const reduced = CSS.slice(CSS.lastIndexOf('@media (prefers-reduced-transparency: reduce)'));
  assert.match(reduced, /--gloss: none;.*--gloss-strong: none;.*--gloss-edge: none;/s,
    'asking for less transparency flattens the surfaces too');
});

test('the dark ramp is darker than the greens it replaced', () => {
  const dark = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('[data-theme="light"]'));
  const hex = (name) => {
    const m = dark.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i'));
    assert.ok(m, `--${name} is a hex colour in the dark theme`);
    return parseInt(m[1], 16);
  };
  // The old ramp: #0b0f0a #111a10 #182417 #1f2e1c. Every step is darker now,
  // which is what bought the deeper accent its contrast headroom.
  const old = [0x0b0f0a, 0x111a10, 0x182417, 0x1f2e1c];
  ['bg-0', 'bg-1', 'bg-2', 'bg-3'].forEach((name, i) => {
    assert.ok(hex(name) < old[i], `--${name} is darker than the green it replaced`);
  });
});
