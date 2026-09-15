// Rovo Dev reaches the app as an ordinary OpenAI-compatible provider, but what
// is behind it is not ordinary: Atlassian's `acli rovodev serve` with a shim
// translating /v1 to Rovo's /v3, both inside deploy/rovo-proxy, behind a gate
// that is the only thing stopping a tunnelled URL from spending the account's
// 5M-token daily allowance.
//
// These tests stand a stub in for that container. They cover the contract the
// app depends on, and two things specific to this provider: it publishes no
// pinned model list (the container reports what the account can reach), and the
// key is sent as a bearer even though needsKey is false -- because here the key
// authenticates to the container rather than to Rovo.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, normalizeProviderBaseUrl, clearModelCache } = require('../server.js');
const { usableChatModels } = require('../chatlib.js');

function snapshotEnv() {
  return {
    base: process.env.ROVO_BASE_URL,
    key: process.env.ROVO_API_KEY,
    models: process.env.ROVO_MODELS,
    delay: process.env.RATE_LIMIT_BASE_DELAY_MS,
  };
}

function restoreEnv(saved) {
  for (const [name, value] of [
    ['ROVO_BASE_URL', saved.base],
    ['ROVO_API_KEY', saved.key],
    ['ROVO_MODELS', saved.models],
    ['RATE_LIMIT_BASE_DELAY_MS', saved.delay],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// What the shim reports: the Claude tier the account can reach, and nothing
// else. The embedding id is here to prove the chat filter still runs on a
// catalogue this app does not control.
const CATALOGUE = [
  { id: 'claude-sonnet-4' },
  { id: 'gpt-5' },
  { id: 'text-embedding-3-small' },
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
        id: 'chatcmpl-rovo',
        object: 'chat.completion',
        model: 'claude-sonnet-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from Rovo' }, finish_reason: 'stop' }],
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const saved = snapshotEnv();
  if (baseUrl !== undefined) {
    process.env.ROVO_BASE_URL = baseUrl.replace(':PORT', ':' + upstream.address().port);
  } else {
    delete process.env.ROVO_BASE_URL;
  }
  if (key !== undefined) process.env.ROVO_API_KEY = key;
  else delete process.env.ROVO_API_KEY;
  if (models !== undefined) process.env.ROVO_MODELS = models;
  else delete process.env.ROVO_MODELS;
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

const modelsUrl = (base) => base + '/api/llm/models?provider=rovo';

const chat = (base, body) => fetch(base + '/api/llm/chat?provider=rovo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('the provider is registered with the shape the server relies on', () => {
  const provider = LLM_PROVIDERS.rovo;
  assert.equal(provider.label, 'Rovo');
  assert.equal(provider.envVar, 'ROVO_API_KEY');
  assert.equal(provider.needsKey, false, 'the key authenticates to the container, not to Rovo');
  // No pinned list on purpose: the container reports what the account reaches,
  // and a list pinned here would go stale against a catalogue that is not ours.
  assert.equal(provider.models, undefined, 'the live catalogue is the source of truth here');
  // Text only. An image block would make it a draw candidate for a shim that
  // forwards no multimodal parts at all.
  assert.equal(provider.image, undefined, 'the shim is text-only');
});

test('a base URL without the version segment is completed, and /v1 is not doubled', () => {
  assert.equal(normalizeProviderBaseUrl('rovo', 'http://localhost:4000'), 'http://localhost:4000/v1');
  assert.equal(normalizeProviderBaseUrl('rovo', 'http://localhost:4000/'), 'http://localhost:4000/v1');
  assert.equal(normalizeProviderBaseUrl('rovo', 'https://x.trycloudflare.com/v1'), 'https://x.trycloudflare.com/v1');
  assert.equal(normalizeProviderBaseUrl('rovo', 'https://x.trycloudflare.com/v1/'), 'https://x.trycloudflare.com/v1');
});

test('an unconfigured gateway stays out of the picker and says so when asked', async () => {
  await withGateway({ baseUrl: undefined }, async ({ base, hits }) => {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    const entry = providers.find((p) => p.id === 'rovo');
    assert.equal(entry.configured, false);
    assert.equal(entry.label, 'Rovo');

    const res = await fetch(modelsUrl(base));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown or unconfigured/);
    assert.equal(hits.length, 0, 'nothing is contacted for a provider that is switched off');
  });
});

test('a base URL alone switches it on, and the live catalogue is what is offered', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT' }, async ({ base, hits }) => {
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    assert.equal(providers.find((p) => p.id === 'rovo').configured, true,
      'a gateway needs no key of ours to be usable');

    const listed = await (await fetch(modelsUrl(base))).json();
    const ids = listed.map((m) => m.id);
    assert.ok(ids.includes('claude-sonnet-4'), 'the Claude tier is the reason this provider exists');
    assert.ok(hits.some((h) => h.url.startsWith('/v1/models')));

    // A provider with no allow-list passes the catalogue through untouched, the
    // way mistral does -- the chat filter lives in the page, not the route
    // (index.html calls usableChatModels on this response). So the thing worth
    // asserting is that the shared rule drops what should never be offered,
    // rather than pretending the endpoint did it.
    const shown = new Set(usableChatModels(listed).map((m) => m.id));
    assert.ok(shown.has('claude-sonnet-4'));
    assert.equal(shown.has('text-embedding-3-small'), false, 'an embedding model would reach the picker');
  });
});

test('the key rides as a bearer, because it is the gate that checks it', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT', key: 'gate-secret' }, async ({ base, hits }) => {
    await fetch(modelsUrl(base));
    assert.ok(hits.length > 0);
    assert.equal(hits[0].auth, 'Bearer gate-secret');
  });
});

test('a chat reaches the OpenAI path and carries the model, tools and stream flag', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT' }, async ({ base, hits }) => {
    const res = await chat(base, {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    });
    assert.equal(res.status, 200);
    const sent = hits.find((h) => h.url.startsWith('/v1/chat/completions'));
    assert.ok(sent, 'the chat did not reach /v1/chat/completions');
    const body = JSON.parse(sent.raw);
    assert.equal(body.model, 'claude-sonnet-4');
    assert.equal(body.messages[0].content, 'hi');
    assert.ok(Array.isArray(body.tools) && body.tools.length === 1, 'tools have to survive the hop');
  });
});

test('ROVO_MODELS overrides the live catalogue, for when the shim reports wrongly', async () => {
  await withGateway({
    baseUrl: 'http://127.0.0.1:PORT',
    models: 'claude-sonnet-4',
  }, async ({ base }) => {
    const ids = (await (await fetch(modelsUrl(base))).json()).map((m) => m.id);
    assert.deepEqual(ids, ['claude-sonnet-4']);
  });
});

test('an upstream refusal is reported with its own words, not a generic failure', async () => {
  await withGateway({
    baseUrl: 'http://127.0.0.1:PORT',
    respond: (req, res) => {
      // What the gate answers when the key is wrong -- the mistake most likely
      // to be made when wiring a tunnel URL into Railway.
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: send Authorization: Bearer <ROVO_API_KEY>' }));
    },
  }, async ({ base }) => {
    const res = await chat(base, { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(res.status >= 400);
    const detail = JSON.stringify(await res.json());
    assert.match(detail, /Unauthorized|ROVO_API_KEY/, 'the gate’s own reason has to survive to the user');
  });
});

test('health lists the provider so a deploy can be checked without the picker', async () => {
  await withGateway({ baseUrl: 'http://127.0.0.1:PORT' }, async ({ base }) => {
    const health = await (await fetch(base + '/api/health')).json();
    const ids = (health.providers || []).map((p) => (typeof p === 'string' ? p : p.id));
    assert.ok(ids.includes('rovo'), 'rovo is missing from /api/health');
  });
});
