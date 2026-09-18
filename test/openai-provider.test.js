const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, clearModelCache, clearImageDiscoveryCache } = require('../server.js');

// OpenAI on a key of your own: chat from the live catalogue plus the image
// models no free service carries (gpt-image-1 draws and edits). Billed, so
// the whole slot stays out until the key is set.

const TOUCHED = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODELS', 'OPENAI_DISABLED', 'OPENAI_IMAGE_MODEL'];

function withCleanEnv(run) {
  const saved = new Map();
  for (const name of TOUCHED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  clearModelCache();
  clearImageDiscoveryCache();
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      clearModelCache();
      clearImageDiscoveryCache();
    });
}

async function routes(run) {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    await run({ base });
  } finally {
    app.close();
  }
}

const get = async (base, path) => (await fetch(base + path)).json();

// A stand-in api.openai.com: catalogue, chat, generations and edits,
// remembering what each call carried.
function openaiStub(seen) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-image-1' }] }));
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      seen.auth = req.headers.authorization || null;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Hello from OpenAI.' } }] }));
      });
      return;
    }
    if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
      seen.auth = req.headers.authorization || null;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.genBody = raw;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'AAA' }] }));
      });
      return;
    }
    if (url.pathname === '/v1/images/edits' && req.method === 'POST') {
      seen.editType = req.headers['content-type'] || null;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.editBody = raw;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'BBB' }] }));
      });
      return;
    }
    res.writeHead(404); res.end('{"error":"Not found"}');
  });
}

async function withStub(run) {
  const seen = {};
  const stub = openaiStub(seen);
  await new Promise((r) => stub.listen(0, r));
  try {
    await run({ seen, port: stub.address().port });
  } finally {
    stub.close();
  }
}

function pointAt(port) {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  clearModelCache();
  clearImageDiscoveryCache();
}

// Billed means hidden: no key, no row in the picker, no drawing.
test('openai stays out until its key is set', async () => {
  await withCleanEnv(async () => {
    await routes(async ({ base }) => {
      const providers = await get(base, '/api/llm/providers');
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      assert.ok(byId.openai, 'the slot is listed even unconfigured');
      assert.equal(byId.openai.configured, false);
      assert.equal(byId.openai.kind, 'chat');
    });
  });
});

// Key set: catalogue, chat with Bearer, and the key travelling on draws too.
test('a key lights up chat with the key travelling as Bearer', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ seen, port }) => {
      pointAt(port);
      await routes(async ({ base }) => {
        const providers = await get(base, '/api/llm/providers');
        assert.ok(providers.some((p) => p.id === 'openai' && p.configured));
        const models = await get(base, '/api/llm/models?provider=openai');
        assert.deepEqual(models.map((m) => m.id), ['gpt-4o-mini', 'gpt-image-1']);
        const chat = await (await fetch(base + '/api/llm/chat?provider=openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
        })).json();
        assert.equal(chat.choices[0].message.content, 'Hello from OpenAI.');
        assert.equal(seen.auth, 'Bearer sk-test');
      });
    });
  });
});

// The point of the slot: gpt-image-1 draws through the route with the
// service naming itself, and the request is the OpenAI shape.
test('generations draws gpt-image-1 through the route', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ seen, port }) => {
      pointAt(port);
      await routes(async ({ base }) => {
        const res = await fetch(base + '/api/llm/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'a red circle' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.data, [{ b64_json: 'AAA' }]);
        assert.equal(body.provider, 'openai');
        assert.deepEqual(JSON.parse(seen.genBody), { prompt: 'a red circle', model: 'gpt-image-1' });
      });
    });
  });
});

// And it edits: multipart file parts on /images/edits, stepped past by no
// one, because the shape is declared.
test('edits builds multipart on the images/edits endpoint', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ seen, port }) => {
      pointAt(port);
      await routes(async ({ base }) => {
        const res = await fetch(base + '/api/llm/images/edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'add a hat', image: 'data:image/png;base64,AA==' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.data, [{ b64_json: 'BBB' }]);
        assert.equal(body.provider, 'openai');
        assert.match(seen.editType, /multipart\/form-data/);
        assert.ok(seen.editBody.includes('add a hat'), 'prompt part present');
        assert.ok(seen.editBody.includes('gpt-image-1'), 'model part present');
      });
    });
  });
});

// OPENAI_IMAGE_MODEL pins a different drawing model; OPENAI_DISABLED=1
// switches the whole slot off.
test('OPENAI_IMAGE_MODEL pins the drawing model and OPENAI_DISABLED switches it off', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ seen, port }) => {
      pointAt(port);
      process.env.OPENAI_IMAGE_MODEL = 'dall-e-3';
      clearImageDiscoveryCache();
      await routes(async ({ base }) => {
        const listed = await get(base, '/api/llm/images/providers');
        const openai = listed.providers.find((p) => p.id === 'openai');
        assert.ok(openai, 'a provider that can draw is listed');
        assert.equal(openai.ready, true);
        assert.equal(openai.model, 'dall-e-3');
        await fetch(base + '/api/llm/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'a cat' }),
        });
        assert.deepEqual(JSON.parse(seen.genBody), { prompt: 'a cat', model: 'dall-e-3' });
      });
      process.env.OPENAI_DISABLED = '1';
      clearModelCache();
      await routes(async ({ base }) => {
        const providers = await get(base, '/api/llm/providers');
        const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
        assert.equal(byId.openai.configured, false, 'OPENAI_DISABLED=1 switches it off');
      });
    });
  });
});

// The declaration the server relies on.
test('the openai slot is declared with the shape the server relies on', () => {
  const provider = LLM_PROVIDERS.openai;
  assert.equal(provider.label, 'OpenAI');
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
  assert.equal(provider.envVar, 'OPENAI_API_KEY');
  assert.equal(provider.image.shape, 'openai-images');
  assert.equal(provider.image.defaultModel, 'gpt-image-1');
  assert.equal(provider.image.edit, 'multipart');
  assert.deepEqual(provider.image.sizes.map((s) => s.value), ['1024x1024', '1536x1024', '1024x1536']);
});
