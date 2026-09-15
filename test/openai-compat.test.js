// The provider for an endpoint this app has never heard of: LiteLLM, one-api,
// vLLM, LM Studio, llama.cpp's server, or any gateway of the operator's own.
//
// All of them publish the same two routes every direct provider here already
// speaks, so the whole provider is an address and an optional key. What is
// checked here is the part that is easy to get wrong and invisible when it is:
// the /v1 segment an operator's URL usually stops short of, the absence of an
// auth header when there is no key, and a catalogue filtered to chat models.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, clearModelCache, normalizeProviderBaseUrl } = require('../server.js');
const { usableChatModels } = require('../chatlib.js');

const CATALOGUE = [
  { id: 'gpt-5.6-sol' },
  { id: 'qwen3-coder:30b' },
  { id: 'text-embedding-3-large' },
  { id: 'whisper-1' },
];

function snapshotEnv() {
  return {
    base: process.env.OPENAI_COMPAT_BASE_URL,
    key: process.env.OPENAI_COMPAT_API_KEY,
    models: process.env.OPENAI_COMPAT_MODELS,
    delay: process.env.RATE_LIMIT_BASE_DELAY_MS,
  };
}

function restoreEnv(saved) {
  for (const [name, value] of [
    ['OPENAI_COMPAT_BASE_URL', saved.base],
    ['OPENAI_COMPAT_API_KEY', saved.key],
    ['OPENAI_COMPAT_MODELS', saved.models],
    ['RATE_LIMIT_BASE_DELAY_MS', saved.delay],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// A stand-in for whichever proxy the operator runs: it records what arrived, so
// the test can prove what was *not* sent as much as what was.
async function withProxy({ baseUrl, key, models, hasKey = false }, run) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', raw });
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: CATALOGUE }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'proxy reply' } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const saved = snapshotEnv();
  process.env.OPENAI_COMPAT_BASE_URL = (baseUrl || 'http://127.0.0.1:PORT').replace(':PORT', ':' + upstream.address().port);
  if (hasKey) process.env.OPENAI_COMPAT_API_KEY = key || 'proxy-key';
  else delete process.env.OPENAI_COMPAT_API_KEY;
  if (models !== undefined) process.env.OPENAI_COMPAT_MODELS = models;
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  clearModelCache();

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await run({ base, hits });
  } finally {
    app.close();
    upstream.close();
    restoreEnv(saved);
    clearModelCache();
  }
}

const models = (base) => fetch(base + '/api/llm/models?provider=openai-compat');
const chat = (base, body) => fetch(base + '/api/llm/chat?provider=openai-compat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('an address that stops short of /v1 still reaches the OpenAI path', () => {
  // Every operator's URL for one of these is "http://host:port", and the
  // version segment their proxy serves underneath it is not something to
  // remember -- the same rule Ollama's and the Antigravity proxy's addresses
  // already follow.
  assert.equal(normalizeProviderBaseUrl('openai-compat', 'http://localhost:4000'), 'http://localhost:4000/v1');
  assert.equal(normalizeProviderBaseUrl('openai-compat', 'http://localhost:4000/v1'), 'http://localhost:4000/v1');
  // A path the operator chose is kept and the segment is added under it, which
  // is where a proxy mounted on a subpath serves it.
  assert.equal(normalizeProviderBaseUrl('openai-compat', 'https://proxy.example.com/openai'), 'https://proxy.example.com/openai/v1');
});

test('one address is the whole setup, and the catalogue is read from it', async () => {
  await withProxy({}, async ({ base, hits }) => {
    const res = await models(base);
    assert.equal(res.status, 200);
    const rows = await res.json();
    const ids = rows.map((m) => m.id);
    assert.ok(ids.includes('gpt-5.6-sol'), 'what the proxy serves is offered');
    assert.ok(ids.includes('qwen3-coder:30b'), 'a local model id with a tag survives');
    // A proxy fronts embeddings and speech too. The route hands over what the
    // proxy published and the picker keeps the chat models, which is the one
    // filter that means a row is never offered that cannot answer.
    const pickable = usableChatModels(rows).map((m) => m.id);
    assert.ok(pickable.includes('gpt-5.6-sol'));
    assert.equal(pickable.includes('text-embedding-3-large'), false);
    assert.equal(pickable.includes('whisper-1'), false);
    assert.equal(hits[0].url, '/v1/models', 'and it is read from the address it was given');
  });
});

test('the page knows it by name once an address is set', async () => {
  // The provider dropdown is built from this list, so a provider missing here
  // is one no user can pick however well it draws.
  await withProxy({}, async ({ base }) => {
    const health = await (await fetch(base + '/api/health')).json();
    assert.ok(health.providers.includes('openai-compat'), 'listed: ' + health.providers.join(', '));
  });
});

test('no key means no header, not a bare Bearer', async () => {
  // A local proxy usually has none, and \"Authorization: Bearer \" reads upstream
  // as a malformed token rather than as an absent one.
  await withProxy({}, async ({ base, hits }) => {
    const res = await chat(base, { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(hits.at(-1).url, '/v1/chat/completions');
    assert.equal(hits.at(-1).auth, '');
  });
});

test('a key is sent as Bearer, and a declared list narrows the catalogue in its order', async () => {
  // A list here is an allowlist against what the proxy actually serves, not a
  // declaration of it: an id the catalogue does not publish cannot be picked,
  // because it could not be used. The order is the operator's.
  await withProxy({ hasKey: true, key: 'proxy-key', models: 'qwen3-coder:30b,gpt-5.6-sol' }, async ({ base, hits }) => {
    const listed = (await (await models(base)).json()).map((m) => m.id);
    assert.deepEqual(listed, ['qwen3-coder:30b', 'gpt-5.6-sol']);

    await chat(base, { model: 'qwen3-coder:30b', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(hits.at(-1).auth, 'Bearer proxy-key');
  });
});
