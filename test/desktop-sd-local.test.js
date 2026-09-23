// NEURA-059: drawing on this PC, through the user's own sd-server.
//
// The promise is "no account and no network", so the things asserted here are
// the ones that would quietly break it:
//
//   * the address is 127.0.0.1 and nothing else can be configured -- sd-server
//     has no api key, so the bind address is the entire boundary;
//   * a missing binary or a missing model SAYS SO, before anything is spawned
//     or polled, rather than leaving the screen on "Drawing…" forever;
//   * a job can be cancelled, and a cancelled job is not an error;
//   * the request body is the one stable-diffusion.cpp documents
//     (examples/server/api.md: POST /sdcpp/v1/img_gen, GET /sdcpp/v1/jobs/{id},
//     POST /sdcpp/v1/jobs/{id}/cancel), not a shape invented here;
//   * the screen never shows a frame it did not get bytes for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const images = require('../desktop/src/images.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const sdRs = () => read('desktop', 'src-tauri', 'src', 'sd.rs');
const screen = () => read('desktop', 'src', 'screens', 'ImagesScreen.tsx');
// The screen's dispatch moved to image-run.js (shared with Chat's /image and
// /edit), so what it sends is read from the screen and its runner together.
const runner = () => read('desktop', 'src', 'image-run.js');
const card = () => read('desktop', 'src', 'components', 'LocalImagesCard.tsx');

const FACTS = {
  found: true,
  binary: 'C:\\sd\\sd-server.exe',
  source: 'saved',
  model: 'C:\\sd\\models\\sd_v1.5-q8_0.gguf',
  models: [{ name: 'sd_v1.5-q8_0.gguf', path: 'C:\\sd\\models\\sd_v1.5-q8_0.gguf', bytes: 2e9 }],
  models_dir: 'C:\\data\\sd-models',
  expected_name: 'sd-server.exe',
  releases_url: 'https://github.com/leejet/stable-diffusion.cpp/releases/latest',
  models_url: 'https://huggingface.co/models?library=gguf&other=stable-diffusion',
  default_port: 1234,
};

// ---- loopback, and only loopback -----------------------------------------

test('the shell builds one address, on this machine, and takes no host from anybody', () => {
  const source = sdRs();
  // Every http address this module can produce is this machine.
  const addresses = [...source.matchAll(/http:\/\/[^\s"')]*/g)].map((m) => m[0]);
  assert.ok(addresses.length > 0, 'the module must build an address at all');
  for (const address of addresses) {
    assert.ok(address.startsWith('http://127.0.0.1'), `${address} is not this machine`);
  }
  // No command may accept a host, a base or a url: there is nothing to point
  // somewhere else with.
  assert.ok(!/\b(host|base|url): (Option<)?String/.test(source), 'no command may take an address');
  // Every request this module makes is built from that one address.
  const sends = [...source.matchAll(/\.send\(\)/g)].length;
  const built = [...source.matchAll(/format!\("\{\}\/[^"]*", base_url\(/g)].length;
  assert.ok(sends > 0, 'the module must make requests at all');
  assert.equal(built, sends, 'every request is built from base_url(port)');
  assert.ok(
    /"--listen-ip"\.to_string\(\),\s*\n\s*"127\.0\.0\.1"\.to_string\(\)/.test(source),
    'sd-server must be bound to 127.0.0.1',
  );
  // https is only ever the two pages a person opens to GET the binary/weights.
  const secure = [...source.matchAll(/https:\/\/[^\s"')]*/g)].map((m) => m[0]);
  for (const link of secure) {
    assert.ok(
      link.startsWith('https://github.com/') || link.startsWith('https://huggingface.co/'),
      `${link} is not a page this app links to`,
    );
  }
});

test('the frontend has no address at all to get wrong', () => {
  const source = read('desktop', 'src', 'images.js');
  const local = source.slice(source.indexOf('LOCAL_ID'));
  assert.ok(!/https?:\/\//.test(local), 'the local rules must not name a server');
  assert.ok(!/localhost|127\.0\.0\.1/.test(local), 'the address belongs to the shell alone');
  // And the screen reaches the server only through the shell's commands.
  assert.ok(!/fetch\(\s*['"`]http/.test(screen()), 'the page must not talk to the server directly');
});

// ---- nothing is downloaded, and both halves are the user's ---------------

test('the binary and the weights are picked, never fetched', () => {
  const source = sdRs();
  assert.match(source, /pub fn sd_pick_binary/);
  assert.match(source, /pub fn sd_pick_model/);
  assert.match(source, /rfd::FileDialog::new\(\)/);
  // No downloader: a "local, no network" feature that fetches gigabytes is
  // not the feature it says it is. The two https links are opened in the
  // user's browser by the card, never requested here.
  assert.ok(!/\.get\(&?(RELEASES_URL|MODELS_URL)|\.bytes\(\)|bytes_stream/.test(source), 'sd.rs must not fetch files');
  assert.ok(!/huggingface\.co\/[^\s"]*resolve/.test(source), 'no weight URLs');
  // The card offers the two pickers and nothing that says "download".
  assert.match(card(), /sd_pick_binary/);
  assert.match(card(), /sd_pick_model/);
});

test('a row is only ready when both halves are there, and says which is missing', () => {
  const ready = images.localRow(FACTS);
  assert.equal(ready.id, images.LOCAL_ID);
  assert.equal(ready.kind, 'local');
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, '');
  assert.equal(ready.model, 'sd_v1.5-q8_0.gguf', 'the caption is the file name, not a whole path');

  const noBinary = images.localRow({ ...FACTS, found: false, binary: '' });
  assert.equal(noBinary.ready, false);
  assert.match(noBinary.reason, /sd-server/);

  const noModel = images.localRow({ ...FACTS, model: '' });
  assert.equal(noModel.ready, false);
  assert.match(noModel.reason, /model/i);

  // No shell, no facts, no pretending.
  assert.equal(images.localRow(null).ready, false);
});

test('the row joins the list only when the shell reported it', () => {
  const report = { providers: [{ id: 'ovhcloud', label: 'Free FLUX', ready: true, model: 'sdxl' }] };
  const without = images.withLocal(images.providerChoices(report), null);
  assert.ok(!without.some((r) => r.kind === 'local'), 'a browser build has no local row');

  const withLocal = images.withLocal(images.providerChoices(report), FACTS);
  assert.equal(withLocal[0].kind, 'local', 'this PC comes first: it needs no account');
  assert.ok(withLocal.some((r) => r.id === 'ovhcloud'));
  assert.ok(withLocal.some((r) => r.kind === 'browser'));

  // ...but it is never chosen for somebody: minutes of their own CPU is not
  // a thing to start unasked.
  assert.equal(images.chosen('', withLocal).id, 'ovhcloud');
  assert.equal(images.chosen('local', withLocal).kind, 'local');
  assert.equal(images.isLocal(images.chosen('local', withLocal)), true);
  assert.equal(images.isLocal(images.chosen('ovhcloud', withLocal)), false);
});

// ---- a missing binary says so, rather than hanging -----------------------

test('the shell refuses to start before it spawns or polls anything', () => {
  const source = sdRs();
  const start = source.slice(source.indexOf('pub async fn sd_start'));
  const missingBinary = start.indexOf('is not set up');
  const missingModel = start.indexOf('No model chosen');
  const spawn = start.indexOf('.spawn()');
  const loop = start.indexOf('let deadline');
  assert.ok(missingBinary > -1 && missingModel > -1, 'both halves must have their own words');
  assert.ok(missingBinary < spawn && missingModel < spawn, 'nothing is spawned before the checks');
  assert.ok(spawn < loop, 'and nothing is polled before something was spawned');
  // The wait is bounded and says so, so a model that never loads is an error
  // rather than a screen that sits at "Drawing…".
  assert.match(source, /pub const START_TIMEOUT_SECS: u64 = \d+;/);
  assert.match(start, /did not become ready within/);
  assert.match(start, /shutdown\(\);/, 'a failed start leaves no child behind');
});

test('generating without a running server is an error, not a wait', () => {
  const source = sdRs();
  const generate = source.slice(source.indexOf('pub async fn sd_generate'));
  assert.match(generate, /is not running/);
  assert.match(generate, /An image needs a prompt\./);
  // And every request has a timeout, so a wedged server does not wedge the app.
  const timeouts = [...source.matchAll(/client\(Duration::from_secs\((\d+)\)\)/g)].map((m) => Number(m[1]));
  assert.ok(timeouts.length >= 3, 'submit, poll and cancel are all timed');
  for (const seconds of timeouts) assert.ok(seconds > 0 && seconds <= 60, `${seconds}s is not a timeout`);
});

test('the advice for a local failure tells somebody what to do next', () => {
  assert.match(images.localAdvice('sd-server.exe is not set up: choose it under Images'), /Choose sd-server/);
  assert.match(images.localAdvice('No model chosen'), /model file/);
  assert.match(images.localAdvice('sd-server did not become ready within 300 s.'), /too big|sd\.cpp loads/);
  assert.ok(images.localAdvice('something else entirely').length > 0);
});

// ---- cancel -------------------------------------------------------------

test('a cancelled job is finished, not failed, and carries no image', () => {
  const view = images.localJobView({ id: 'job_1', status: 'cancelled' });
  assert.equal(view.state, 'cancelled');
  assert.equal(view.done, true);
  assert.equal(view.url, '');
  assert.equal(view.error, '');
});

test('the shell can stop a job, and a job already gone counts as stopped', () => {
  const source = sdRs();
  const cancel = source.slice(source.indexOf('pub async fn sd_cancel'));
  assert.match(cancel, /\/sdcpp\/v1\/jobs\/\{\}\/cancel/);
  assert.match(cancel, /code == 404 \|\| code == 410/, '404/410 means it is already stopped');
  assert.match(cancel, /valid_job_id/);
  // A job id cannot walk the URL somewhere else.
  const guard = source.slice(source.indexOf('pub fn valid_job_id'));
  assert.match(guard, /is_ascii_alphanumeric\(\) \|\| c == '_' \|\| c == '-'/);
});

test('the screen offers Cancel while a local job runs, and stops polling', () => {
  const source = screen();
  assert.match(source, /const cancelHere = async \(\)/);
  assert.match(source, /call\('sd_cancel', \{ id \}\)/);
  assert.match(source, /onClick=\{cancelHere\}/);
  assert.match(source, /stopPolling\.current = true;/);
  // Polling is awaited in small steps, so the window keeps painting.
  assert.match(source, /stopped: \(\) => stopPolling\.current/);
  assert.match(runner(), /pause\(\d+\)\.then/);
  assert.ok(!/while \(true\) \{\s*const/.test(source), 'no tight loop');
});

test('a running job says what the server said, and for how long', () => {
  assert.equal(images.localJobView({ status: 'queued', queue_position: 3 }).label, 'Queued, 3 ahead');
  assert.equal(images.localJobView({ status: 'queued' }).label, 'Queued');
  const going = images.localJobView({ status: 'generating' });
  assert.equal(going.done, false);
  assert.match(going.label, /this PC/i);
  // An unknown status is "working", never "done": a build of sd-server that
  // calls it something else must not look like a finished picture.
  const odd = images.localJobView({ status: 'whatever-this-build-says' });
  assert.equal(odd.done, false);
  assert.equal(odd.url, '');
  assert.equal(images.localElapsed(4000), '4s');
  assert.equal(images.localElapsed(125000), '2m 5s');
  assert.equal(images.localElapsed(undefined), '0s');
});

// ---- the documented request ---------------------------------------------

test('the shell posts the body and paths stable-diffusion.cpp documents', () => {
  const source = sdRs();
  // The three endpoints of the native async API, verified against
  // examples/server/api.md (the module header records where).
  assert.match(source, /\/sdcpp\/v1\/img_gen/);
  assert.match(source, /\/sdcpp\/v1\/jobs\/\{\}/);
  assert.match(source, /\/sdcpp\/v1\/capabilities/);
  const body = source.slice(source.indexOf('pub fn job_body'), source.indexOf('fn valid_side'));
  for (const field of ['"prompt"', '"negative_prompt"', '"width"', '"height"', '"batch_count"', '"sample_params"', '"sample_steps"', '"seed"']) {
    assert.ok(body.includes(field), `the documented field ${field} is missing`);
  }
  // A completed job is read as the documented result: images[].b64_json.
  assert.match(source, /result\.images\[\]\.b64_json/);
  // The flags are sd-server's own.
  assert.match(source, /"--listen-port"/);
  assert.match(source, /pub const DEFAULT_PORT: u16 = 1234;/);
});

test('the size asked for is a size sd.cpp will draw', () => {
  // sd.cpp works in multiples of 64: 864 (the 16:9 preset) is not one, so it
  // is snapped here rather than refused by the server after Draw was pressed.
  assert.equal(images.localSide(864), 896);
  assert.equal(images.localSide(1024), 1024);
  assert.equal(images.localSide(0), images.LOCAL_STEP_PX);
  assert.equal(images.localSide(99999), images.LOCAL_MAX_PX);
  for (const preset of images.SIZE_PRESETS) {
    const shape = images.localSize(preset.id);
    assert.equal(shape.width % images.LOCAL_STEP_PX, 0, `${preset.id} width`);
    assert.equal(shape.height % images.LOCAL_STEP_PX, 0, `${preset.id} height`);
    assert.ok(shape.width <= images.LOCAL_MAX_PX && shape.height <= images.LOCAL_MAX_PX);
  }
  // And the shell refuses anything else, so the page is not the only guard.
  const source = sdRs();
  assert.match(source, /fn valid_side/);
  assert.match(source, /\(64\.\.=2048\)\.contains\(&side\)/);
  assert.match(source, /side % 64 != 0/);
});

test('the request the screen sends carries the prompt and the shape, and nothing else', () => {
  const request = images.localRequest({ prompt: '  a lighthouse  ', size: 'wide' });
  assert.deepEqual(request, {
    prompt: 'a lighthouse',
    negativePrompt: '',
    width: 1536,
    height: 896,
    steps: images.LOCAL_STEPS,
  });
  assert.equal(images.localRequest({ prompt: 'x', size: 'square', steps: 8 }).steps, 8);
  assert.equal(images.localRequest({ prompt: 'x', size: 'square', steps: -3 }).steps, images.LOCAL_STEPS);
});

// ---- the page never assumes an image -------------------------------------

test('a job that finished without bytes is an error, never a picture', () => {
  const empty = images.localJobView({ status: 'completed', result: { images: [] } });
  assert.equal(empty.url, '');
  assert.equal(empty.done, true);
  assert.match(empty.error, /without an image/);

  const noResult = images.localJobView({ status: 'completed' });
  assert.equal(noResult.url, '');
  assert.match(noResult.error, /without an image/);

  const failed = images.localJobView({ status: 'failed', error: 'out of memory' });
  assert.equal(failed.url, '');
  assert.equal(failed.error, 'out of memory');

  // Nothing at all is still not a picture.
  assert.equal(images.localJobView(null).url, '');
  assert.equal(images.localJobView(null).done, false);
});

test('a completed job becomes a data: URL in the format the server named', () => {
  const png = images.localJobView({ status: 'completed', result: { output_format: 'png', images: [{ index: 0, b64_json: 'AAAB' }] } });
  assert.equal(png.url, 'data:image/png;base64,AAAB');
  assert.equal(png.done, true);
  assert.equal(png.error, '');
  const jpeg = images.localJobView({ status: 'completed', result: { output_format: 'jpeg', images: [{ b64_json: 'AAAB' }] } });
  assert.equal(jpeg.url, 'data:image/jpeg;base64,AAAB');
  // An output_format nobody recognises still produces something a browser can
  // show, rather than a mime type made up from a server's string.
  const odd = images.localJobView({ status: 'completed', result: { output_format: 'exr', images: [{ b64_json: 'AAAB' }] } });
  assert.equal(odd.url, 'data:image/png;base64,AAAB');
});

test('the screen only adds a card once it has the bytes, and saves the way it already does', () => {
  const source = screen();
  const draw = source.slice(source.indexOf('const run = async'), source.indexOf('const onKey'));
  assert.match(draw, /const done = await imageRun\.runImage\(kind, choice, plan, runDeps\(\)\);\s*\n\s*if \(!done\) return;/);
  assert.match(draw, /url: done\.url,/);
  assert.match(draw, /setGallery\(\(prev\) => \[/);
  // The image goes into the same gallery, with the same Save button, that
  // every other service's image goes into: no new folder was invented.
  assert.match(source, /imageRun\.savePicture\(url\)/);
  assert.match(runner(), /a\.download = 'freeai4u-' \+ Date\.now\(\) \+ '\.png'/);
  assert.ok(!/sd_save|writeLocalFile|save_file_dialog/.test(source), 'no second place for images');
  assert.ok(!/std::fs::write/.test(sdRs().slice(sdRs().indexOf('pub async fn sd_generate'))), 'the shell writes no image files');
});

// ---- the process is owned ------------------------------------------------

test('the server is stopped on demand and on exit, and never doubled', () => {
  const source = sdRs();
  assert.match(source, /pub fn shutdown\(\)/);
  assert.match(source, /run\.child\.kill\(\);[\s\S]{0,80}run\.child\.wait\(\);/);
  assert.match(source, /pub fn sd_stop\(\)/);
  // One server at a time: a second start kills the first.
  const start = source.slice(source.indexOf('pub async fn sd_start'));
  assert.ok(start.indexOf('shutdown();') < start.indexOf('.spawn()'), 'the old child goes before a new one');
  // The main session wires the exit; this test states what it must wire, so
  // a missed line is a red test rather than an orphaned process.
  assert.match(source, /shutdown\(\)` does the same on app exit/);
});

test('the card can start and stop the server, and says which it is', () => {
  const source = card();
  assert.match(source, /onStart/);
  assert.match(source, /onStop/);
  assert.match(source, /Loading the model…/);
  assert.match(screen(), /call\('sd_stop'\)/);
  assert.match(screen(), /call<SdStatus>\('sd_start', \{ port: null, threads: null \}\)/);
});
