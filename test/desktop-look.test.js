// Phase 12d, look and speed: the accent hue, depth in 2D, reduced motion and
// the lazy screens.
//
// What is pinned is what a later edit would quietly undo:
//  - the hue is stored under one key, painted before the first frame, and
//    every accent token is derived from it -- and no hue breaks AA, which is
//    checked by sweeping the whole wheel rather than trusting the default;
//  - "reduce motion" really stops animation, whether the system or the app
//    asked for it;
//  - the heavy screens are lazy while the schedulers App needs at start stay
//    eager, so moving one does not quietly un-split the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const CSS = read('desktop', 'src', 'index.css');
const APP = read('desktop', 'src', 'App.tsx');
const MAIN = read('desktop', 'src', 'main.tsx');
const THEME = read('desktop', 'src', 'theme.ts');
const SCHEDULERS = read('desktop', 'src', 'schedulers.ts');
const SETTINGS = read('desktop', 'src', 'screens', 'SettingsScreen.tsx');
const CARD = read('desktop', 'src', 'components', 'AppearanceCard.tsx');

/** The first block that starts at `selector`, up to its closing brace. */
function block(selector) {
  const at = CSS.indexOf(selector);
  assert.ok(at >= 0, `index.css has ${selector}`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

const DARK = block(':root {');
const LIGHT = block('[data-theme="light"]');

// ---- colour maths (OKLCH -> sRGB, channel-clipped as Chromium paints it) ----

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToRgb(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, fromLin(v))));
}

const luminance = ([r, g, b]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
function hexLuminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return luminance([(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255));
}
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

function tokenHex(body, name) {
  const m = body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(m, `--${name} is a hex in this theme`);
  return m[1];
}

function accentLC(body) {
  const m = body.match(/--accent:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+var\(--accent-h\)\s*\)/);
  assert.ok(m, '--accent is oklch(L C var(--accent-h))');
  return [Number(m[1]), Number(m[2])];
}

// ---- the accent hue ----------------------------------------------------------

test('every accent token is derived from --accent-h, in both themes', () => {
  assert.match(DARK, /--accent-h:\s*152;/, 'the default hue is set on :root');
  for (const [name, body] of [['dark', DARK], ['light', LIGHT]]) {
    for (const token of ['--accent', '--accent-dim', '--accent-mid']) {
      assert.match(body, new RegExp(`${token}:\\s*oklch\\([^;]*var\\(--accent-h\\)`), `${name}: ${token} follows the hue`);
    }
  }
  // Two tokens are appended after the light glass block; read them from the whole light section.
  const lightAt = CSS.indexOf('[data-theme="light"]');
  const lightAll = CSS.slice(lightAt, CSS.indexOf('\n}', lightAt));
  for (const [name, body] of [['dark', DARK], ['light', lightAll]]) {
    assert.match(body, /--accent-strong:\s*oklch\([^;]*var\(--accent-h\)/, `${name}: --accent-strong follows the hue`);
    assert.match(body, /--accent-contrast:\s*#/, `${name}: text on the accent has a colour of its own`);
  }
  // Nothing still paints the old fixed green where the accent belongs.
  assert.ok(!/var\(--accent\), #166534/.test(CSS), 'the logo gradient follows the hue');
  assert.ok(!/--accent-contrast, #fff/.test(CSS), 'no fallback that is white on a light accent');
});

test('the default accent is the deeper green, and the light theme keeps its own', () => {
  const [dl, dc] = accentLC(DARK);
  const [ll, lc] = accentLC(LIGHT);
  // The dark accent was #4ade80 (oklch 0.800 0.182) until the ramp went
  // darker; it is deliberately deeper now -- richer, less fluorescent -- and
  // the sweep below is what proves the new value still clears AA. The light
  // theme sits on light surfaces and is unchanged: #166534, oklch 0.448 0.108.
  assert.ok(Math.abs(dl - 0.73) < 0.01 && Math.abs(dc - 0.19) < 0.01, 'dark is the deepened green');
  assert.ok(dl < 0.8, 'the dark accent is darker than the old #4ade80');
  assert.ok(Math.abs(ll - 0.448) < 0.01 && Math.abs(lc - 0.108) < 0.01, 'light matches #166534');
});

for (const [name, body, surfaces] of [
  ['dark', DARK, ['bg-0', 'bg-1', 'bg-2']],
  ['light', null, ['bg-0', 'bg-1', 'bg-2']],
]) {
  test(`${name} theme: accent text and text on the accent clear AA at every hue`, () => {
    const lightAt = CSS.indexOf('[data-theme="light"]');
    const theme = body || CSS.slice(lightAt, CSS.indexOf('\n}', lightAt));
    const [L, C] = accentLC(theme);
    const onAccent = hexLuminance(tokenHex(theme, 'accent-contrast'));
    const failures = [];
    for (let h = 0; h <= 360; h += 1) {
      const y = luminance(oklchToRgb(L, C, h));
      for (const s of surfaces) {
        const r = ratio(y, hexLuminance(tokenHex(theme, s)));
        if (r < 4.5) failures.push(`accent@${h} on ${s}: ${r.toFixed(2)}`);
      }
      const r = ratio(y, onAccent);
      if (r < 4.5) failures.push(`text on accent@${h}: ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures.slice(0, 5), [], 'small text must clear 4.5:1');
  });
}

test('buttons painted in the accent use --accent-contrast for their text', () => {
  for (const selector of ['button.primary {', '.send-btn {', '.update-install {']) {
    assert.match(block(selector), /color:\s*var\(--accent-contrast\)/, `${selector} text follows the theme`);
  }
});

test('the hue is stored under freeai4u.accent_hue and painted before the first frame', async () => {
  assert.match(THEME, /ACCENT_HUE_KEY = 'freeai4u\.accent_hue'/);
  assert.match(THEME, /setProperty\('--accent-h'/);
  assert.match(MAIN, /paintAppearance\(\)/, 'main.tsx paints the appearance');
  assert.ok(MAIN.indexOf('paintAppearance()') < MAIN.indexOf('.render('), 'before React renders');

  // Run the real module with a stand-in document and storage.
  const store = new Map();
  const props = new Map();
  const attrs = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.document = {
    documentElement: {
      style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    },
  };
  globalThis.matchMedia = () => ({ matches: false });
  let theme;
  try {
    theme = await import(pathToFileURL(path.join(ROOT, 'desktop', 'src', 'theme.ts')).href);
  } catch {
    // A Node without TypeScript stripping: the source assertions above stand.
    return;
  }
  try {
    assert.equal(theme.readAccentHue(), 152, 'no choice: the default');
    theme.applyAccentHue(250);
    assert.equal(store.get('freeai4u.accent_hue'), '250', 'stored');
    assert.equal(props.get('--accent-h'), '250', 'applied');
    assert.equal(theme.readAccentHue(), 250, 'read back');
    store.set('freeai4u.accent_hue', 'nonsense');
    assert.equal(theme.readAccentHue(), 152, 'garbage falls back to the default');
    theme.applyAccentHue(null);
    assert.equal(store.has('freeai4u.accent_hue'), false, 'reset forgets the choice');
    assert.equal(props.get('--accent-h'), '152', 'and paints the default');

    // Reduce motion: the stored choice wins, otherwise the system's.
    assert.equal(theme.readReduceMotion(), false);
    globalThis.matchMedia = () => ({ matches: true });
    assert.equal(theme.readReduceMotion(), true, 'follows prefers-reduced-motion by default');
    theme.applyReduceMotion(false);
    assert.equal(store.get('freeai4u.reduce_motion'), '0');
    assert.equal(attrs.has('data-motion'), false);
    theme.applyReduceMotion(true);
    assert.equal(store.get('freeai4u.reduce_motion'), '1');
    assert.equal(attrs.get('data-motion'), 'reduced');

    store.set('freeai4u.accent_hue', '300');
    theme.paintAppearance();
    assert.equal(props.get('--accent-h'), '300', 'boot paints the stored hue');
    assert.equal(attrs.get('data-motion'), 'reduced', 'and the stored motion choice');
  } finally {
    delete globalThis.localStorage;
    delete globalThis.document;
    delete globalThis.matchMedia;
  }
});

test('Settings has an Appearance card with a hue slider, six presets and Reset', () => {
  assert.match(SETTINGS, /<h2>Appearance<\/h2>\s*<AppearanceCard \/>/);
  assert.match(CARD, /type="range"/);
  assert.match(CARD, /max=\{360\}/);
  assert.equal((CARD.match(/\{ name: '[A-Z][a-z]+', hue: /g) || []).length, 6, 'six presets');
  assert.match(CARD, /applyAccentHue\(null\)/, 'Reset forgets the choice');
  assert.match(CARD, /Reduce motion/);
  assert.match(CARD, /applyReduceMotion\(/);
});

// ---- depth in 2D and motion ------------------------------------------------

test('the panes float with a shadow and lift on focus without moving', () => {
  assert.match(CSS, /\.app-body > \.main,[\s\S]{0,120}\{[^}]*box-shadow:\s*var\(--pane-shadow\)/);
  assert.match(CSS, /:focus-within[^{]*\{[^}]*box-shadow:\s*var\(--pane-shadow-focus\)/);
  const focusRules = [...CSS.matchAll(/[^{}]*:focus-within[^{]*\{([^}]*)\}/g)]
    .map((m) => m[1]).filter((body) => /--pane-shadow-focus/.test(body)).join('\n');
  assert.ok(focusRules, 'the pane focus rule exists');
  assert.ok(!/transform|translate|scale|margin|width|height/.test(focusRules), 'focus changes no geometry');
  assert.match(block(':root {'), /--pane-shadow:\s*inset 0 1px 0/, 'with the inner light border');
});

test('reduced motion disables every animation and transition, and the parallax', () => {
  const inApp = CSS.match(/:root\[data-motion='reduced'\] \*,[\s\S]*?\{([^}]*)\}/);
  assert.ok(inApp, 'the in-app switch has a rule');
  assert.match(inApp[1], /animation:\s*none !important/);
  assert.match(inApp[1], /transition:\s*none !important/);
  assert.match(CSS, /:root\[data-motion='reduced'\] \.app::before \{\s*translate:\s*none/);

  const at = CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const media = CSS.slice(at, at + 400);
  assert.match(media, /animation:\s*none !important/, 'and so does the system setting');
  assert.match(media, /translate:\s*none/);

  // The parallax is only declared where motion is welcome.
  const parallax = CSS.match(/translate:\s*var\(--parallax-x\)/g) || [];
  assert.equal(parallax.length, 1);
  const before = CSS.slice(0, CSS.indexOf('translate: var(--parallax-x)'));
  assert.ok(before.lastIndexOf('@media (prefers-reduced-motion: no-preference)') > before.lastIndexOf('}\n}'), 'inside the no-preference guard');
  assert.match(before.slice(before.lastIndexOf('{\n') - 80), /:root:not\(\[data-motion='reduced'\]\)/);

  // The hook: rAF-throttled, capped, and off when motion is reduced.
  assert.match(THEME, /export function useParallax\(maxPx = 6\)/);
  assert.match(THEME, /requestAnimationFrame\(flush\)/);
  assert.match(THEME, /if \(motionReduced\(\)\) \{ write\(0, 0\); return; \}/);
  assert.match(APP, /useParallax\(\);/);
});

// ---- startup speed -----------------------------------------------------------

const LAZY = ['DesignScreen', 'EvalsScreen', 'AgentsScreen', 'RecipesScreen', 'ParallelScreen', 'BuildScreen', 'FilesScreen', 'ImagesScreen', 'LibraryScreen'];

test('the heavy screens are React.lazy, Chat is not', () => {
  for (const screen of LAZY) {
    assert.match(APP, new RegExp(`const ${screen} = lazy\\(\\(\\) => import\\('\\./screens/${screen}'\\)\\);`), `${screen} is lazy`);
    assert.ok(!new RegExp(`^import[^;]*from '\\./screens/${screen}'`, 'm').test(APP), `${screen} has no static import`);
  }
  assert.match(APP, /^import ChatScreen, \{/m, 'Chat, the default view, is in the first bundle');
  assert.match(APP, /<Suspense fallback=\{<ScreenSkeleton \/>\}>/);
});

test('the schedulers are imported eagerly and never pull a lazy screen in statically', () => {
  assert.match(APP, /^import \{ useRecipeScheduler, useEvalScheduler \} from '\.\/schedulers';/m);
  assert.match(SCHEDULERS, /export function useRecipeScheduler\(\)/);
  assert.match(SCHEDULERS, /export function useEvalScheduler\(\)/);
  assert.ok(!/^import[^;]*from '\.\/screens\//m.test(SCHEDULERS), 'no static screen import');
  assert.match(SCHEDULERS, /import\('\.\/screens\/RecipesScreen'\)/);
  assert.match(SCHEDULERS, /import\('\.\/screens\/EvalsScreen'\)/);
  // The hooks moved; the screens no longer define them.
  assert.ok(!/function useRecipeScheduler/.test(read('desktop', 'src', 'screens', 'RecipesScreen.tsx')));
  assert.ok(!/function useEvalScheduler/.test(read('desktop', 'src', 'screens', 'EvalsScreen.tsx')));
});

test('mermaid stays behind a dynamic import', () => {
  const src = read('desktop', 'src', 'diagram.ts');
  assert.match(src, /import\('mermaid'\)/);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'desktop', 'src'));
  for (const file of files) {
    assert.ok(!/^import[^;]*from 'mermaid'/m.test(fs.readFileSync(file, 'utf8')), `${path.relative(ROOT, file)} imports mermaid statically`);
  }
});
