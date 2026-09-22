// The Design screen's wiring: the capability is client-side (the engine's
// generate route is a placeholder), so what can be tested without a browser is
// the decisions -- that generation goes through the real chat route, that the
// preview is sandboxed, that the brand extraction rides the SSRF-safe fetch,
// and that the pure modules the screen depends on are the tested ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.join(__dirname, '..', 'desktop');

function read(...parts) {
  return fs.readFileSync(path.join(DESKTOP, ...parts), 'utf8');
}

test('design generation goes through the engine chat route, not the placeholder', () => {
  const screen = read('src', 'screens', 'DesignScreen.tsx');
  // streamChat is invoked through a ternary now (a saved/local provider uses
  // streamMine instead), so the name no longer sits directly against its own
  // call parens -- streamChat)(... is the real call site.
  assert.match(screen, /streamChat\)?\(/, 'generation rides the real chat route');
  assert.match(screen, /api\.designGenerate/, 'the project hook is still recorded');
  const server = fs.readFileSync(path.join(DESKTOP, '..', 'server.js'), 'utf8');
  assert.match(
    server,
    /Design generation is queued/,
    'the server generate route is a placeholder, which is exactly why the client does the work',
  );
});

test('the system prompt demands a self-contained document and AA contrast', () => {
  // Phase 4 moved the prompt into design/prompt.js (split by model tier); the
  // screen builds every turn from it.
  const screen = read('src', 'screens', 'DesignScreen.tsx');
  assert.match(screen, /promptLib\.buildMessages\(/);
  const prompt = read('src', 'design', 'prompt.js');
  assert.match(prompt, /self-contained/);
  assert.match(prompt, /WCAG AA/);
  assert.match(prompt, /DESIGN\.md contract/);
  assert.match(prompt, /no lorem ipsum/i, 'the anti-slop rule starts at the prompt');
});

test('the live preview is sandboxed and isolated', () => {
  const screen = read('src', 'screens', 'DesignScreen.tsx');
  assert.match(screen, /sandbox="allow-scripts"/, 'no same-origin access from generated HTML');
  assert.match(screen, /srcDoc=/, 'the artifact loads from a string, not a URL');
  assert.ok(!screen.includes('sandbox="allow-same-origin"'), 'same-origin would undo the sandbox');
});

test('drafts are approval-gated with the slop score before the canvas changes', () => {
  const screen = read('src', 'screens', 'DesignScreen.tsx');
  assert.match(screen, /slop\.score\(/, 'every draft is scored');
  assert.match(screen, /Apply to canvas/, 'applying is a decision');
  assert.match(screen, /Discard/);
  assert.match(screen, /saveCanvas/, 'the applied draft is what persists');
});

test('brand extraction rides the SSRF-safe fetch route and lands in DESIGN.md', () => {
  const screen = read('src', 'screens', 'DesignScreen.tsx');
  assert.match(screen, /api\.fetchUrl\(/, 'the engine fetches the page (every-hop SSRF guard lives there)');
  assert.match(screen, /paletteFromText/);
  assert.match(screen, /semanticRoles/);
  assert.match(screen, /designSaveBrand/, 'the brand persists to the project');
  const brand = require('../desktop/src/design/brand.js');
  const md = brand.designMd({ palette: ['#ffffff', '#000000'], url: 'https://example.com' }, 'T');
  assert.match(md, /DESIGN\.md/);
});

test('the design modules are the tested ones (UMD, no second copy)', () => {
  const brandSrc = read('src', 'design', 'brand.js');
  const slopSrc = read('src', 'design', 'slop.js');
  assert.match(brandSrc, /module\.exports/, 'node tests require the same file the app bundles');
  assert.match(slopSrc, /module\.exports/);
  const engine = fs.readFileSync(path.join(DESKTOP, '..', 'test', 'design-engine.test.js'), 'utf8');
  assert.match(engine, /design\/brand\.js/);
  assert.match(engine, /design\/slop\.js/);
});

test('the screen calls only routes the server serves', () => {
  const screen = read('src', 'screens', 'DesignScreen.tsx');
  const server = fs.readFileSync(path.join(DESKTOP, '..', 'server.js'), 'utf8');
  const calls = [...screen.matchAll(/api\.(designTemplates|designProjects|designCreateProject|designGetProject|designUpdateProject|designGenerate|designExport|designSaveBrand|fetchUrl|providers|models)\b/g)]
    .map((m) => m[1]);
  assert.ok(calls.length >= 6, 'the screen is wired, found ' + calls.length);
  const api = read('src', 'api.ts');
  for (const fn of new Set(calls)) {
    assert.match(api, new RegExp(fn + '\\s*[:=(]'), fn + ' exists in the api client');
  }
});
