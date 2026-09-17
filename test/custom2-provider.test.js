const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, clearModelCache } = require('../server.js');

// The second generic slot exists for the deployment that runs two self-hosted
// gateways at once -- a CLIProxyAPI wrapping agent-CLI logins beside a Kiro
// Gateway is the pairing that asked for it. These tests hold it to the custom
// slot's contract: the URL alone activates it, the key is optional, the
// gateway's own catalogue is what the picker shows, and a pinned subset stays
// possible. A local upstream stands in for the gateway, the way the real one
// would answer.

function upstreamStub() {
  const seen = { auth: '' };
  const upstream = http.createServer((req, res) => {
    seen.auth = req.headers.authorization || '';
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gateway-gemini' }, { id: 'gateway-gpt' }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
  });
  return { upstream, seen };
}

test('the second custom slot is declared and starts unconfigured', async () => {
  assert.equal(LLM_PROVIDERS.custom2.envVar, 'CUSTOM2_API_KEY');
  assert.equal(LLM_PROVIDERS.custom2.needsKey, false);
  assert.equal(LLM_PROVIDERS.custom2.needsBaseUrl, true);

  delete process.env.CUSTOM2_API_KEY;
  delete process.env.CUSTOM2_BASE_URL;
  delete process.env.CUSTOM2_MODELS;
  clearModelCache();
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const plain = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
  app.close();
  assert.equal(plain.find((p) => p.id === 'custom2').configured, false, 'a URL-less slot reports itself off');
});

test('CUSTOM2_BASE_URL alone activates the slot and serves the gateway catalogue whole', async () => {
  clearModelCache();
  const { upstream, seen } = upstreamStub();
  await new Promise((r) => upstream.listen(0, r));
  process.env.CUSTOM2_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const offered = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
    assert.equal(offered.find((p) => p.id === 'custom2').configured, true, 'a URL alone activates the slot');
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=custom2`)).json();
    assert.deepEqual(body.map((m) => m.id), ['gateway-gemini', 'gateway-gpt']);
    assert.equal(seen.auth, '', 'a keyless gateway is not sent a bare Bearer header');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.CUSTOM2_BASE_URL;
    clearModelCache();
  }
});

test('CUSTOM2_API_KEY travels as the bearer and CUSTOM2_MODELS pins the picker', async () => {
  clearModelCache();
  const { upstream, seen } = upstreamStub();
  await new Promise((r) => upstream.listen(0, r));
  process.env.CUSTOM2_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  process.env.CUSTOM2_API_KEY = 'slot-two-secret';
  process.env.CUSTOM2_MODELS = 'gateway-gpt';
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=custom2`)).json();
    assert.deepEqual(body.map((m) => m.id), ['gateway-gpt']);
    assert.equal(seen.auth, 'Bearer slot-two-secret');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.CUSTOM2_BASE_URL;
    delete process.env.CUSTOM2_API_KEY;
    delete process.env.CUSTOM2_MODELS;
    clearModelCache();
  }
});
