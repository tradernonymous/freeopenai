const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, normalizeProviderBaseUrl, clearModelCache, clearImageDiscoveryCache } = require('../server.js');
const { usableChatModels } = require('../chatlib.js');

// The keyless providers are the floor under this app, and every property they
// promise is a property of the *absence* of configuration -- so each test here
// has to prove that nothing was set, not that something was.

const KEYLESS = ['kilocode', 'ovhcloud'];
const TOUCHED = [
  'KILO_API_KEY', 'KILO_BASE_URL', 'KILO_MODELS', 'KILO_DISABLED', 'KILO_IMAGE_MODEL',
  'OVHCLOUD_API_KEY', 'OVHCLOUD_BASE_URL', 'OVHCLOUD_MODELS', 'OVHCLOUD_DISABLED', 'OVHCLOUD_IMAGE_MODEL',
  'G4F_API_KEY', 'G4F_BASE_URL', 'G4F_IMAGE_MODEL',
];

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

// The whole point of a keyless provider: it cannot be left unconfigured. A free
// model behind a key is the one that runs out, and a variable that has to be set
// is the one that is missing on a fresh deploy -- so the floor under this app
// must not depend on the operator having done anything at all.
test('a keyless provider is configured with nothing set at all', async () => {
  await withCleanEnv(async () => {
    await routes(async ({ base }) => {
      const providers = await get(base, '/api/llm/providers');
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      for (const id of KEYLESS) {
        assert.ok(byId[id], `${id} must be offered with no environment variable set`);
        assert.equal(byId[id].configured, true);
        assert.equal(byId[id].kind, 'chat');
      }
      // And the keyless flag is what makes that true, not a stray variable.
      for (const id of KEYLESS) assert.equal(LLM_PROVIDERS[id].keyless, true);
    });
  });
});

// An always-on service on a shared address is a liability as well as a gift: its
// rate limit is measured against this host's egress IP, so every visitor spends
// the same allowance. A provider that cannot be turned off would leave the
// operator with no answer to that.
test('a keyless provider can be switched off, because there was no variable to remove', async () => {
  await withCleanEnv(async () => {
    process.env.OVHCLOUD_DISABLED = '1';
    await routes(async ({ base }) => {
      const providers = await get(base, '/api/llm/providers');
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      assert.equal(byId.ovhcloud.configured, false, 'OVHCLOUD_DISABLED=1 switches it off');
      assert.equal(byId.kilocode.configured, true, 'and switches off nothing else');
    });
  });
});

// Kilo's catalogue really does publish image ids, and every one of them is
// isFree=false on an account that can only spend the free pool. Enrolling it as
// a drawer would have added a service whose every answer is 402 -- and one the
// operator never asked for.
test('a keyless provider is not enrolled as a drawing service by default', async () => {
  await withCleanEnv(async () => {
    assert.equal(LLM_PROVIDERS.kilocode.image, undefined, 'Kilo declares no image block');
    assert.equal(LLM_PROVIDERS.ovhcloud.image, undefined, 'and neither does OVHcloud, deliberately');
    await routes(async ({ base }) => {
      const listed = await get(base, '/api/llm/images/providers');
      const ready = listed.providers.filter((p) => p.ready).map((p) => p.id);
      for (const id of KEYLESS) {
        assert.equal(ready.includes(id), false, `${id} must not draw until a model is named`);
      }
    });
  });
});

// OVHcloud does draw, though, with no key at all -- verified live: a POST to its
// images endpoint with stable-diffusion-xl-base-v10 and no Authorization header
// answers 200 with a real PNG. Naming the model is the entire opt-in, and it has
// to be enough on its own, with no image block declared anywhere.
test('naming a model is the whole opt-in, and it makes a keyless provider draw', async () => {
  await withCleanEnv(async () => {
    process.env.OVHCLOUD_IMAGE_MODEL = 'stable-diffusion-xl-base-v10';
    await routes(async ({ base }) => {
      const listed = await get(base, '/api/llm/images/providers');
      const ovh = listed.providers.find((p) => p.id === 'ovhcloud');
      assert.ok(ovh, 'a provider that can now draw is listed');
      assert.equal(ovh.ready, true);
      assert.equal(ovh.model, 'stable-diffusion-xl-base-v10');
      // The shape the route reads the request through is the derived store, not
      // a declared image block -- which is what makes the opt-in one variable
      // rather than a line of code as well.
      assert.equal(LLM_PROVIDERS.ovhcloud.image, undefined);
      // And the opt-in is per provider: Kilo is not merely not-ready, it is not
      // in the list at all, because nothing named a model for it.
      assert.equal(listed.providers.some((p) => p.id === 'kilocode'), false);
    });
  });
});

// gpt4free is the one place a free picture can come from when nothing else
// answers, and it is the flakiest thing in the file: an aggregator that reads
// third-party sites rather than a documented API. So its position is the
// promise -- last, behind every service that was configured on purpose.
test('gpt4free sits last in the draw order, behind every named service', async () => {
  await withCleanEnv(async () => {
    await routes(async ({ base }) => {
      const listed = await get(base, '/api/llm/images/providers');
      const ids = listed.providers.map((p) => p.id);
      assert.equal(ids[ids.length - 1], 'g4f', 'g4f is the last service tried, not a middle one');
      for (const id of ['cloudflare', 'nara', 'openrouter', 'nvidia', 'omniroute']) {
        assert.ok(ids.indexOf(id) < ids.indexOf('g4f'), `${id} must be tried before g4f`);
      }
      assert.equal(ids.includes('kilocode'), false, 'a keyless chat provider is not in this list at all');
    });
  });
});

test('the gpt4free base URL is completed to /v1 rather than left to the operator to remember', () => {
  assert.equal(normalizeProviderBaseUrl('g4f', 'http://g4f.railway.internal:8080'), 'http://g4f.railway.internal:8080/v1');
  assert.equal(normalizeProviderBaseUrl('g4f', 'http://g4f.railway.internal:8080/'), 'http://g4f.railway.internal:8080/v1');
  assert.equal(normalizeProviderBaseUrl('g4f', 'http://g4f.railway.internal:8080/v1'), 'http://g4f.railway.internal:8080/v1');
  // And a provider with a documented path of its own is left alone.
  assert.equal(normalizeProviderBaseUrl('nara', 'https://router.bynara.id/v1'), 'https://router.bynara.id/v1');
});

// The same rule the picker renders by. An id pinned here that the chat filter
// drops would be pinned and never shown, which is worse than not pinning it.
test('every pinned Kilo id is one the picker would actually show', () => {
  const ids = LLM_PROVIDERS.kilocode.models;
  assert.ok(Array.isArray(ids) && ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids in the list');
  // Kilo's own free router carries no `:free` suffix, which is exactly why this
  // provider is pinned as a plain list rather than gated by a freeOnly rule --
  // that rule matches the suffix and would have dropped the one id that rotates
  // the whole free pool.
  assert.ok(ids.includes('kilo-auto/free'), 'the free router is the point of this provider');
  const shown = new Set(usableChatModels(ids.map((id) => ({ id }))).map((m) => m.id));
  for (const id of ids) assert.ok(shown.has(id), `${id} would be filtered out of the picker`);
});

test('the keyless providers are registered with the shape the server relies on', () => {
  assert.equal(LLM_PROVIDERS.kilocode.baseUrl, 'https://api.kilo.ai/api/gateway/v1');
  assert.equal(LLM_PROVIDERS.ovhcloud.baseUrl, 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1');
  for (const id of KEYLESS) {
    // A key is optional, never required, and an unset one must mean no auth
    // header at all rather than a bare "Bearer ".
    assert.equal(LLM_PROVIDERS[id].needsKey, false);
  }
});
