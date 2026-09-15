// Groq and Gemini are the two largest no-card free tiers this app can reach,
// and both speak OpenAI's shape -- so neither needs an adapter, only an entry.
// What they do need testing for is the one place they are not alike: Gemini's
// compatibility shim is a *different surface* from the native Gemini API, and
// it names models `models/gemini-2.5-flash` while its own documentation passes
// the bare id. If that prefix reaches the picker, every id the user sees and
// every id stored in a conversation carries a namespace no other provider
// here uses -- so the stripping is the thing these tests hold down.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  LLM_PROVIDERS,
  createRequestHandler,
  normalizeProviderBaseUrl,
  normalizeProviderModel,
  clearModelCache,
} = require('../server.js');
const { usableChatModels } = require('../chatlib.js');

const VARS = ['GROQ_API_KEY', 'GROQ_BASE_URL', 'GROQ_MODELS', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODELS', 'RATE_LIMIT_BASE_DELAY_MS'];

function snapshotEnv() {
  const saved = {};
  for (const name of VARS) saved[name] = process.env[name];
  return saved;
}

function restoreEnv(saved) {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

// Gemini's shim answers with the REST resource names; Groq answers plain ids.
// The embedding rows are here so the shared chat filter is exercised against a
// catalogue this app does not control.
const GEMINI_CATALOGUE = [
  { id: 'models/gemini-2.5-flash' },
  { id: 'models/gemini-2.5-pro' },
  { id: 'models/text-embedding-004' },
];

const GROQ_CATALOGUE = [
  { id: 'llama-3.1-8b-instant' },
  { id: 'qwen3-32b' },
  { id: 'whisper-large-v3' },
];

async function withProvider({ id, envPrefix, catalogue, key, models, respond }, run) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', raw });
      if (respond) return respond(req, res, raw);
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: catalogue }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const saved = snapshotEnv();
  process.env[envPrefix + '_BASE_URL'] = 'http://127.0.0.1:' + upstream.address().port;
  if (key !== undefined) process.env[envPrefix + '_API_KEY'] = key;
  else delete process.env[envPrefix + '_API_KEY'];
  if (models !== undefined) process.env[envPrefix + '_MODELS'] = models;
  else delete process.env[envPrefix + '_MODELS'];
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  clearModelCache();

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await run({
      base,
      hits,
      list: () => fetch(base + '/api/llm/models?provider=' + id),
      chat: (body) => fetch(base + '/api/llm/chat?provider=' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } finally {
    app.close();
    upstream.close();
    restoreEnv(saved);
    clearModelCache();
  }
}

const gemini = (opts, run) => withProvider({ id: 'gemini', envPrefix: 'GEMINI', catalogue: GEMINI_CATALOGUE, key: 'g-key', ...opts }, run);
const groq = (opts, run) => withProvider({ id: 'groq', envPrefix: 'GROQ', catalogue: GROQ_CATALOGUE, key: 'q-key', ...opts }, run);

test('both providers are registered with the shape the server relies on', () => {
  assert.equal(LLM_PROVIDERS.groq.label, 'Groq');
  assert.equal(LLM_PROVIDERS.groq.envVar, 'GROQ_API_KEY');
  assert.equal(LLM_PROVIDERS.groq.baseUrl, 'https://api.groq.com/openai/v1');
  // No pinned list on either: what a free account may reach moves faster than
  // this app releases, and a stale allowlist hides models rather than failing.
  assert.equal(LLM_PROVIDERS.groq.models, undefined);

  assert.equal(LLM_PROVIDERS.gemini.label, 'Gemini');
  assert.equal(LLM_PROVIDERS.gemini.envVar, 'GEMINI_API_KEY');
  // The compatibility shim, not the native API -- a native base URL here would
  // 404 on /chat/completions and read as "the key is wrong".
  assert.equal(LLM_PROVIDERS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(LLM_PROVIDERS.gemini.modelIdPrefix, 'models/');

  // Neither declares an image block: Groq draws nothing, and Gemini's pictures
  // come from a different endpoint than this shim serves. Claiming either
  // would put a guaranteed failure into the draw order.
  assert.equal(LLM_PROVIDERS.groq.image, undefined);
  assert.equal(LLM_PROVIDERS.gemini.image, undefined);
});

test('neither base URL gets a /v1 bolted on, since both already carry their path', () => {
  // They are absent from V1_APPENDED_PROVIDERS on purpose. Groq's path ends in
  // /v1 already; Gemini's ends in /openai and appending would 404 everything.
  assert.equal(
    normalizeProviderBaseUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'),
    'https://generativelanguage.googleapis.com/v1beta/openai',
  );
  assert.equal(
    normalizeProviderBaseUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/'),
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'a trailing slash must not survive into a doubled //models',
  );
  assert.equal(normalizeProviderBaseUrl('groq', 'https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1');
});

test('the models/ prefix comes off, and only for the provider that has one', () => {
  assert.equal(normalizeProviderModel({ id: 'models/gemini-2.5-flash' }, LLM_PROVIDERS.gemini).id, 'gemini-2.5-flash');
  // An id that does not carry the prefix is left exactly as it is, rather than
  // having its first seven characters removed.
  assert.equal(normalizeProviderModel({ id: 'gemini-2.5-flash' }, LLM_PROVIDERS.gemini).id, 'gemini-2.5-flash');
  // A provider without the setting keeps a literal `models/` id, because on
  // some other catalogue that could be the real name.
  assert.equal(normalizeProviderModel({ id: 'models/x' }, LLM_PROVIDERS.groq).id, 'models/x');
  assert.equal(normalizeProviderModel({ id: 'models/x' }).id, 'models/x');
});

test('the Gemini catalogue reaches the picker with clean ids', async () => {
  await gemini({}, async ({ list, hits }) => {
    const listed = await (await list()).json();
    const ids = listed.map((m) => m.id);
    assert.deepEqual(ids, ['gemini-2.5-flash', 'gemini-2.5-pro', 'text-embedding-004']);
    assert.ok(hits.some((h) => h.url.endsWith('/models')));

    // The route passes a catalogue through untouched; the page is what drops
    // what can't chat, so the assertion worth making is that the shared rule
    // still recognises these ids once the prefix is gone.
    const shown = new Set(usableChatModels(listed).map((m) => m.id));
    assert.ok(shown.has('gemini-2.5-flash'));
    assert.equal(shown.has('text-embedding-004'), false, 'an embedding model would reach the picker');
  });
});

test('a Gemini chat sends the bare id, which is what the shim documents', async () => {
  await gemini({}, async ({ chat, hits }) => {
    const res = await chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const sent = hits.find((h) => h.url.includes('/chat/completions'));
    assert.ok(sent, 'the chat did not reach /chat/completions');
    assert.equal(JSON.parse(sent.raw).model, 'gemini-2.5-flash');
    assert.equal(sent.auth, 'Bearer g-key');
  });
});

test('a Groq chat carries its key, model and tools', async () => {
  await groq({}, async ({ chat, hits }) => {
    const res = await chat({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    });
    assert.equal(res.status, 200);
    const sent = hits.find((h) => h.url.includes('/chat/completions'));
    assert.ok(sent);
    const body = JSON.parse(sent.raw);
    assert.equal(body.model, 'llama-3.1-8b-instant');
    assert.ok(Array.isArray(body.tools) && body.tools.length === 1, 'tools have to survive the hop');
    assert.equal(sent.auth, 'Bearer q-key');
  });
});

test('GROQ_MODELS and GEMINI_MODELS pin the list when the catalogue is wrong', async () => {
  await groq({ models: 'qwen3-32b' }, async ({ list }) => {
    assert.deepEqual((await (await list()).json()).map((m) => m.id), ['qwen3-32b']);
  });
  // The override is written the way the user sees the id -- without the
  // prefix -- so it has to match after stripping, not before.
  await gemini({ models: 'gemini-2.5-pro' }, async ({ list }) => {
    assert.deepEqual((await (await list()).json()).map((m) => m.id), ['gemini-2.5-pro']);
  });
});

test('an unconfigured provider stays out of the picker and says so when asked', async () => {
  const saved = snapshotEnv();
  for (const name of VARS) delete process.env[name];
  clearModelCache();
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    for (const id of ['groq', 'gemini']) {
      const entry = providers.find((p) => p.id === id);
      assert.ok(entry, id + ' is missing from /api/llm/providers');
      assert.equal(entry.configured, false);
      const res = await fetch(base + '/api/llm/models?provider=' + id);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Unknown or unconfigured/);
    }
  } finally {
    app.close();
    restoreEnv(saved);
    clearModelCache();
  }
});

test('an upstream refusal is reported in its own words', async () => {
  await gemini({
    respond: (req, res) => {
      // What Google answers for a key that has not enabled the API -- the
      // mistake most likely to be made when pasting a key into Railway.
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Generative Language API has not been used in project' } }));
    },
  }, async ({ chat }) => {
    const res = await chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(res.status >= 400);
    assert.match(JSON.stringify(await res.json()), /Generative Language API|403/);
  });
});
