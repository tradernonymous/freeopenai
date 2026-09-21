// "My models": Ollama Local and Unsloth Local.
//
// A person points the app at where their models are -- Ollama's own server, or
// a folder of GGUF files -- adds the ones they want, and those appear in the
// Chat, Design and Code pickers under two providers. Ollama is a CONNECTION
// (Ollama runs the model, so nothing it lists can be unsupported); a folder is
// FILES (llama-server runs them with -m). Run settings are per model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const saved = require('../desktop/src/saved-models.js');
const run = require('../desktop/src/run-settings.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const GB = 1024 * 1024 * 1024;

function memoryStorage() {
  const rows = new Map();
  return {
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, String(v)),
    removeItem: (k) => rows.delete(k),
  };
}

// ---- the list ------------------------------------------------------------

test('adding remembers a name or a path, copies nothing, and refuses a duplicate politely', () => {
  const store = memoryStorage();
  const ollama = saved.add({ kind: 'ollama', name: 'deepseek-r1:latest', bytes: 5 * GB, detail: '8B \u00b7 Q4_K_M' }, store);
  assert.equal(ollama.added, true);
  assert.equal(ollama.entry.id, 'ollama:deepseek-r1:latest');
  assert.equal(ollama.entry.base, saved.OLLAMA_BASE, 'an Ollama model remembers where Ollama is');
  assert.equal(ollama.entry.path, '');

  const file = saved.add({ kind: 'unsloth', path: 'D:\\models\\gemma-4-E4B-it-UD-Q4_K_XL.gguf', bytes: 4.8 * GB }, store);
  assert.equal(file.added, true);
  assert.equal(file.entry.name, 'gemma-4-E4B-it-UD-Q4_K_XL', 'a file is called by its name without .gguf');
  assert.equal(file.entry.base, '');

  const again = saved.add({ kind: 'ollama', name: 'deepseek-r1:latest' }, store);
  assert.equal(again.ok, true);
  assert.equal(again.added, false);
  assert.match(again.reason, /Already/);
  assert.equal(saved.list(store).length, 2);

  assert.equal(saved.add({ kind: 'unsloth', path: 'D:\\x\\model.safetensors' }, store).ok, false, 'not a GGUF');
  assert.equal(saved.add({ kind: 'lmstudio', name: 'x' }, store).ok, false, 'not a kind this app has');
  assert.equal(saved.add({ kind: 'ollama', name: '  ' }, store).ok, false);
});

test('removing forgets the entry and only the entry', () => {
  const store = memoryStorage();
  saved.add({ kind: 'ollama', name: 'a:latest' }, store);
  saved.add({ kind: 'ollama', name: 'b:latest' }, store);
  assert.equal(saved.remove('ollama:a:latest', store), true);
  assert.deepEqual(saved.list(store).map((m) => m.name), ['b:latest']);
  assert.equal(saved.remove('ollama:nope', store), false);
});

test('a provider exists only while it has a model, and lists exactly what was added', () => {
  const store = memoryStorage();
  assert.deepEqual(saved.providerRows(store), [], 'nothing added, nothing in the picker');
  saved.add({ kind: 'unsloth', path: '/m/q.gguf', bytes: 2 * GB, detail: 'Q4_K_M' }, store);
  assert.deepEqual(saved.providerRows(store).map((p) => [p.id, p.label]), [['unsloth-local', 'Unsloth Local']]);
  saved.add({ kind: 'ollama', name: 'phi4-mini:latest' }, store);
  assert.deepEqual(saved.providerRows(store).map((p) => p.label), ['Ollama Local', 'Unsloth Local']);
  assert.deepEqual(saved.modelsFor('unsloth-local', store), [{ id: 'q', free: '2.0 GB \u00b7 Q4_K_M' }]);
  assert.deepEqual(saved.modelsFor('ollama-local', store).map((m) => m.id), ['phi4-mini:latest']);
  assert.deepEqual(saved.modelsFor('openrouter', store), []);
  assert.equal(saved.find('ollama-local', 'phi4-mini:latest', store).kind, 'ollama');
  assert.equal(saved.find('unsloth-local', 'phi4-mini:latest', store), null, 'a name is looked up under its own provider');
  assert.equal(saved.isSavedProvider('ollama-local'), true);
  assert.equal(saved.isSavedProvider('local'), false);
});

test('a hand-edited or older store cannot put a broken row in the picker', () => {
  const store = memoryStorage();
  store.setItem(saved.STORE_KEY, JSON.stringify([
    { kind: 'ollama', name: 'ok:latest', id: 'ollama:ok:latest' },
    { kind: 'unsloth', name: 'no-path' },
    { kind: 'other', name: 'x' },
    null,
    'text',
  ]));
  assert.deepEqual(saved.list(store).map((m) => m.name), ['ok:latest']);
  store.setItem(saved.STORE_KEY, '{not json');
  assert.deepEqual(saved.list(store), []);
});

test('what Ollama reports becomes names, sizes and a one-line detail', () => {
  const rows = saved.fromOllamaTags({ models: [
    { name: 'deepseek-r1:latest', size: 5.2 * GB, details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
    { model: 'parable/fable:3b', size: 2 * GB, details: {} },
    { size: 1 },
  ] });
  assert.deepEqual(rows.map((r) => r.name), ['deepseek-r1:latest', 'parable/fable:3b']);
  assert.equal(rows[0].detail, '8.2B \u00b7 Q4_K_M');
  assert.equal(rows[1].detail, '');
  assert.deepEqual(saved.fromOllamaTags(null), []);
});

test('where the person last looked is remembered per source', () => {
  const store = memoryStorage();
  assert.deepEqual(saved.folders(store), { ollama: saved.OLLAMA_BASE, unsloth: '' });
  saved.setFolder('unsloth', 'D:\\models', store);
  saved.setFolder('ollama', 'http://127.0.0.1:11500', store);
  assert.deepEqual(saved.folders(store), { ollama: 'http://127.0.0.1:11500', unsloth: 'D:\\models' });
  assert.equal(saved.setFolder('docker', 'x', store), false);
});

// ---- run settings ----------------------------------------------------------

test('settings are per model, cleaned into their limits, and resettable', () => {
  const store = memoryStorage();
  assert.deepEqual(run.get('ollama:a', store), run.DEFAULTS);
  run.set('ollama:a', { temperature: 9, ctx: 8192.4, topK: '12', system: 'Be brief.', junk: 1 }, store);
  const a = run.get('ollama:a', store);
  assert.equal(a.temperature, 2, 'clamped');
  assert.equal(a.ctx, 8192, 'a whole number');
  assert.equal(a.topK, 12);
  assert.equal(a.system, 'Be brief.');
  assert.equal('junk' in a, false);
  assert.deepEqual(run.get('ollama:b', store), run.DEFAULTS, 'another model is untouched');
  run.reset('ollama:a', store);
  assert.deepEqual(run.get('ollama:a', store), run.DEFAULTS);
});

test('a preset is a named copy that can be listed, applied and deleted', () => {
  const store = memoryStorage();
  assert.equal(run.savePreset('  ', {}, store), false);
  run.savePreset('Precise', { temperature: 0.1 }, store);
  run.savePreset('Creative', { temperature: 1.2 }, store);
  assert.deepEqual(Object.keys(run.presets(store)), ['Creative', 'Precise']);
  assert.equal(run.presets(store).Precise.temperature, 0.1);
  assert.equal(run.deletePreset('Precise', store), true);
  assert.equal(run.deletePreset('Precise', store), false);
});

test('only load-time settings ask llama-server to reload', () => {
  assert.equal(run.needsReload(run.DEFAULTS, { ...run.DEFAULTS, temperature: 0.2, system: 'x' }), false);
  assert.equal(run.needsReload(run.DEFAULTS, { ...run.DEFAULTS, ctx: 16384 }), true);
  assert.equal(run.needsReload(run.DEFAULTS, { ...run.DEFAULTS, gpuLayers: 20 }), true);
  assert.deepEqual(run.loadArgs({ ctx: 0, gpuLayers: 0, threads: 0 }, 8), { threads: 8 }, 'Auto context and CPU-only add no flags');
  assert.deepEqual(run.loadArgs({ ctx: 8192, gpuLayers: -1, threads: 6 }, 8), { ctx: 8192, gpuLayers: -1, threads: 6 });
});

test('Ollama takes everything per message; llama-server takes sampling only', () => {
  const values = { ...run.DEFAULTS, ctx: 16384, gpuLayers: 20, threads: 6, temperature: 0.3 };
  assert.deepEqual(run.ollamaOptions(values), {
    temperature: 0.3, top_p: 0.95, top_k: 40, min_p: 0.05, repeat_penalty: 1.1,
    num_ctx: 16384, num_gpu: 20, num_thread: 6,
  });
  const auto = run.ollamaOptions(run.DEFAULTS);
  assert.equal('num_ctx' in auto, false, 'Auto leaves the context to Ollama');
  assert.equal('num_gpu' in auto, false);
  assert.deepEqual(Object.keys(run.openaiParams(values)).sort(), ['min_p', 'repeat_penalty', 'temperature', 'top_k', 'top_p']);
});

test('the memory estimate warns about RAM always and about the GPU only when told its size', () => {
  const big = run.estimate({ bytes: 8 * GB, ctx: 131072, gpuLayers: -1 }, { ramGb: 16 });
  assert.ok(big.totalGb > 16 * 0.8);
  assert.equal(big.warnings.length, 1);
  assert.match(big.warnings[0], /Lower the context/);
  const withGpu = run.estimate({ bytes: 8 * GB, ctx: 8192, gpuLayers: -1 }, { ramGb: 32, vramGb: 4 });
  assert.equal(withGpu.warnings.length, 1);
  assert.match(withGpu.warnings[0], /Exceeds GPU memory/);
  assert.equal(run.estimate({ bytes: 2 * GB, ctx: 8192, gpuLayers: 0 }, { ramGb: 16, vramGb: 4 }).gpuGb, 0, 'CPU only uses no VRAM');
  assert.deepEqual(run.estimate({ bytes: 2 * GB, ctx: 8192 }, { ramGb: 16, vramGb: 8 }).warnings, []);
});

test('the system prompt leads the conversation once, and never twice', () => {
  const turns = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(run.withSystem(turns, { system: '  Be brief. ' }), [{ role: 'system', content: 'Be brief.' }, ...turns]);
  assert.equal(run.withSystem(turns, { system: '' }), turns);
  const already = [{ role: 'system', content: 'Design rules' }, ...turns];
  assert.equal(run.withSystem(already, { system: 'Be brief.' }), already, 'a screen that brings its own system prompt keeps it');
});

// ---- the wiring --------------------------------------------------------------

test('the shell reaches Ollama on loopback only, and streams through events', () => {
  const shell = read('desktop', 'src-tauri', 'src', 'ollama.rs');
  assert.match(shell, /pub fn loopback_base\(base: &str\)/);
  assert.match(shell, /crate::net::is_loopback\(&host\)/);
  assert.match(shell, /\/api\/tags/);
  assert.match(shell, /"keep_alive": 0/, 'eject is Ollama\'s documented unload');
  assert.match(shell, /app\.emit\("shell-chat"/);
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  for (const command of ['ollama_tags', 'ollama_ps', 'ollama_eject', 'ollama_start', 'shell_chat_stream', 'shell_chat_cancel']) {
    assert.ok(main.includes(`ollama::${command}`), `${command} must be in the invoke handler`);
  }
  // Unsloth Studio's own llama-server is found, so nothing has to be downloaded.
  const models = read('desktop', 'src-tauri', 'src', 'models.rs');
  assert.match(models, /pub fn unsloth_binaries\(\)/);
  assert.match(models, /"\.unsloth"\)\.join\("llama\.cpp"\)/);
  assert.match(models, /ggml-vocab-/, 'vocab-only files are not models');
});

test('Chat, Design and Code all run "my models", and Chat opens their run settings', () => {
  const runner = read('desktop', 'src', 'run-model.ts');
  assert.match(runner, /\/api\/chat/);
  assert.match(runner, /shellPostStream\(/);
  assert.match(runner, /runSettings\.ollamaOptions\(values\)/);
  assert.match(runner, /localModelStart\(\{/);
  assert.match(runner, /runSettings\.openaiParams\(values\)/);
  for (const screen of ['ChatScreen.tsx', 'DesignScreen.tsx', 'CodeScreen.tsx']) {
    const source = read('desktop', 'src', 'screens', screen);
    assert.match(source, /isSavedProvider\(/, `${screen} knows the two local providers`);
    assert.match(source, /streamSaved|streamMine/, `${screen} streams from them`);
  }
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /savedModels\.providerRows\(\)/);
  assert.match(chat, /<RunSettings /);
  const drawer = read('desktop', 'src', 'components', 'RunSettings.tsx');
  for (const label of ['Estimated memory', 'Context length', 'Advanced settings', 'Remember for this model', 'Reload model', 'Eject model', 'Preset', 'System prompt', 'Sampling']) {
    assert.ok(drawer.includes(label), `the drawer has "${label}"`);
  }
  const mine = read('desktop', 'src', 'components', 'MyModels.tsx');
  assert.match(mine, /ollamaTags\(base\)/);
  assert.match(mine, /ollamaStart\(/);
  assert.match(mine, /savedModels\.add\(/);
  assert.match(mine, /savedModels\.remove\(/);
});

test('Hugging Face is always in the picker, and Chat signs in on the spot', () => {
  const hf = require('../desktop/src/hf-inference.js');
  const out = hf.providerRow(null);
  assert.equal(out.id, 'hf');
  assert.equal(out.configured, false);
  assert.match(out.freeTier.text, /Sign in/);
  assert.equal(hf.providerRow('tok').configured, true);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /hfAuth\.startDeviceCode\(\)/);
  assert.match(chat, /Sign in to Hugging Face/);
  assert.match(chat, /hfInference\.fetchModels\(hfToken\)/, 'the live router list replaces the curated one');
});
