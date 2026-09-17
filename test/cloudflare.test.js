// Cloudflare Workers AI: the official free allowance on a Cloudflare account,
// reached with the account's own API token. Its URLs carry the account id, its
// chat path has no model catalogue, and it draws through run-by-name
// (POST /ai/run/<model>) answering {result:{image}} -- each of which is a way
// for a generic provider path to get it wrong, so each has a test here.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, clearModelCache, clearImageDiscoveryCache } = require('../server.js');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const VARS = [
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_BASE_URL', 'CLOUDFLARE_MODELS',
  'CLOUDFLARE_IMAGES_BASE_URL', 'CLOUDFLARE_IMAGE_MODEL',
  'NARA_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'OMNIROUTE_API_KEY', 'OMNIROUTE_BASE_URL', 'IMAGE_PROVIDER',
];

function clear() {
  for (const name of VARS) delete process.env[name];
  clearModelCache();
  clearImageDiscoveryCache();
}

test.beforeEach(clear);
test.afterEach(clear);

async function upstreamOf(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function withApp(run) {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  try {
    return await run(`http://127.0.0.1:${app.address().port}`);
  } finally {
    app.close();
  }
}

test('a token without the account id is not a configured provider', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  await withApp(async (base) => {
    const rows = await (await fetch(base + '/api/llm/providers')).json();
    const row = rows.find((p) => p.id === 'cloudflare');
    assert.ok(row, 'the provider is known to the build');
    assert.equal(row.configured, false);
  });
});

test('token plus account id lists the pinned chat models without fetching a catalogue', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  await withApp(async (base) => {
    const rows = await (await fetch(base + '/api/llm/providers')).json();
    assert.equal(rows.find((p) => p.id === 'cloudflare').configured, true);
    const res = await fetch(base + '/api/llm/models?provider=cloudflare');
    assert.equal(res.status, 200);
    const ids = (await res.json()).map((m) => m.id);
    assert.ok(ids.includes('@cf/openai/gpt-oss-120b'));
    assert.ok(ids.every((id) => id.startsWith('@cf/')));
  });
});

test('an account id that is not one is named before any request', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'me@example.com';
  await withApp(async (base) => {
    const res = await fetch(base + '/api/llm/models?provider=cloudflare');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /CLOUDFLARE_ACCOUNT_ID should be the 32-character account id/);
  });
});

test('drawing runs FLUX.1 schnell by name and reads {result:{image}}', async () => {
  const up = await upstreamOf((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { image: '/9j/AAAA' }, success: true, errors: [] }));
  });
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_IMAGES_BASE_URL = up.url;
  try {
    await withApp(async (base) => {
      const res = await fetch(base + '/api/llm/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a red apple', size: '1024x1024' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.provider, 'cloudflare');
      assert.equal(body.data[0].b64_json, '/9j/AAAA');
      assert.equal(up.seen.length, 1);
      assert.equal(up.seen[0].url, '/run/@cf/black-forest-labs/flux-1-schnell');
      assert.equal(up.seen[0].headers.authorization, 'Bearer cf-token');
      assert.deepEqual(JSON.parse(up.seen[0].body), { prompt: 'a red apple', steps: 4 });
    });
  } finally {
    await new Promise((r) => up.server.close(r));
  }
});

test('the default image URL carries the account id', async () => {
  // No override: the request must be addressed to the account. A stand-in
  // cannot answer api.cloudflare.com, so this reads the URL the route reports
  // having tried by pointing fetch at a recorder.
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  const realFetch = global.fetch;
  const called = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.cloudflare.com/')) {
      called.push(String(url));
      return new globalThis.Response(JSON.stringify({ result: { image: 'QUJD' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  try {
    await withApp(async (base) => {
      const res = await realFetch(base + '/api/llm/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
      });
      assert.equal(res.status, 200);
    });
    assert.deepEqual(called, [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`]);
  } finally {
    global.fetch = realFetch;
  }
});

test('a chat asks Workers AI for a real output limit, and passes the client\'s own through', async () => {
  const up = await upstreamOf((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }));
  });
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_BASE_URL = up.url;
  try {
    await withApp(async (base) => {
      const ask = (extra) => fetch(base + '/api/llm/chat?provider=cloudflare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: '@cf/qwen/qwq-32b', messages: [{ role: 'user', content: 'hi' }], ...extra }),
      });
      assert.equal((await ask({})).status, 200);
      assert.equal(JSON.parse(up.seen[0].body).max_tokens, 4096, 'the 256-token default would cut a thinking model off');
      assert.equal((await ask({ max_tokens: 800 })).status, 200);
      assert.equal(JSON.parse(up.seen[1].body).max_tokens, 800);
    });
  } finally {
    await new Promise((r) => up.server.close(r));
  }
});

test("Cloudflare's {errors:[{message}]} envelope is what the user reads", async () => {
  const up = await upstreamOf((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: null, success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
  });
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CLOUDFLARE_BASE_URL = up.url;
  try {
    await withApp(async (base) => {
      const res = await fetch(base + '/api/llm/chat?provider=cloudflare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.ok(res.status >= 400);
      assert.match(await res.text(), /Authentication error/);
    });
  } finally {
    await new Promise((r) => up.server.close(r));
  }
});
