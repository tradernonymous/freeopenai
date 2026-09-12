const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, normalizeProviderBaseUrl, clearModelCache } = require('../server.js');
const { usableChatModels } = require('../chatlib.js');

const OPUS = 'antigravity-claude-opus-4-6-thinking-high';

function snapshotEnv() {
  return {
    base: process.env.ANTIGRAVITY_BASE_URL,
    key: process.env.ANTIGRAVITY_API_KEY,
    models: process.env.ANTIGRAVITY_MODELS,
    delay: process.env.RATE_LIMIT_BASE_DELAY_MS,
  };
}

function restoreEnv(saved) {
  for (const [name, value] of [
    ['ANTIGRAVITY_BASE_URL', saved.base],
    ['ANTIGRAVITY_API_KEY', saved.key],
    ['ANTIGRAVITY_MODELS', saved.models],
    ['RATE_LIMIT_BASE_DELAY_MS', saved.delay],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// A stand-in for antigravity-proxy: it records every request so a test can prove
// what was *not* sent as much as what was.
async function withProxy({ baseUrl, key, models, respond } = {}, run) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', raw });
      if (respond) return respond(req, res, raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: OPUS,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from opus' }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const saved = snapshotEnv();
  if (baseUrl !== undefined) {
    process.env.ANTIGRAVITY_BASE_URL = baseUrl.replace(':PORT', ':' + upstream.address().port);
  } else {
    delete process.env.ANTIGRAVITY_BASE_URL;
  }
  if (key !== undefined) process.env.ANTIGRAVITY_API_KEY = key;
  if (models !== undefined) process.env.ANTIGRAVITY_MODELS = models;
  // The retry backoff is real (a few seconds between attempts), which would
  // make the refusal test below take half a minute. The delays are shortened
  // rather than the retries disabled, so the attempt count stays meaningful.
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

const modelsUrl = (base) => base + '/api/llm/models?provider=antigravity';

const chat = (base, body) => fetch(base + '/api/llm/chat?provider=antigravity', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('the pinned list is one the picker would actually show, Opus included', () => {
  const ids = LLM_PROVIDERS.antigravity.models;
  assert.ok(Array.isArray(ids) && ids.length >= 5);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids in the list');
  assert.ok(ids.some((id) => id.includes('opus')), 'Opus is the point of this provider');
  // The same rule the client renders by: a model the chat filter drops would be
  // pinned here and never appear, which is worse than not pinning it at all.
  const shown = new Set(usableChatModels(ids.map((id) => ({ id }))).map((m) => m.id));
  for (const id of ids) assert.ok(shown.has(id), `${id} would be filtered out of the picker`);
  assert.ok(shown.has(OPUS));
});

test('the provider is registered with the shape the server relies on', () => {
  const provider = LLM_PROVIDERS.antigravity;
  assert.equal(provider.label, 'Antigravity');
  assert.equal(provider.envVar, 'ANTIGRAVITY_API_KEY');
  assert.equal(provider.needsKey, false, 'the proxy holds the Google credentials, not us');
  assert.equal(provider.catalogue, false, 'it publishes no model catalogue');
});

test('a base URL without the version segment is completed, and /v1 is not doubled', () => {
  assert.equal(normalizeProviderBaseUrl('antigravity', 'http://localhost:3000'), 'http://localhost:3000/v1');
  assert.equal(normalizeProviderBaseUrl('antigravity', 'http://localhost:3000/'), 'http://localhost:3000/v1');
  assert.equal(normalizeProviderBaseUrl('antigravity', 'https://box.example/v1'), 'https://box.example/v1');
  assert.equal(normalizeProviderBaseUrl('antigravity', 'https://box.example/v1/'), 'https://box.example/v1');
  // Other providers are untouched: Nara's base URL is already its API root.
  assert.equal(normalizeProviderBaseUrl('nara', 'https://router.bynara.id/v1'), 'https://router.bynara.id/v1');
});

test('an unconfigured proxy stays out of the picker and says so when asked', async () => {
  await withProxy({ baseUrl: undefined }, async ({ base, hits }) => {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    const entry = providers.find((p) => p.id === 'antigravity');
    assert.equal(entry.configured, false);
    assert.equal(entry.label, 'Antigravity');

    const res = await fetch(modelsUrl(base));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown or unconfigured/);
    assert.equal(hits.length, 0, 'nothing is contacted for a provider that is switched off');
  });
});

test('the declared list is served without asking the proxy for a catalogue', async () => {
  await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1' }, async ({ base, hits }) => {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    assert.equal(providers.find((p) => p.id === 'antigravity').configured, true);

    const models = await (await fetch(modelsUrl(base))).json();
    assert.deepEqual(models.map((m) => m.id), LLM_PROVIDERS.antigravity.models);
    // This is the whole point of catalogue:false. A proxy that never
    // implemented /v1/models must not produce a fetch error or an empty picker.
    assert.equal(hits.length, 0);
  });
});

test('ANTIGRAVITY_MODELS replaces the pinned list for a proxy whose ids differ', async () => {
  const declared = 'antigravity-claude-opus-5-thinking-high, antigravity-gemini-4-pro';
  await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1', models: declared }, async ({ base, hits }) => {
    const models = await (await fetch(modelsUrl(base))).json();
    assert.deepEqual(models.map((m) => m.id), [
      'antigravity-claude-opus-5-thinking-high',
      'antigravity-gemini-4-pro',
    ]);
    assert.equal(hits.length, 0);
  });
});

test('a blank ANTIGRAVITY_MODELS falls back to the pinned list instead of emptying the picker', async () => {
  // The variable exists to override the list. Set to an empty Railway field, a
  // stray space or a commented-out line, the list it produces is empty -- and an
  // empty list is served as "this provider has no models", which reads as the
  // provider being broken and is the one thing that cannot be recovered from in
  // the UI. Something is better than nothing here, always.
  for (const blank of ['', '   ', ',', ' , ']) {
    await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1', models: blank }, async ({ base, hits }) => {
      const res = await fetch(modelsUrl(base));
      const models = await res.json();
      assert.equal(res.status, 200, 'a blank declaration is not an error');
      assert.ok(models.length > 0, 'the pinned list is served instead of nothing: ' + JSON.stringify(models));
      assert.ok(models.some((m) => m.id === OPUS), 'including the reason this provider is wired up at all');
      assert.equal(hits.length, 0, 'and nothing was fetched from a proxy that publishes no catalogue');
    });
  }
});

test('ids that cannot address a model are dropped, not served as unclickable rows', async () => {
  // A paste from a word processor leaves a zero-width space or a smart quote in
  // the list. Such an id can never resolve -- the provider answers 404 and the
  // picker offers a row that cannot work. Dropping the entry, and falling back
  // to the pinned list when that leaves nothing, is the only answer that ends in
  // a usable picker.
  await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1', models: '\u200b' }, async ({ base }) => {
    const models = await (await fetch(modelsUrl(base))).json();
    assert.ok(models.some((m) => m.id === OPUS), 'the pinned list is served: ' + JSON.stringify(models));
  });
  // A good id beside a broken one keeps the good one and loses only the bad.
  await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1', models: 'antigravity-gemini-4-pro,\u201cquoted\u201d' }, async ({ base }) => {
    const models = await (await fetch(modelsUrl(base))).json();
    assert.deepEqual(models.map((m) => m.id), ['antigravity-gemini-4-pro']);
  });
});

test('a chat call reaches the proxy on the OpenAI path, with the model asked for', async () => {
  await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1' }, async ({ base, hits }) => {
    const res = await chat(base, { model: OPUS, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'hello from opus');

    assert.equal(hits.length, 1);
    // The bare base URL was completed to /v1, and the request landed on the
    // OpenAI chat path the proxy documents.
    assert.equal(hits[0].url, '/v1/chat/completions');
    assert.equal(hits[0].method, 'POST');
    assert.equal(JSON.parse(hits[0].raw).model, OPUS);
    // No key of its own: sending a bare "Bearer " would be a made-up credential.
    assert.equal(hits[0].auth, '');
  });
});

test('a key, when one is set, is sent as a bearer token', async () => {
  await withProxy({ baseUrl: 'http://127.0.0.1:PORT/v1', key: 'sekret' }, async ({ base, hits }) => {
    await chat(base, { model: OPUS, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(hits[0].auth, 'Bearer sekret');
  });
});

test('a refusal from the proxy is reported with its own message', async () => {
  await withProxy({
    baseUrl: 'http://127.0.0.1:PORT/v1',
    respond: (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'all Antigravity accounts are cooling down' } }));
    },
  }, async ({ base, hits }) => {
    const res = await chat(base, { model: OPUS, messages: [{ role: 'user', content: 'hi' }] });
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.match(body.error, /cooling down/);
    // A 429 is retried, since the proxy cools accounts and comes back -- but a
    // bounded number of times, not forever.
    assert.ok(hits.length > 1, 'a rate limit is retried');
    assert.ok(hits.length <= 6, 'and gives up rather than looping');
  });
});

test('health lists the provider as one this build knows', async () => {
  await withProxy({ baseUrl: undefined }, async ({ base }) => {
    const health = await (await fetch(base + '/api/health')).json();
    assert.ok(health.providers.includes('antigravity'));
  });
});
