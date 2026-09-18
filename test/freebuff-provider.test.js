const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, normalizeProviderBaseUrl, clearModelCache, clearImageDiscoveryCache } = require('../server.js');

// Freebuff is a self-hosted Freebuff2API proxy (see deploy/freebuff-railway):
// an OpenAI-shaped front for Freebuff free coding models with a live model
// list. Like the custom slot it activates on the URL alone, with the key
// optional -- and like gpt4free its documented address stops short of /v1.

const TOUCHED = ['FREEBUFF_API_KEY', 'FREEBUFF_BASE_URL', 'FREEBUFF_MODELS', 'FREEBUFF_DISABLED'];

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

// A stand-in Freebuff2API: OpenAI-shaped catalogue on /v1/models, OpenAI
// chat on /v1/chat/completions, remembering whether a key travelled.
function freebuffStub(seen) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'minimax/minimax-m2.7' }, { id: 'z-ai/glm-5.1' }] }));
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      seen.auth = req.headers.authorization || null;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.chatBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Hello from Freebuff.' } }] }));
      });
      return;
    }
    res.writeHead(404); res.end('{"error":"Not found"}');
  });
}

async function withStub(run) {
  const seen = {};
  const stub = freebuffStub(seen);
  await new Promise((r) => stub.listen(0, r));
  try {
    await run({ seen, port: stub.address().port });
  } finally {
    stub.close();
  }
}

// Nothing set, nothing offered: the picker must not carry a row that can
// only fail, and the report must say chat rather than leaving the kind blank.
test('freebuff stays out of the way until its URL is set', async () => {
  await withCleanEnv(async () => {
    await routes(async ({ base }) => {
      const providers = await get(base, '/api/llm/providers');
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      assert.ok(byId.freebuff, 'the slot is listed even unconfigured');
      assert.equal(byId.freebuff.configured, false);
      assert.equal(byId.freebuff.kind, 'chat');
      assert.equal(byId.freebuff.label, 'Freebuff');
    });
  });
});

// The paste that matters: a Railway private address copied bare, without a
// scheme and without /v1 -- exactly what the service settings show. The
// address must activate the provider, the live catalogue must reach the
// picker in the proxy's own order, and a chat turn must go through with no
// auth header when no key was set.
test('a pasted Railway address activates the proxy, lists its models and chats keyless', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ port }) => {
      process.env.FREEBUFF_BASE_URL = `127.0.0.1:${port}`;
      clearModelCache();
      await routes(async ({ base }) => {
        const providers = await get(base, '/api/llm/providers');
        assert.ok(providers.some((p) => p.id === 'freebuff' && p.configured), 'the pasted address must activate the provider');
        const models = await get(base, '/api/llm/models?provider=freebuff');
        assert.deepEqual(models.map((m) => m.id), ['minimax/minimax-m2.7', 'z-ai/glm-5.1']);
        const chat = await (await fetch(base + '/api/llm/chat?provider=freebuff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'z-ai/glm-5.1', messages: [{ role: 'user', content: 'hi' }] }),
        })).json();
        assert.equal(chat.choices[0].message.content, 'Hello from Freebuff.');
      });
    });
  });
});

// The other half of the key contract: a set key travels as Bearer, matching
// a proxy deployed with API_KEYS -- and the suite proves the absence above,
// so this proves the presence.
test('a set key travels as Bearer on both the catalogue and the chat', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ seen, port }) => {
      process.env.FREEBUFF_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.FREEBUFF_API_KEY = 'proxy-key';
      clearModelCache();
      await routes(async ({ base }) => {
        await get(base, '/api/llm/models?provider=freebuff');
        const chat = await (await fetch(base + '/api/llm/chat?provider=freebuff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'z-ai/glm-5.1', messages: [{ role: 'user', content: 'hi' }] }),
        })).json();
        assert.equal(chat.choices[0].message.content, 'Hello from Freebuff.');
        assert.equal(seen.auth, 'Bearer proxy-key');
      });
    });
  });
});

// FREEBUFF_MODELS is the narrowing knob and FREEBUFF_DISABLED is the off
// switch, the same pair every key-optional slot honours.
test('FREEBUFF_MODELS narrows the picker and FREEBUFF_DISABLED switches it off', async () => {
  await withCleanEnv(async () => {
    await withStub(async ({ port }) => {
      process.env.FREEBUFF_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.FREEBUFF_MODELS = 'z-ai/glm-5.1';
      clearModelCache();
      await routes(async ({ base }) => {
        const models = await get(base, '/api/llm/models?provider=freebuff');
        assert.deepEqual(models.map((m) => m.id), ['z-ai/glm-5.1']);
      });
      process.env.FREEBUFF_DISABLED = '1';
      clearModelCache();
      await routes(async ({ base }) => {
        const providers = await get(base, '/api/llm/providers');
        const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
        assert.equal(byId.freebuff.configured, false, 'FREEBUFF_DISABLED=1 switches it off');
      });
    });
  });
});

// The declaration the server relies on: key optional (never a bare
// "Bearer "), URL-activated, /v1 completed, and chat-only -- the proxy
// serves no image endpoint, so an image block here would enrol a service
// whose every draw is a 404.
test('the freebuff slot is declared with the shape the server relies on', () => {
  const provider = LLM_PROVIDERS.freebuff;
  assert.equal(provider.label, 'Freebuff');
  assert.equal(provider.envVar, 'FREEBUFF_API_KEY');
  assert.equal(provider.needsKey, false);
  assert.equal(provider.needsBaseUrl, true);
  assert.equal(provider.image, undefined, 'chat-only proxy declares no image block');
  assert.equal(normalizeProviderBaseUrl('freebuff', 'http://freebuff.railway.internal:8080'), 'http://freebuff.railway.internal:8080/v1');
  assert.equal(normalizeProviderBaseUrl('freebuff', 'https://fb.example.com/v1'), 'https://fb.example.com/v1');
});
