// Running a model on this machine: the catalogue, the memory guard and the
// lifecycle.
//
// The guard is the part that matters. Starting a model the machine cannot hold
// is the one way this feature can freeze somebody's computer, so it is a rule
// with a number behind it (src/local-models.js), not a warning in a component --
// and the lifecycle has one non-negotiable: a process that has not answered
// `/health` is `starting`, never `ready`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const local = require('../desktop/src/local-models.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---- the catalogue -------------------------------------------------------

test('every model says its repo, quant, size and context', () => {
  assert.ok(local.CATALOGUE.length >= 4, 'a catalogue worth choosing from');
  for (const entry of local.CATALOGUE) {
    assert.match(entry.id, /^[\w.-]+\/[\w.-]+$/, `${entry.id} must be a Hugging Face repo`);
    assert.ok(entry.quant, `${entry.id} needs a quant`);
    assert.ok(entry.sizeGb > 0, `${entry.id} needs a size, or the guard cannot work`);
    assert.ok(entry.context >= 4096, `${entry.id} needs a context`);
    assert.ok(entry.label && entry.note, `${entry.id} needs words for a person`);
  }
  // Smallest first would be a picker nobody reads; the list is ordered by
  // capability on purpose, and the guard carries the safety.
  const sizes = local.CATALOGUE.map((e) => e.sizeGb);
  assert.equal(new Set(sizes).size, sizes.length, 'no two entries may look identical');
});

// ---- the memory guard ----------------------------------------------------

test('the guard refuses a model the machine cannot hold, and says the numbers', () => {
  const big = local.CATALOGUE.find((e) => e.sizeGb > 10);
  const small = local.CATALOGUE.find((e) => e.sizeGb < 1);

  const laptop = { ramGb: 8, ramKnown: true, cores: 4 };
  const bigOnLaptop = local.fit(big, laptop);
  assert.equal(bigOnLaptop.fits, false);
  assert.match(bigOnLaptop.reason, /Needs about [\d.]+ GB/);
  assert.match(bigOnLaptop.reason, /reports 8 GB/);

  const laptopSmall = local.fit(small, laptop);
  assert.equal(laptopSmall.fits, true);
  assert.equal(laptopSmall.reason, '');

  // The same model on a workstation is fine -- the guard is about this machine.
  assert.equal(local.fit(big, { ramGb: 64, ramKnown: true, cores: 16 }).fits, true);
});

test('the estimate counts the cache, not just the weights', () => {
  const entry = { sizeGb: 2, context: 32768 };
  const report = local.fit(entry, { ramGb: 64, ramKnown: true, cores: 8 });
  assert.ok(report.neededGb > entry.sizeGb, 'weights alone are not the whole cost');
  assert.ok(report.kvGb > 0, 'a long context has a cache');
  // And a bigger context costs more than a smaller one.
  const small = local.fit({ sizeGb: 2, context: 4096 }, { ramGb: 64, ramKnown: true, cores: 8 });
  assert.ok(report.neededGb > small.neededGb);
});

test('an unknown amount of memory is treated as the floor, not as plenty', () => {
  // deviceMemory is not available everywhere; pretending the machine is huge
  // would let the guard through on exactly the machines that need it.
  const facts = local.machine();
  assert.ok(facts.ramGb >= 4);
  assert.equal(typeof facts.ramKnown, 'boolean');
  assert.ok(facts.cores >= 1);
});

test('a model that only just fits is called tight, not comfortable', () => {
  const entry = { sizeGb: 4, context: 8192 };
  const report = local.fit(entry, { ramGb: 8, ramKnown: true, cores: 4 });
  assert.equal(report.fits, true);
  assert.equal(report.tight, true);
});

// ---- the lifecycle -------------------------------------------------------

test('a server that has not answered yet is starting, never ready', () => {
  assert.equal(local.stateOf({ state: 'stopped' }), 'stopped');
  assert.equal(local.stateOf({ state: 'starting' }), 'starting');
  assert.equal(local.stateOf({ state: 'ready' }), 'ready');
  assert.equal(local.stateOf({ state: 'broken' }), 'error', 'an unknown state is not a working one');
  assert.equal(local.stateOf(null), 'stopped');
  assert.deepEqual(local.STATES, ['stopped', 'starting', 'ready', 'error']);
});

test('the status line says what is loaded and where it is listening', () => {
  assert.equal(local.statusLine({ state: 'stopped' }), 'No local model running');
  assert.match(local.statusLine({ state: 'starting', repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF' }), /Loading Llama-3.2-3B-Instruct-GGUF/);
  const ready = local.statusLine({
    state: 'ready',
    repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF',
    base_url: 'http://127.0.0.1:8080',
    uptime_ms: 125000,
  });
  assert.match(ready, /Llama-3.2-3B-Instruct-GGUF ready/);
  assert.match(ready, /127\.0\.0\.1:8080/);
  assert.match(ready, /up 125s/);
  assert.match(local.statusLine({ state: 'error', detail: 'llama-server exited with exit code: 1' }), /exited/);
});

test('the loading ring measures the shell’s deadline, not a pleasing speed', () => {
  const starting = { state: 'starting', repo: 'unsloth/Qwen3-Coder-1.5B-GGUF', uptime_ms: 42000 };
  const warm = local.warmup(starting);
  assert.equal(warm.elapsedSeconds, 42, 'elapsed time is what the shell reported');
  assert.equal(warm.deadlineSeconds, local.WARMUP_MS / 1000);
  assert.equal(warm.label, '42s of 180s', 'the chip says the real numbers');
  assert.ok(Math.abs(warm.fraction - 42 / 180) < 0.001, 'and the ring is that fraction of the circle');

  // Nothing loading means nothing to draw: a ring that sits at zero next to a
  // stopped server is noise pretending to be progress.
  for (const state of ['stopped', 'ready', 'error']) {
    assert.equal(local.warmup({ state, uptime_ms: 5000 }), null, `${state} has no warm-up to show`);
  }

  // A server still not answering at the deadline is the shell's problem to
  // report, not a ring that overfills.
  const late = local.warmup({ state: 'starting', uptime_ms: 900000 });
  assert.equal(late.fraction, 1, 'the ring never passes full');

  const fresh = local.warmup({ state: 'starting' });
  assert.equal(fresh.elapsedSeconds, 0, 'a missing uptime is the start, not a crash');
  assert.equal(fresh.fraction, 0);
});

test('the deadline the ring draws is the deadline the shell enforces', () => {
  const rust = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(rust, /Duration::from_secs\(180\)/, 'the shell still waits three minutes');
  assert.equal(local.WARMUP_MS, 180000, 'and the ring is drawn against the same three minutes');
});

test('the card shows the ring, and asks more often while it is loading', () => {
  const card = read('desktop', 'src', 'components', 'LocalModelsCard.tsx');
  assert.match(card, /role="progressbar"/, 'the wait is announced, not just drawn');
  assert.match(card, /aria-valuenow=\{warm\.elapsedSeconds\}/, 'with the real elapsed time');
  assert.match(card, /strokeDasharray=\{`\$\{\(warm\.fraction \* 94\.2\)/, '2πr: the dash is a fraction of the circle');
  assert.match(card, /running === 'starting' \? LOADING_POLL_MS : MEMORY_POLL_MS/, 'status is read every second while loading, not every fifteen');
});

test('a local model only becomes a provider row when it can actually answer', () => {
  assert.equal(local.providerRow({ state: 'stopped' }), null);
  assert.equal(local.providerRow({ state: 'starting', repo: 'x/y' }), null, 'a loading model must not be offered in Chat');
  const row = local.providerRow({ state: 'ready', repo: 'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF', base_url: 'http://127.0.0.1:8080' });
  assert.equal(row.id, 'local');
  assert.equal(row.local, true);
  assert.equal(row.baseUrl, 'http://127.0.0.1:8080');
  assert.match(row.label, /Qwen2\.5-Coder-7B-Instruct-GGUF/);
});

test('a start failure is answered with something to do about it', () => {
  assert.match(local.startAdvice('llama-server.exe is not here yet. Get it from https://...'), /Install llama-server/);
  assert.match(local.startAdvice('unsloth/x did not become ready within 180s.'), /too large|quant/);
  assert.match(local.startAdvice('llama-server exited with exit code: 1'), /log tail|own explanation/);
  assert.ok(local.startAdvice('something nobody has seen').length > 10);
});

// ---- the shell and the screen agree -------------------------------------

test('the shell runs the server on loopback only, and reaps it on exit', () => {
  const shell = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(shell, /\"127\.0\.0\.1\"/, 'a local model is not exposed to the network');
  assert.match(shell, /fn spec_for\(repo: &str, quant: &str\) -> String/);
  assert.match(shell, /--n-gpu-layers/);
  // Stopping is a kill and a wait, not a dropped handle.
  assert.match(shell, /run\.child\.kill\(\)/);
  assert.match(shell, /run\.child\.wait\(\)/);
  // The app reaps the child on quit: a model server left running after the
  // window is gone is a process nobody can see.
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /mod models;/);
  assert.match(main, /models::shutdown\(\)/);
  for (const command of [
    'models::local_server_find',
    'models::local_server_pick',
    'models::local_server_use',
    'models::local_open_releases',
    'models::local_model_start',
    'models::local_model_status',
    'models::local_model_stop',
  ]) {
    assert.ok(main.includes(command), `${command} must be in the invoke handler`);
  }
  // The binary is the user's: no bundled asset, no unattended download.
  assert.match(shell, /local_server_use/);
  assert.match(shell, /llama\.cpp\/releases\/latest/);
  assert.ok(!/reqwest::get\([^)]*llama-server/.test(shell), 'the app does not fetch a server binary itself');
});

test('the binary it will run is checked by name before it is trusted', () => {
  const shell = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(shell, /if name != binary_name\(\)\.to_lowercase\(\)/);
  assert.match(shell, /std::fs::copy\(&source, &destination\)/);
});

test('Chat offers the local model, and sends local turns straight to it', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /localModels\.providerRow\(status\)/);
  assert.match(chat, /streamLocalChat\(localRow\?\.baseUrl \|\| ''/);
  assert.match(chat, /active\.provider === 'local'/);
  // The engine's own path is untouched.
  assert.match(chat, /await streamChat\(active\.provider/);
  // And the local route is the OpenAI shape llama-server speaks.
  const api = read('desktop', 'src', 'api.ts');
  assert.match(api, /\/v1\/chat\/completions/);
  assert.match(api, /async function readStream\(res: Response/);
});

test('Settings owns the binary, the catalogue and the guard', () => {
  const card = read('desktop', 'src', 'components', 'LocalModelsCard.tsx');
  assert.match(card, /localServerPick\(\)/);
  assert.match(card, /localOpenReleases\(\)/);
  assert.match(card, /localModels\.fit\(entry, facts\)/);
  assert.match(card, /disabled=\{!report\.fits \|\| !!busy \|\| isThis\}/);
  assert.match(read('desktop', 'src', 'screens', 'SettingsScreen.tsx'), /<LocalModelsCard \/>/);
  // The loopback the app talks to is allowed by its own policy.
  const conf = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));
  assert.match(String(conf.app.security.csp), /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/);
});
