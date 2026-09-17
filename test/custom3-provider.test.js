const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, clearModelCache } = require('../server.js');

// The third generic slot is the custom slot's twin, added so a deployment can
// run FreeGPT4, a CLIProxyAPI and a Kiro Gateway at the same time -- three
// OpenAI-compatible gateways, three URLs, no key required by any of them.
// Same contract as custom2: the URL alone activates it, the key is optional,
// the gateway's catalogue is what the picker shows.

function upstreamStub() {
  const seen = { auth: '' };
  const upstream = http.createServer((req, res) => {
    seen.auth = req.headers.authorization || '';
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'kiro-sonnet' }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
  });
  return { upstream, seen };
}

test('the third custom slot is declared and starts unconfigured', async () => {
  assert.equal(LLM_PROVIDERS.custom3.envVar, 'CUSTOM3_API_KEY');
  assert.equal(LLM_PROVIDERS.custom3.needsKey, false);
  assert.equal(LLM_PROVIDERS.custom3.needsBaseUrl, true);

  delete process.env.CUSTOM3_API_KEY;
  delete process.env.CUSTOM3_BASE_URL;
  delete process.env.CUSTOM3_MODELS;
  clearModelCache();
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const plain = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
  app.close();
  assert.equal(plain.find((p) => p.id === 'custom3').configured, false, 'a URL-less slot reports itself off');
});

test('CUSTOM3_BASE_URL alone activates the slot, key optional, catalogue whole', async () => {
  clearModelCache();
  const { upstream, seen } = upstreamStub();
  await new Promise((r) => upstream.listen(0, r));
  process.env.CUSTOM3_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const offered = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
    assert.equal(offered.find((p) => p.id === 'custom3').configured, true, 'a URL alone activates the slot');
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=custom3`)).json();
    assert.deepEqual(body.map((m) => m.id), ['kiro-sonnet']);
    assert.equal(seen.auth, '', 'no bare Bearer header without a key');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.CUSTOM3_BASE_URL;
    clearModelCache();
  }
});

test('all three custom slots can be configured at once and stay distinct', async () => {
  clearModelCache();
  const make = (id) => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: `model-of-${id}` }] }));
    });
    return new Promise((r) => upstream.listen(0, r)).then(() => upstream);
  };
  const a = await make('a');
  const b = await make('b');
  const c = await make('c');
  process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${a.address().port}/v1`;
  process.env.CUSTOM2_BASE_URL = `http://127.0.0.1:${b.address().port}/v1`;
  process.env.CUSTOM3_BASE_URL = `http://127.0.0.1:${c.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const offered = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
    for (const id of ['custom', 'custom2', 'custom3']) {
      assert.equal(offered.find((p) => p.id === id).configured, true, `${id} is on`);
    }
    for (const [id, letter] of [['custom', 'a'], ['custom2', 'b'], ['custom3', 'c']]) {
      const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=${id}`)).json();
      assert.deepEqual(body.map((m) => m.id), [`model-of-${letter}`], `${id} reaches its own gateway`);
    }
  } finally {
    if (app) app.close();
    a.close(); b.close(); c.close();
    delete process.env.CUSTOM_BASE_URL;
    delete process.env.CUSTOM2_BASE_URL;
    delete process.env.CUSTOM3_BASE_URL;
    clearModelCache();
  }
});
