// The Images screen's decisions: which service draws, with which model, at
// which shape, and what a failure means.
//
// The models are the app's curated Puter chains -- the same lists the web app
// and the engine use. They live in chatlib.js, which is shared with the page,
// so the desktop cannot import them without dragging that file into a bundle:
// it mirrors them instead, and this test reads chatlib.js and asserts the two
// copies are identical. A drift here would mean the desktop asking Puter for a
// model the rest of the app does not know about.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const images = require('../desktop/src/images.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const chatlib = () => read('chatlib.js');

function chatlibStrings(source, name) {
  const block = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
  assert.ok(block, `${name} must exist in chatlib.js`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ---- the two copies cannot drift -----------------------------------------

test('the Puter model chains match the ones chatlib ships', () => {
  const source = chatlib();
  assert.deepEqual(images.PUTER_GENERATE_MODELS, chatlibStrings(source, 'IMAGE_GENERATE_MODELS'));
  assert.deepEqual(images.PUTER_EDIT_MODELS, chatlibStrings(source, 'IMAGE_EDIT_MODELS'));
  assert.match(source, new RegExp(`const IMAGE_QUALITY = '${images.QUALITY}'`));
});

test('the shape presets match chatlib, pixels and ratio together', () => {
  const source = chatlib();
  const block = source.match(/const IMAGE_SIZE_PRESETS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'IMAGE_SIZE_PRESETS must exist in chatlib.js');
  const ids = [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(images.SIZE_PRESETS.map((p) => p.id), ids);
  for (const preset of images.SIZE_PRESETS) {
    assert.match(block[1], new RegExp(`width: ${preset.width}, height: ${preset.height}`));
    assert.ok(preset.ratio.w > 0 && preset.ratio.h > 0, `${preset.id} needs a ratio for Puter`);
    assert.ok(preset.label, `${preset.id} needs a label`);
  }
});

// ---- which service draws -------------------------------------------------

const REPORT = {
  browser: { id: 'puter', label: 'Puter', ready: false, note: 'Draws in your browser.' },
  providers: [
    { id: 'ovhcloud', label: 'Free FLUX', ready: true, model: 'stable-diffusion-xl-base-v10', models: ['stable-diffusion-xl-base-v10'] },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      ready: true,
      model: 'google/gemini-2.5-flash-image',
      models: ['google/gemini-2.5-flash-image', 'black-forest-labs/flux-1.1-pro'],
    },
    { id: 'nara', label: 'Nara', ready: false, reason: 'set NARA_IMAGE_MODEL' },
  ],
};

test('the browser answer is a row, not a checkbox', () => {
  const rows = images.providerChoices(REPORT);
  assert.deepEqual(rows.map((r) => r.id), ['ovhcloud', 'openrouter', 'nara', 'puter']);
  assert.equal(rows[3].kind, 'browser');
  assert.equal(rows[3].ready, false, 'Puter is never "ready": it needs a sign-in');
  assert.deepEqual(rows[3].models, images.PUTER_GENERATE_MODELS);
  // A service that cannot draw still appears, with the reason -- "no service
  // answered" is the least useful thing a picker can say.
  assert.match(rows[2].reason, /NARA_IMAGE_MODEL/);
});

// ---- which models each service offers ------------------------------------
//
// A picker that can only offer the one model the engine already chose is not a
// picker. The list is what the service reports it can be asked for, and a
// service that reports only one (or none) still yields exactly one row.

test('the model list is the service’s own, and a single-model service stays one row', () => {
  const rows = images.providerChoices(REPORT);
  assert.deepEqual(images.modelsForChoice(rows[0]), ['stable-diffusion-xl-base-v10']);
  assert.deepEqual(images.modelsForChoice(rows[1]), [
    'google/gemini-2.5-flash-image',
    'black-forest-labs/flux-1.1-pro',
  ]);
  // An engine older than this screen reports one model and no list.
  const legacy = images.providerChoices({
    providers: [{ id: 'ovhcloud', label: 'Free FLUX', ready: true, model: 'sdxl' }],
  });
  assert.deepEqual(images.modelsForChoice(legacy[0]), ['sdxl']);
  // A row that names no model at all offers the service default rather than an
  // empty dropdown.
  const blank = images.providerChoices({ providers: [{ id: 'x', label: 'X', ready: true }] });
  assert.deepEqual(images.modelsForChoice(blank[0]), ['service default']);
  assert.equal(images.modelFor(blank[0]), '', 'an unnamed model leaves the service to choose');
});

test('the model picked on screen is the model the request names', () => {
  const rows = images.providerChoices(REPORT);
  const body = images.serverBody(rows[1], {
    prompt: 'a fox',
    size: 'square',
    model: 'black-forest-labs/flux-1.1-pro',
  });
  assert.equal(body.provider, 'openrouter');
  assert.equal(body.model, 'black-forest-labs/flux-1.1-pro');
  // No pick: the service's own model, as before.
  assert.equal(images.serverBody(rows[1], { prompt: 'x', size: 'square' }).model, 'google/gemini-2.5-flash-image');
});

test('the first ready service draws when nothing was chosen, and the pick is honoured', () => {
  const rows = images.providerChoices(REPORT);
  assert.equal(images.chosen('', rows).id, 'ovhcloud');
  assert.equal(images.chosen('openrouter', rows).id, 'openrouter');
  assert.equal(images.chosen('nara', rows).id, 'nara');
  assert.equal(images.chosen('puter', rows).kind, 'browser');
  // A service that vanished from the report (the engine restarted with a
  // different environment) falls back rather than failing.
  assert.equal(images.chosen('gone', rows).id, 'ovhcloud');
});

test('a draw names the service, its model, and the shape in pixels', () => {
  const rows = images.providerChoices(REPORT);
  const body = images.serverBody(images.chosen('ovhcloud', rows), { prompt: 'a fox', size: 'wide' });
  assert.deepEqual(body, {
    prompt: 'a fox',
    provider: 'ovhcloud',
    size: '1536x864',
    quality: 'high',
    model: 'stable-diffusion-xl-base-v10',
  });
  // The browser row asks Puter for its own chain and gets a ratio, not pixels.
  const browser = images.chosen('puter', rows);
  assert.equal(images.modelFor(browser, 'generate'), images.PUTER_GENERATE_MODELS[0]);
  assert.equal(images.modelFor(browser, 'edit'), images.PUTER_EDIT_MODELS[0]);
  assert.equal(images.modelFor(browser, 'edit').indexOf('sunburst') >= 0, true);
  assert.equal(images.preset('wide').ratio.w, 16);
  assert.equal(images.sizeLabel('wide'), '16:9 · 1536×864');
});

test('a drawn picture says which service drew it', () => {
  const told = images.attribution({
    provider: 'ovhcloud',
    providerLabel: 'Free FLUX',
    model: 'stable-diffusion-xl-base-v10',
    notes: ['drawn 1:1 for a 16:9 request'],
  });
  assert.equal(told.who, 'Free FLUX · stable-diffusion-xl-base-v10');
  assert.deepEqual(told.notes, ['drawn 1:1 for a 16:9 request']);
  // A service that names no model is still named.
  assert.equal(images.attribution({ providerLabel: 'Free FLUX' }).who, 'Free FLUX');
  assert.equal(images.attribution({}).who, '');
});

test('the screen sends the service it chose, not a bare model id', () => {
  const screen = read('desktop', 'src', 'screens', 'ImagesScreen.tsx');
  assert.match(screen, /images\.serverBody\(choice, \{/);
  // The model on screen rides the request, not just the service.
  assert.match(screen, /kind: 'generate',\s*\n\s*model,/);
  assert.match(screen, /images\.modelsForChoice\(choice \|\| \{\}, 'generate'\)/);
  // Puter's sign-in is on screen whoever is selected -- not only when Puter is,
  // which is how it was impossible to find before choosing it.
  assert.ok(/puter-strip/.test(screen), 'the Puter row is always rendered');
  assert.ok(!/\{isBrowser && \(\s*<div className="puter-strip"/.test(screen), 'the Puter row is not conditional on the selection');
  assert.match(screen, /images\.providerChoices\(data\)/);
  // Puter is drawn in the browser, through the SDK bridge, only when chosen.
  assert.match(screen, /puter\.draw\(text, \{ model, ratio: shape\.ratio/);
  assert.match(screen, /Sign in to Puter/);
  assert.match(screen, /puter\.signIn\(/);
  // The picture says who drew it, and the failure says what was tried.
  assert.match(screen, /job\.who/);
  assert.match(screen, /job\.notes/);
  assert.match(screen, /failure\.attributeImage\(/);
  // The old checkbox is gone: the browser service is a row in the list.
  assert.ok(!/type="checkbox"/.test(screen), 'Puter is not a checkbox any more');
});

test('the Puter SDK is loaded on demand, and only when it is chosen', () => {
  const bridge = read('desktop', 'src', 'puter.js');
  assert.match(bridge, /https:\/\/js\.puter\.com\/v2\//);
  // Injected by a click, never at startup.
  assert.ok(!/main\.tsx[\s\S]{0,80}puter/.test(read('desktop', 'src', 'main.tsx')));
  assert.match(read('desktop', 'src', 'main.tsx'), /@fontsource-variable\/inter/);
  // The script origin is allowed by the app's own policy, so a strict CSP does
  // not silently break the one thing the user asked for.
  const conf = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));
  const csp = String(conf?.app?.security?.csp || '');
  assert.match(csp, /script-src 'self'[^;]*https:\/\/js\.puter\.com/, 'js.puter.com must be allowed by the CSP');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/, 'a local model server stays reachable');
});

test('the images screen offers a size, and the picker replaces the two dropdowns', () => {
  assert.ok(images.SIZE_PRESETS.length >= 4);
  const picker = read('desktop', 'src', 'components', 'ModelPicker.tsx');
  assert.match(picker, /providers/);
  assert.match(picker, /models/);
  assert.match(picker, /role="dialog"/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /<ModelPicker/);
  // Two selects for the same decision are gone from the header.
  assert.ok(!/className="model-select"[^>]*value=\{active\.provider\}/.test(chat));
});

// ---- no operating-system chrome ------------------------------------------
//
// A native <select> opens an OS-styled menu with a system font and highlight
// colour, which is the one thing in a hand-styled window that still read as a
// web page in a frame. Every choice is the app's own pill now, and this is the
// gate that keeps one from creeping back in.

test('choices are the app\'s own control, not the browser\'s', () => {
  const dir = path.join(ROOT, 'desktop', 'src');
  const walk = (at) => fs.readdirSync(at, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(at, e.name)) : [path.join(at, e.name)]);
  // Comments talk about the problem ("a <select> opens an OS menu"), so prose
  // is removed first and only code is judged.
  const codeOnly = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const offenders = walk(dir)
    .filter((f) => /\.tsx$/.test(f))
    .filter((f) => /<select[\s>]/.test(codeOnly(fs.readFileSync(f, 'utf8'))));
  assert.deepEqual(offenders, [], 'a native select is operating-system chrome');
  // And the pill is what replaced it, in the screens that used to have selects.
  for (const screen of ['ImagesScreen', 'DesignScreen', 'FilesScreen']) {
    assert.match(read('desktop', 'src', 'screens', `${screen}.tsx`), /<SelectPill/, `${screen} uses the pill`);
  }
});
