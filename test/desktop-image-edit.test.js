// Changing a picture, not only making one (NEURA-071).
//
// The rule this file exists to hold: the request an edit becomes is decided by
// one pure function, `images.editRequest`, and what it produces has to be what
// the engine actually reads. So the engine's own source is the reference --
// server.js's `llmImage` is read here and the field names are asserted against
// it, rather than against a shape somebody remembered. If the route's body ever
// changes, this fails instead of the user's edit failing.
//
// The three services are three different requests for the same question:
//   * the engine   -> POST /api/llm/images/edits, `image` beside prompt/provider
//   * Puter        -> txt2img with the picture as an input beside the words
//   * this PC      -> sd.cpp's img_gen with `init_image` and `strength`,
//                     because stable-diffusion.cpp serves no edit route at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const images = require('../desktop/src/images.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const serverJs = () => read('server.js');
const screen = () => read('desktop', 'src', 'screens', 'ImagesScreen.tsx');
const apiTs = () => read('desktop', 'src', 'api.ts');
const sdRs = () => read('desktop', 'src-tauri', 'src', 'sd.rs');
// The screen's dispatch moved to image-run.js (shared with Chat's /image and
// /edit), so what it sends is read from the screen and its runner together.
const runner = () => read('desktop', 'src', 'image-run.js');

// A one-pixel PNG is a real data URL without dragging a fixture file in.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const serverRow = (over) => Object.assign({
  id: 'openrouter',
  label: 'OpenRouter',
  kind: 'server',
  ready: true,
  model: 'google/gemini-2.5-flash-image',
  models: ['google/gemini-2.5-flash-image'],
  reason: '',
  note: '',
  edits: 'reference',
}, over || {});

const puterRow = () => images.providerChoices({}).find((r) => r.kind === 'browser');
const localRow = () => images.localRow({ found: true, binary: 'C:/sd/sd-server.exe', model: 'C:/sd/sdxl.safetensors' });

// ---- the engine's route, asserted against the engine ---------------------

test('the edit body carries the fields server.js actually reads', () => {
  const source = serverJs();
  // The route exists and is the one api.ts posts to.
  assert.match(source, /urlPath === '\/api\/llm\/images\/edits'/);
  assert.match(apiTs(), /request\('\/api\/llm\/images\/edits', \{ method: 'POST'/);
  // What llmImage reads off the body, read out of llmImage itself.
  const handler = source.slice(source.indexOf('async function llmImage'), source.indexOf('async function llmImageProviders'));
  for (const field of ['body.prompt', 'body.provider', 'body.model', 'body.size', 'body.quality', 'body.image', 'body.mask']) {
    assert.ok(handler.includes(field), `llmImage reads ${field}`);
  }

  const plan = images.editRequest(serverRow(), { prompt: 'make the sky blue', source: PNG, size: 'landscape' });
  assert.equal(plan.error, undefined);
  assert.equal(plan.route, 'server');
  assert.deepEqual(Object.keys(plan.body).sort(), ['image', 'model', 'prompt', 'provider', 'quality', 'size'].sort());
  assert.equal(plan.body.provider, 'openrouter', 'the service is pinned, not guessed from a model id');
  assert.equal(plan.body.image, PNG);
  assert.equal(plan.body.size, '1536x1024');
  assert.equal(plan.body.quality, images.QUALITY);
  // And nothing invented: every key of the body is one the handler reads.
  for (const key of Object.keys(plan.body)) {
    assert.ok(handler.includes('body.' + key), `server.js never reads body.${key}`);
  }
});

test('the source is a data URL or a link, which is the engine\'s own rule', () => {
  // imageBytesFor accepts exactly those two and says so.
  assert.match(serverJs(), /expected a data URL or an http\(s\) link/);
  assert.equal(images.editRequest(serverRow(), { prompt: 'x', source: 'https://example.com/a.png' }).route, 'server');
  const bad = images.editRequest(serverRow(), { prompt: 'x', source: 'C:/Users/me/holiday.png' });
  assert.equal(bad.route, undefined);
  assert.match(bad.error, /not a picture this can read/);
});

// ---- a service that cannot edit is refused, with the reason --------------

test('a service that only draws is refused before anything is sent', () => {
  const draws = serverRow({ id: 'pollinations', label: 'Pollinations', edits: 'none' });
  assert.equal(images.canEdit(draws), false);
  const plan = images.editRequest(draws, { prompt: 'make it blue', source: PNG });
  assert.equal(plan.body, undefined, 'no request is built');
  assert.match(plan.error, /Pollinations/);
  assert.match(plan.error, /only draw a new picture|cannot/i);
  // The engine agrees: it steps past such a provider rather than drawing a new
  // picture and passing it off as the change that was asked for.
  assert.match(serverJs(), /cannot edit, only generate/);
});

test('the two edit modes the engine reports are the two that can edit', () => {
  // server.js turns store.edit into the report's vocabulary; both spellings
  // that reach this file mean "can be handed a picture".
  assert.match(serverJs(), /store\.edit === 'multipart' \? 'mask' : store\.edit === 'references' \? 'reference' : 'none'/);
  assert.equal(images.canEdit(serverRow({ edits: 'mask' })), true);
  assert.equal(images.canEdit(serverRow({ edits: 'reference' })), true);
  assert.equal(images.canEdit(serverRow({ edits: 'none' })), false);
  assert.equal(images.canEdit(serverRow({ edits: '' })), false);
  // Only the file-part services can be handed a mask, which is the engine's
  // rule too: it drops a mask it cannot send and says so.
  assert.equal(images.canMask(serverRow({ edits: 'mask' })), true);
  assert.equal(images.canMask(serverRow({ edits: 'reference' })), false);
  assert.match(serverJs(), /the brush mask was dropped/);
});

test('a mask rides only where it can be sent, and is said out loud otherwise', () => {
  const withMask = images.editRequest(serverRow({ edits: 'mask' }), { prompt: 'x', source: PNG, mask: PNG });
  assert.equal(withMask.body.mask, PNG);
  assert.deepEqual(withMask.notes, []);
  const dropped = images.editRequest(serverRow({ edits: 'reference' }), { prompt: 'x', source: PNG, mask: PNG });
  assert.equal(dropped.body.mask, undefined);
  assert.equal(dropped.notes.length, 1);
  assert.match(dropped.notes[0], /mask was left out/);
  // A mask that is not a picture is refused rather than sent as text.
  assert.match(images.editRequest(serverRow({ edits: 'mask' }), { prompt: 'x', source: PNG, mask: 'not-a-picture' }).error, /mask/);
});

// ---- a missing source never produces a request --------------------------

test('no source, no request -- and no prompt, no request', () => {
  for (const missing of ['', null, undefined]) {
    const plan = images.editRequest(serverRow(), { prompt: 'make it blue', source: missing });
    assert.equal(plan.route, undefined);
    assert.equal(plan.body, undefined);
    assert.match(plan.error, /Choose a picture/);
  }
  const noWords = images.editRequest(serverRow(), { prompt: '   ', source: PNG });
  assert.equal(noWords.body, undefined);
  assert.match(noWords.error, /Say what to change/);
  // And nothing at all chosen is a sentence, not a crash.
  assert.match(images.editRequest(null, { prompt: 'x', source: PNG }).error, /Pick a service/);
});

// ---- the model comes from the edit chain --------------------------------

test('an edit is offered the edit models, never the generate ones', () => {
  const puter = puterRow();
  assert.deepEqual(images.modelsFor('edit'), images.PUTER_EDIT_MODELS);
  assert.notDeepEqual(images.PUTER_EDIT_MODELS, images.PUTER_GENERATE_MODELS);
  assert.deepEqual(images.modelsForChoice(puter, 'edit'), images.PUTER_EDIT_MODELS);
  // The default for an edit is the head of the edit chain, not of the other.
  assert.equal(images.modelFor(puter, 'edit'), images.PUTER_EDIT_MODELS[0]);
  const plan = images.editRequest(puter, { prompt: 'make it blue', source: PNG, size: 'square' });
  assert.equal(plan.route, 'browser');
  assert.equal(plan.body.model, images.PUTER_EDIT_MODELS[0]);
  assert.equal(plan.body.source, PNG, 'Puter is handed the picture beside the words');
  assert.deepEqual(plan.body.ratio, images.preset('square').ratio);
  assert.equal(plan.body.quality, images.QUALITY);

  // And that chain is what the screen puts in the picker for an edit.
  const source = screen();
  assert.match(source, /images\.modelsForChoice\(choice \|\| \{\}, 'edit'\)/);
  assert.match(source, /(?:images|imageRun)\.modelFor\(choice, mode === 'edit' \? 'edit' : 'generate'/);
  // A model the user picked still wins over the chain's head.
  const picked = images.editRequest(puter, { prompt: 'x', source: PNG, model: images.PUTER_EDIT_MODELS[1] });
  assert.equal(picked.body.model, images.PUTER_EDIT_MODELS[1]);
});

// ---- this PC ------------------------------------------------------------

test('on this PC an edit is the same job with an init image and a strength', () => {
  const plan = images.editRequest(localRow(), {
    prompt: 'make it blue',
    source: PNG,
    size: 'square',
    sourceWidth: 900,
    sourceHeight: 604,
  });
  assert.equal(plan.route, 'local');
  assert.equal(plan.body.initImage, PNG);
  assert.equal(plan.body.strength, images.LOCAL_EDIT_STRENGTH);
  assert.ok(images.LOCAL_EDIT_STRENGTH > 0 && images.LOCAL_EDIT_STRENGTH <= 1);
  // The shape follows the source, snapped to what sd.cpp draws -- resizing a
  // picture somebody asked to CHANGE is a change nobody asked for.
  assert.equal(plan.body.width, images.localSide(900));
  assert.equal(plan.body.height, images.localSide(604));
  assert.equal(plan.body.width % images.LOCAL_STEP_PX, 0);
  // Without a measurement it falls back to the preset rather than guessing.
  const bare = images.editRequest(localRow(), { prompt: 'x', source: PNG, size: 'portrait' });
  assert.equal(bare.body.width, images.localSize('portrait').width);
  // A link is not bytes: this PC is never asked to go and fetch one.
  const linked = images.editRequest(localRow(), { prompt: 'x', source: 'https://example.com/a.png' });
  assert.equal(linked.body, undefined);
  assert.match(linked.error, /bytes|image file/i);
});

test('the shell sends the fields stable-diffusion.cpp documents for an edit', () => {
  const source = sdRs();
  // sd.cpp has no edit endpoint: img_gen carries init_image and strength.
  assert.match(source, /"init_image"/);
  assert.match(source, /"strength"/);
  assert.ok(!/img_edit|img2img/.test(source), 'no endpoint was invented');
  // A source picture is base64 or it is refused -- never a path this process
  // would go and read on a page's say-so.
  assert.match(source, /fn valid_init_image\(raw: &str\) -> Result<String, String>/);
  assert.match(source, /MAX_INIT_IMAGE_CHARS/);
  // A mask rides beside the picture it belongs to, checked like the picture:
  // base64 or a data: URL, never a path.
  assert.match(source, /pub fn with_mask\(/);
  assert.match(source, /"mask_image"/);
  assert.match(source, /Some\(raw\) => Some\(valid_init_image\(&raw\)\?\)/);
});

// A painted mask on this PC: white where it may change, black where it must
// stay. sd.cpp documents the field as one channel; the brush paints only
// black and white, so the channels agree whichever one the server reads.
test('on this PC a painted mask rides with the picture, and only as bytes', () => {
  assert.equal(images.canMask(localRow()), true, 'this PC takes a mask');
  const plan = images.editRequest(localRow(), { prompt: 'a red cube', source: PNG, mask: PNG });
  assert.equal(plan.route, 'local');
  assert.equal(plan.body.initImage, PNG);
  assert.equal(plan.body.maskImage, PNG);
  assert.equal(plan.body.strength, images.LOCAL_MASK_STRENGTH, 'a masked area is redrawn, not blended');
  assert.deepEqual(plan.notes, [], 'nothing was dropped, so nothing is said');
  // No mask, no field: a whole-picture change is exactly what it was before.
  const whole = images.editRequest(localRow(), { prompt: 'x', source: PNG });
  assert.equal('maskImage' in whole.body, false);
  assert.equal(whole.body.strength, images.LOCAL_EDIT_STRENGTH);
  // A mask named by a link is refused for the same reason a source is.
  const linked = images.editRequest(localRow(), { prompt: 'x', source: PNG, mask: 'https://example.com/m.png' });
  assert.equal(linked.body, undefined);
  assert.match(linked.error, /mask/i);
});

test('the screen paints the mask over the picture it belongs to', () => {
  const source = screen();
  assert.match(source, /<MaskBrush/, 'a brush, not only a file picker');
  const brush = read('desktop', 'src', 'components', 'MaskBrush.tsx');
  // The mask is drawn at the picture's own size, black then white strokes,
  // and handed back as PNG bytes -- the shape sd-server reads.
  assert.match(brush, /fillStyle = '#000'/);
  assert.match(brush, /off\.strokeStyle = erasing \? '#000' : '#fff'/, 'white paints, black erases');
  assert.match(brush, /toDataURL\('image\/png'\)/);
  assert.match(brush, /onPointerDown/);
});

// ---- the screen ---------------------------------------------------------

test('the screen edits through the pure plan, and never sends what it was not given', () => {
  const source = screen() + runner();
  // One decision point: the screen asks images.editRequest and the shared
  // runner carries it out.
  assert.match(source, /images\.editRequest\(choice, \{/);
  assert.match(source, /if \(!plan\.route\) \{/, 'a refusal stops before anything is sent');
  assert.match(source, /imageRun\.runImage\(kind, choice, plan, /);
  assert.match(runner(), /kind === 'edit' \? d\.api\.imageEdit : d\.api\.imageGenerate/);
  assert.match(runner(), /send\(plan\.body\)/);
  assert.match(runner(), /puter\.draw\(plan\.body\.prompt, plan\.body\)/);
  assert.match(runner(), /runLocal\(plan\.body, d\)/);
  // The picture is read in this window, not uploaded to anything on the way.
  assert.match(source, /readAsDataURL/);
  assert.ok(!/fetch\(\s*['"`]http/.test(source), 'the page must not talk to a server directly');
  // Both failure vocabularies are the existing ones, not a second set.
  assert.match(source, /images\.describePuterError\(e\)/);
  assert.match(source, /images\.puterAdvice\(message\)/);
  assert.match(source, /images\.localAdvice\(message\)/);
  assert.match(source, /failure\.attributeImage\(/);
});

test('the screen says who is doing it, and that it costs something', () => {
  const source = screen();
  assert.match(source, /Puter charges the account that is signed in/);
  assert.match(source, /a change costs what a draw costs/);
  assert.match(source, /no account, no network/);
  // A service that cannot edit is greyed with the reason, not offered.
  assert.match(source, /disabled: mode === 'edit' && !images\.canEdit\(r\)/);
  assert.match(source, /images\.editReason\(choice \|\| \{\}\)/);
  // Sentence case, active voice: no shouting labels in the new copy.
  for (const label of ['Change the picture', 'Change this', 'Choose mask…', 'Make a picture', 'Change a picture']) {
    assert.ok(source.includes(label), `${label} is on screen`);
    assert.notEqual(label, label.toUpperCase());
  }
});

test('no bare TODO was left in the files this work touched', () => {
  for (const file of [
    ['desktop', 'src', 'images.js'],
    ['desktop', 'src', 'images.d.ts'],
    ['desktop', 'src', 'api.ts'],
    ['desktop', 'src', 'screens', 'ImagesScreen.tsx'],
    ['desktop', 'src-tauri', 'src', 'sd.rs'],
  ]) {
    const text = read(...file);
    for (const hit of text.match(/TODO[^(]/g) || []) {
      assert.fail(`${file.join('/')} has a bare ${hit.trim()}`);
    }
  }
});
