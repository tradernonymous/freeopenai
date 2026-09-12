const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, normalizeProviderBaseUrl, clearModelCache } = require('../server.js');
const { usableChatModels } = require('../chatlib.js');

const AUTO = 'auto';

function snapshotEnv() {
  return {
    base: process.env.OMNIROUTE_BASE_URL,
    key: process.env.OMNIROUTE_API_KEY,
    models: process.env.OMNIROUTE_MODELS,
    delay: process.env.RATE_LIMIT_BASE_DELAY_MS,
  };
}

function restoreEnv(saved) {
  for (const [name, value] of [
    ['OMNIROUTE_BASE_URL', saved.base],
    ['OMNIROUTE_API_KEY', saved.key],
    ['OMNIROUTE_MODELS', saved.models],
    ['RATE_LIMIT_BASE_DELAY_MS', saved.delay],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// A stand-in for the OmniRoute gateway: it records every request so a test can
// prove what was *not* sent as much as what was, and it serves a small but
// realistic catalogue (the `auto` combos + a couple of dual-prefixed models).
const CATALOGUE = [
  { id: 'auto' },
  { id: 'auto/coding' },
  { id: 'auto/fast' },
  { id: 'openai/gpt-5.4' },
  { id: 'cc/claude-opus-4-6' },
  { id: 'claude/claude-opus-4-6' },
  // Non-chat entries that must never survive the picker's chat filter.
  { id: 'jina-ai/jina-embeddings-v5-omni-small' },
  { id: 'openai/gpt-image-2' },
];

async function withGateway({ baseUrl, key, models, respond } = {}, run) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', raw });
      if (respond) return respond(req, res, raw);
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: CATALOGUE }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: AUTO,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from the router' }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const saved = snapshotEnv();
  if (baseUrl !== undefined) {
    process.env.OMNIROUTE_BASE_URL = baseUrl.replace(':PORT', ':' + upstream.address().port);
  } else {
    delete process.env.OMNIROUTE_BASE_URL;
  }
  if (key !== undefined) process.env.OMNIROUTE_API_KEY = key;
  if (models !== undefined) process.env.OMNIROUTE_MODELS = models;
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  clearModelCache();

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await run({ base, hits, proxyPort: upstream.address().port });
  } finally {
    app.close();
    upstream.close();
    restoreEnv(saved);
    clearModelCache();
  }
}

const modelsUrl = (base) => base + '/api/llm/models?provider=omniroute';

const chat = (base, body) => fetch(base + '/api/llm/chat?provider=omniroute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('the pinned list is one the picker would actually show, auto included', () => {
  const ids = LLM_PROVIDERS.omniroute.models;
  assert.ok(Array.isArray(ids) && ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids in the list');
  assert.ok(ids.some((id) => id === AUTO), 'the auto router is the point of this provider');
  // The same rule the client renders by: a model the chat filter drops would be
  // pinned here and never appear, which is worse than not pinning it at all.
  const shown = new Set(usableChatModels(ids.map((id) => ({ id }))).map((m) => m.id));
  for (const id of ids) assert.ok(shown.has(id), `${id} would be filtered out of the picker`);
  assert.ok(shown.has(AUTO));
});

test('the provider is registered with the shape the server relies on', () => {
  const provider = LLM_PROVIDERS.omniroute;
  assert.equal(provider.label, 'OmniRoute');
  assert.equal(provider.envVar, 'OMNIROUTE_API_KEY');
  assert.equal(provider.needsKey, false, 'a default gateway needs no key of ours');
  assert.equal(provider.modelsPath, '/models?prefix=alias', 'the gateway publishes dual-prefixed ids; ask for one per model');
});

test('a base URL without the version segment is completed, and /v1 is not doubled', () => {
  assert.equal(normalizeProviderBaseUrl('omniroute', 'http://localhost:20128'), 'http://localhost:20128/v1');
  assert.equal(normalizeProviderBaseUrl('omniroute', 'http://localhost:20128/'), 'http://localhost:20128/v1');
  assert.equal(normalizeProviderBaseUrl('omniroute', 'https://box.example/v1'), 'https://box.example/v1');
  assert.equal(normalizeProviderBaseUrl('omniroute', 'https://box.example/v1/'), 'https://box.example/v1');
  // Other providers are untouched: a base URL already at its API root stays.
  assert.equal(normalizeProviderBaseUrl('nara', 'https://router.bynara.id/v1'), 'https://router.bynara.id/v1');
});

test('an unconfigured gateway stays out of the picker and says so when asked', async () => {
  await withGateway({ baseUrl: undefined }, async ({ base, hits }) => {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    const entry = providers.find((p) => p.id === 'omniroute');
    assert.equal(entry.configured, false);
    assert.equal(entry.label, 'OmniRoute');

    const res = await fetch(modelsUrl(base));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown or unconfigured/);
    assert.equal(hits.length, 0, 'nothing is contacted for a provider that is switched off');
  });
});

test('a base URL alone puts the gateway in the picker, and the catalogue is fetched live', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT' }, async ({ base, hits }) => {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    assert.equal(providers.find((p) => p.id === 'omniroute').configured, true);

    const models = await (await fetch(modelsUrl(base))).json();
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes(AUTO), 'the auto router is listed');
    assert.ok(ids.includes('auto/coding'));
    // The allowlist is intersected with the live catalogue, so non-chat rows in
    // the catalogue never reach the picker even though the gateway lists them.
    assert.ok(!ids.includes('jina-ai/jina-embeddings-v5-omni-small'));
    assert.ok(!ids.includes('openai/gpt-image-2'));

    // The bare base URL was completed to /v1 and the raw /models route (now
    // against the deduplicated alias catalogue) is what was actually asked for.
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, '/v1/models?prefix=alias');
    assert.equal(hits[0].method, 'GET');
    assert.equal(hits[0].auth, '', 'no key of ours means no auth header');
  });
});

test('a key, when one is set, is sent as a bearer token', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT', key: 'sekret' }, async ({ base, hits }) => {
    await chat(base, { model: AUTO, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(hits[hits.length - 1].auth, 'Bearer sekret');
  });
});

test('a chat call reaches the gateway on the OpenAI path, with the model asked for', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT' }, async ({ base, hits }) => {
    const res = await chat(base, { model: AUTO, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'hello from the router');

    const hit = hits[hits.length - 1];
    assert.equal(hit.url, '/v1/chat/completions');
    assert.equal(hit.method, 'POST');
    assert.equal(JSON.parse(hit.raw).model, AUTO);
    assert.equal(hit.auth, '', 'no key of ours means no auth header');
  });
});

test('tools and streaming flags ride through to the gateway unchanged', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT' }, async ({ base, hits }) => {
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
    const res = await chat(base, {
      model: AUTO,
      messages: [{ role: 'user', content: 'read a file' }],
      tools,
      stream: true,
      temperature: 0.2,
    });
    assert.equal(res.status, 200);
    const sent = JSON.parse(hits[hits.length - 1].raw);
    assert.deepEqual(sent.tools, tools, 'the tool schema is passed through');
    assert.equal(sent.stream, true, 'the stream flag is passed through');
    assert.equal(sent.temperature, 0.2, 'the temperature is passed through');
  });
});

test('OMNIROUTE_MODELS replaces the pinned list for a gateway whose routes differ', async () => {
  // The declared ids are still intersected with the live catalogue, exactly like
  // every other provider: a declaration that is not actually served is dropped
  // rather than offered as a row that cannot work.
  const declared = 'auto/coding, auto, made-up/id';
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT', models: declared }, async ({ base }) => {
    const models = await (await fetch(modelsUrl(base))).json();
    assert.deepEqual(models.map((m) => m.id), ['auto/coding', 'auto']);
  });
});

test('a refusal from the gateway is reported with its own message', async () => {
  await withGateway({
    baseUrl: 'http://127.0.0.1:PORT',
    respond: (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'all connections are cooling down' } }));
    },
  }, async ({ base, hits }) => {
    const res = await chat(base, { model: AUTO, messages: [{ role: 'user', content: 'hi' }] });
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.match(body.error, /cooling down/);
    assert.ok(hits.length > 1, 'a rate limit is retried');
    assert.ok(hits.length <= 6, 'and gives up rather than looping');
  });
});

test('health lists the provider as one this build knows', async () => {
  await withGateway({ baseUrl: undefined }, async ({ base }) => {
    const health = await (await fetch(base + '/api/health')).json();
    assert.ok(health.providers.includes('omniroute'));
  });
});