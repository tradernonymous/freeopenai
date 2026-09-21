// Gemini's free-tier image model (gemini-2.5-flash-image, "Nano Banana")
// answers on Gemini's own generateContent API, a different address, auth
// header and response shape than the OpenAI-compatibility endpoint the chat
// path uses (see test/gemini-provider.test.js for that one). Its URL is
// hardcoded (no base URL to point at a local stand-in), so these tests
// intercept global.fetch the same way test/pollinations.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, clearModelCache, clearImageDiscoveryCache } = require('../server.js');

function clear() {
  delete process.env.GEMINI_API_KEY;
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

test('gemini has no image model to draw with until a key is set', async () => {
  await withApp(async (base) => {
    const rows = await (await fetch(base + '/api/llm/images/providers')).json();
    const row = rows.providers.find((p) => p.id === 'gemini');
    assert.ok(row);
    assert.equal(row.ready, false);
  });
});

test('a key alone is enough -- gemini-2.5-flash-image needs no operator variable to draw', async () => {
  process.env.GEMINI_API_KEY = 'gk-test';
  await withApp(async (base) => {
    const rows = await (await fetch(base + '/api/llm/images/providers')).json();
    const row = rows.providers.find((p) => p.id === 'gemini');
    assert.equal(row.ready, true);
    assert.equal(row.model, 'gemini-2.5-flash-image');
  });
});

test('drawing posts to generateContent with x-goog-api-key, not a Bearer token, and reads inlineData back', async () => {
  process.env.GEMINI_API_KEY = 'gk-test';
  const realFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) {
      requests.push({ url: String(url), init });
      return new globalThis.Response(JSON.stringify({
        candidates: [{ content: { parts: [
          { text: 'Here you go' },
          { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
        ] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  try {
    await withApp(async (base) => {
      const res = await realFetch(base + '/api/llm/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini', prompt: 'a nano banana' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.provider, 'gemini');
      assert.equal(body.data[0].b64_json, 'aGVsbG8=');
      assert.equal(body.data[0].media_type, 'image/png');
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/models\/gemini-2\.5-flash-image:generateContent$/);
    assert.equal(requests[0].init.headers['x-goog-api-key'], 'gk-test');
    assert.equal(requests[0].init.headers.Authorization, undefined, 'gemini reads x-goog-api-key, not a Bearer token');
    const sent = JSON.parse(requests[0].init.body);
    assert.equal(sent.contents[0].parts[0].text, 'a nano banana');
  } finally {
    global.fetch = realFetch;
  }
});

test('a text-only answer (no image part) is reported as a failed draw, not a picture', async () => {
  process.env.GEMINI_API_KEY = 'gk-test';
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/models/')) {
      return new globalThis.Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  try {
    await withApp(async (base) => {
      const res = await realFetch(base + '/api/llm/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini', prompt: 'x' }),
      });
      // No image part means the generic payload.data fallback runs, which is
      // undefined here -- the caller sees a response with no usable picture
      // rather than one silently filled in with text.
      const body = await res.json();
      assert.ok(!body.data || !body.data.data, 'no image part must not produce a fake picture');
    });
  } finally {
    global.fetch = realFetch;
  }
});
