// NEURA-051: the local-model status chip.
//
// The point of the module under test is that the chip says what the runtime
// says, so the tests hand it the payloads the runtimes really answer with --
// llama.cpp's /health and /slots, Ollama's /api/ps -- through a stub fetch,
// and assert the words that end up in the status bar. Three shapes matter:
// the full answer, the degraded one (no /slots, or a runtime that has none),
// and silence, which must never leave last poll's numbers on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const local = require('../desktop/src/local-status.js');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:8080';

/** A stub `fetch`: a map of URL -> { status, body } (or a thrown Error). */
function fakeFetch(routes) {
  const seen = [];
  const call = async (url, init) => {
    seen.push({ url: String(url), headers: (init && init.headers) || {} });
    const route = routes[String(url)];
    if (!route) throw new Error('connection refused');
    if (route instanceof Error) throw route;
    return {
      status: route.status,
      text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)),
    };
  };
  call.seen = seen;
  return call;
}

// The payloads below are the real shapes, trimmed to the fields that are read.
const HEALTH_OK = { status: 200, body: { status: 'ok' } };
const HEALTH_LOADING = {
  status: 503,
  body: { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } },
};
const SLOTS_OK = {
  status: 200,
  body: [
    {
      id: 0,
      id_task: -1,
      n_ctx: 8192,
      speculative: false,
      is_processing: false,
      model: 'C:\\models\\gpt-oss-20b-UD-Q4_K_XL.gguf',
      params: { n_predict: -1, temperature: 0.8 },
    },
    { id: 1, id_task: 42, n_ctx: 8192, is_processing: true, model: 'C:\\models\\gpt-oss-20b-UD-Q4_K_XL.gguf' },
  ],
};
const SLOTS_OFF = {
  status: 501,
  body: {
    error: {
      code: 501,
      message: 'This server does not support slots endpoint. Start it with `--slots`',
      type: 'not_supported_error',
    },
  },
};
const OLLAMA_PS = {
  status: 200,
  body: {
    models: [
      {
        name: 'qwen3.5:4b',
        model: 'qwen3.5:4b',
        size: 3087360000,
        size_vram: 3087360000,
        details: { family: 'qwen3', parameter_size: '4.0B', quantization_level: 'Q4_K_M' },
        expires_at: '2026-09-23T12:05:00Z',
        context_length: 16384,
      },
    ],
  },
};

const LLAMA = { kind: 'llama.cpp', base: BASE, apiKey: 'secret-key', name: 'gpt-oss-20b', announce: true };

// ---- llama.cpp, answering everything ---------------------------------------

test('/health and /slots become model, context and busy slots', async () => {
  const fetch = fakeFetch({ [`${BASE}/health`]: HEALTH_OK, [`${BASE}/slots`]: SLOTS_OK });
  const status = await local.probe(LLAMA, { fetch, now: 1000 });

  assert.equal(status.reachable, true);
  assert.equal(status.loading, false);
  assert.equal(status.degraded, false);
  // /slots names the file it loaded; the folder and the extension are not news.
  assert.equal(status.model, 'gpt-oss-20b-UD-Q4_K_XL');
  assert.equal(status.contextSize, 8192);
  assert.equal(status.slotsKnown, true);
  assert.equal(status.slotsBusy, 1);
  assert.equal(status.slotsTotal, 2);
  assert.equal(status.at, 1000);

  const chip = local.chip(status);
  assert.equal(chip.show, true);
  assert.equal(chip.tone, 'ok');
  assert.equal(chip.label, 'gpt-oss-20b-UD-Q4_K_XL · 8k ctx · 1/2 slots busy');
  assert.equal(chip.title, 'llama.cpp at http://127.0.0.1:8080');

  // The server is started with --api-key, so every question carries it.
  assert.deepEqual(fetch.seen.map((r) => r.url), [`${BASE}/health`, `${BASE}/slots`]);
  assert.equal(fetch.seen[1].headers.Authorization, 'Bearer secret-key');
});

test('503 from /health is loading, and no numbers are shown for it', async () => {
  const fetch = fakeFetch({ [`${BASE}/health`]: HEALTH_LOADING, [`${BASE}/slots`]: SLOTS_OK });
  const status = await local.probe(LLAMA, { fetch });

  assert.equal(status.reachable, true);
  assert.equal(status.loading, true);
  assert.equal(status.contextSize, 0);
  assert.equal(status.slotsKnown, false);
  // A loading server is not asked about its slots: the answer would be about
  // whatever it had loaded before.
  assert.deepEqual(fetch.seen.map((r) => r.url), [`${BASE}/health`]);

  const chip = local.chip(status);
  assert.equal(chip.tone, 'warn');
  assert.equal(chip.label, 'loading gpt-oss-20b…');
  assert.equal(chip.title, 'llama.cpp at http://127.0.0.1:8080 — Loading model');
});

// ---- degraded: the endpoint is not there -----------------------------------

test('a server started without --slots degrades instead of failing', async () => {
  const fetch = fakeFetch({ [`${BASE}/health`]: HEALTH_OK, [`${BASE}/slots`]: SLOTS_OFF });
  const status = await local.probe(LLAMA, { fetch });

  assert.equal(status.reachable, true);
  assert.equal(status.degraded, true);
  assert.equal(status.slotsKnown, false);
  assert.equal(status.slotsTotal, 0);
  // Nothing said what is loaded, so the name the shell started it with stands.
  assert.equal(status.model, 'gpt-oss-20b');
  assert.match(status.detail, /--slots/);

  const chip = local.chip(status);
  assert.equal(chip.tone, 'ok');
  assert.equal(chip.label, 'gpt-oss-20b · slots not reported');
});

test('an older build that counts slots in /health is believed', async () => {
  const fetch = fakeFetch({
    [`${BASE}/health`]: { status: 200, body: { status: 'ok', slots_idle: 3, slots_processing: 1 } },
    [`${BASE}/slots`]: { status: 404, body: { error: { code: 404, message: 'File Not Found' } } },
  });
  const status = await local.probe(LLAMA, { fetch });

  assert.equal(status.degraded, true);
  assert.equal(status.slotsKnown, true);
  assert.equal(status.slotsBusy, 1);
  assert.equal(status.slotsTotal, 4);
  assert.equal(local.chip(status).label, 'gpt-oss-20b · 1/4 slots busy');
});

test('Ollama has no /slots at all, and the chip says so', async () => {
  const base = 'http://127.0.0.1:11434';
  const fetch = fakeFetch({ [`${base}/api/ps`]: OLLAMA_PS });
  const status = await local.probe(local.targetForOllama(base, true), { fetch });

  assert.equal(status.kind, 'ollama');
  assert.equal(status.reachable, true);
  assert.equal(status.model, 'qwen3.5:4b');
  assert.equal(status.contextSize, 16384);
  assert.equal(status.degraded, true);
  assert.equal(status.slotsKnown, false);
  // One question only: Ollama has no /health and no /slots to ask.
  assert.deepEqual(fetch.seen.map((r) => r.url), [`${base}/api/ps`]);

  const chip = local.chip(status);
  assert.equal(chip.label, 'qwen3.5:4b · 16k ctx · slots not reported');
  assert.equal(chip.title, 'Ollama at http://127.0.0.1:11434 — Ollama does not report slots');
});

test('Ollama that is running with nothing loaded says that, not a model', async () => {
  const base = 'http://127.0.0.1:11434';
  const fetch = fakeFetch({ [`${base}/api/ps`]: { status: 200, body: { models: [] } } });
  const status = await local.probe(local.targetForOllama(base, true), { fetch });

  assert.equal(status.reachable, true);
  assert.equal(status.model, '');
  assert.equal(local.chip(status).label, 'local runtime up · no model loaded');
});

// ---- nothing answers --------------------------------------------------------

test('a refused connection shows silence, never the last numbers', async () => {
  const good = fakeFetch({ [`${BASE}/health`]: HEALTH_OK, [`${BASE}/slots`]: SLOTS_OK });
  const before = await local.probe(LLAMA, { fetch: good });
  assert.equal(local.chip(before).tone, 'ok');

  const dead = fakeFetch({});
  const after = await local.probe(LLAMA, { fetch: dead });
  assert.equal(after.reachable, false);
  assert.equal(after.model, '', 'a runtime that did not answer is not running the last model');
  assert.equal(after.contextSize, 0);
  assert.equal(after.slotsTotal, 0);
  assert.equal(after.slotsKnown, false);

  const chip = local.chip(after);
  assert.equal(chip.show, true);
  assert.equal(chip.tone, 'error');
  assert.equal(chip.label, 'local model not answering');
  assert.equal(chip.title, 'llama.cpp at http://127.0.0.1:8080 — connection refused');
});

test('an Ollama that never answered stays quiet, one that did does not', async () => {
  const dead = fakeFetch({});
  const never = await local.probe(local.targetForOllama('http://127.0.0.1:11434', false), { fetch: dead });
  assert.equal(local.chip(never).show, false, 'not running Ollama is not a fault');

  const seen = await local.probe(local.targetForOllama('http://127.0.0.1:11434', true), { fetch: dead });
  assert.equal(local.chip(seen).show, true);
  assert.equal(local.chip(seen).label, 'local model not answering');
});

test('no local runtime at all renders no chip', async () => {
  assert.equal(local.chip(null).show, false);
  assert.equal(local.chip(local.empty()).show, false);
  const nothing = await local.probe(null, { fetch: fakeFetch({}) });
  assert.equal(nothing.kind, '');
  assert.equal(local.chip(nothing).show, false);
});

test('a probe never rejects, whatever fetch does', async () => {
  const throws = async () => { throw new Error('boom'); };
  const status = await local.probe(LLAMA, { fetch: throws });
  assert.equal(status.reachable, false);
  assert.equal(status.detail, 'boom');

  const garbage = fakeFetch({ [`${BASE}/health`]: { status: 200, body: 'not json' }, [`${BASE}/slots`]: { status: 200, body: 'not json' } });
  const odd = await local.probe(LLAMA, { fetch: garbage });
  assert.equal(odd.reachable, true);
  assert.equal(odd.degraded, true, 'a /slots answer that is not a list is a missing endpoint');
});

// ---- the schedule -----------------------------------------------------------

test('polling backs off while nothing answers and resets when it does', () => {
  const down = Object.assign(local.empty(), { kind: 'llama.cpp', base: BASE });
  let delay = local.nextDelay(down, 0);
  assert.equal(delay, local.POLL_MS);
  delay = local.nextDelay(down, delay);
  assert.equal(delay, local.POLL_MS * 2);
  for (let i = 0; i < 20; i++) delay = local.nextDelay(down, delay);
  assert.equal(delay, local.MAX_POLL_MS, 'the back-off is capped, not unbounded');

  const up = Object.assign(local.empty(), { kind: 'llama.cpp', base: BASE, reachable: true });
  assert.equal(local.nextDelay(up, delay), local.POLL_MS);
});

// ---- the target ------------------------------------------------------------

test('the shell status names the runtime to poll, and only while it runs', () => {
  const running = local.targetFromShell({
    state: 'ready',
    repo: 'unsloth/gpt-oss-20b-GGUF',
    file: '',
    base_url: 'http://127.0.0.1:8080',
    api_key: 'k',
  });
  assert.deepEqual(running, {
    kind: 'llama.cpp',
    base: 'http://127.0.0.1:8080',
    apiKey: 'k',
    name: 'gpt-oss-20b-GGUF',
    announce: true,
  });
  // Starting counts: that is the state the chip has the most to say about.
  assert.ok(local.targetFromShell({ state: 'starting', base_url: 'http://127.0.0.1:8080' }));
  assert.equal(local.targetFromShell({ state: 'stopped', base_url: '' }), null);
  assert.equal(local.targetFromShell({ state: 'error', base_url: 'http://127.0.0.1:8080' }), null);
  assert.equal(local.targetFromShell(null), null);
});

test('context sizes are said the way people say them', () => {
  assert.equal(local.contextLabel(8192), '8k ctx');
  assert.equal(local.contextLabel(131072), '128k ctx');
  assert.equal(local.contextLabel(1536), '1.5k ctx');
  assert.equal(local.contextLabel(512), '512 ctx');
  assert.equal(local.contextLabel(0), '');
});

// ---- the chip is wired into the bar ----------------------------------------

test('StatusBar renders the chip from local-status and stops polling when hidden', () => {
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'components', 'StatusBar.tsx'), 'utf8');
  assert.match(source, /FreeAI4ULocalStatus/, 'the bar reads the module the way the app publishes it');
  assert.match(source, /localStatus\.probe\(target\)/);
  assert.match(source, /localStatus\.nextDelay\(status, delay\)/);
  assert.match(source, /visibilitychange/, 'a hidden window stops asking');
  assert.match(source, /clearTimeout\(timer\)/, 'unmounting cancels the next poll');
  assert.match(source, /\{local\.show && \(/, 'no runtime, no chip');
});
