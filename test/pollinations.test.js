// Pollinations.ai: the one image drawer that needs no key at all -- a GET
// with the prompt in the URL path, answering with the picture itself
// (image/*) rather than a JSON envelope. Its URL is hardcoded (there is no
// base URL to override, unlike every OpenAI-shaped provider), so these tests
// intercept global.fetch the same way cloudflare.test.js's "default image
// URL" test does, rather than pointing a base URL at a local stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, clearModelCache, clearImageDiscoveryCache } = require('../server.js');

function clear() {
  delete process.env.POLLINATIONS_DISABLED;
  clearModelCache();
  clearImageDiscoveryCache();
}

test.beforeEach(clear);
test.afterEach(clear);

async function withApp(run) {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  try {
    return await run(`http://127.0.0.1:${app.address().port}`);
  } finally {
    app.close();
  }
}

test('pollinations is configured with no variables set at all', async () => {
  await withApp(async (base) => {
    const rows = await (await fetch(base + '/api/llm/images/providers')).json();
    const row = rows.providers.find((p) => p.id === 'pollinations');
    assert.ok(row, 'pollinations is wired up');
    assert.equal(row.ready, true, 'no key should ever be required');
    assert.equal(row.model, 'flux');
  });
});

test('POLLINATIONS_DISABLED=1 reports it not ready, same as any other switched-off provider', async () => {
  process.env.POLLINATIONS_DISABLED = '1';
  await withApp(async (base) => {
    const rows = await (await fetch(base + '/api/llm/images/providers')).json();
    const row = rows.providers.find((p) => p.id === 'pollinations');
    assert.ok(row, 'the provider stays listed -- disabled is a reason, not a disappearance');
    assert.equal(row.ready, false);
  });
});

test('drawing GETs the prompt in the URL path and reads the image bytes back, no auth header sent', async () => {
  const realFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://image.pollinations.ai/')) {
      requests.push({ url: String(url), init });
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      return new globalThis.Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    return realFetch(url, init);
  };
  try {
    await withApp(async (base) => {
      const res = await realFetch(base + '/api/llm/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'pollinations', prompt: 'a red apple', size: '1024x1024' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.provider, 'pollinations');
      assert.equal(body.data[0].b64_json, Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'));
      assert.equal(body.data[0].media_type, 'image/png');
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/image\.pollinations\.ai\/prompt\/a%20red%20apple\?/);
    assert.match(requests[0].url, /width=1024/);
    assert.match(requests[0].url, /height=1024/);
    // GET, not POST -- there is no body to send, and no auth header exists to send.
    assert.ok(!requests[0].init || !requests[0].init.method || requests[0].init.method === 'GET');
    assert.ok(!requests[0].init || !requests[0].init.headers || !requests[0].init.headers.Authorization);
  } finally {
    global.fetch = realFetch;
  }
});
