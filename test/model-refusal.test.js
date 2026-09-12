const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  isModelScopedRefusal,
  nextUsableModel,
  usableChatModels,
} = require('../chatlib.js');
const { createRequestHandler, LLM_PROVIDERS, clearModelCache } = require('../server.js');

// The real refusal, verbatim, that prompted this: OpenRouter serves only the
// free ids it has approved our app class for, and says so by name.
const APP_GATED_403 =
  '403: thinkingmachines/inkling:free is only available on agentic harnesses. ' +
  'Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps';

test('a 403 that names the model is treated as model-scoped, so it can be routed around', () => {
  assert.ok(isModelScopedRefusal(403, APP_GATED_403, 'thinkingmachines/inkling:free'));
});

test('a 404 for an id the account cannot reach is model-scoped', () => {
  // NVIDIA lists models an account has no access to and answers 404 for them.
  assert.ok(isModelScopedRefusal(404, '404: Not found for account', 'meta/llama-3.3-70b'));
});

test('an account-level refusal is never retried per model', () => {
  // Otherwise each candidate burns a request and fails identically, which is
  // the failure mode isAccountLevelFailure exists to prevent.
  assert.equal(
    isModelScopedRefusal(402, '402: A payment method is required. Add one on the billing page.', 'gemma-4-31b'),
    false,
  );
});

test('transient and provider-wide failures are not model-scoped', () => {
  // Retrying a 429 against another model, or hiding a 5xx behind a crawl
  // through the list, both turn a clear failure into a slow one.
  assert.equal(isModelScopedRefusal(429, '429: rate limited', 'x'), false);
  assert.equal(isModelScopedRefusal(500, '500: internal error', 'x'), false);
  assert.equal(isModelScopedRefusal(502, '502: bad gateway', 'x'), false);
  assert.equal(isModelScopedRefusal(400, '400: bad request', 'x'), false);
});

test('nextUsableModel returns the head, then the next one down', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextUsableModel(models, new Set()), 'a');
  assert.equal(nextUsableModel(models, new Set(['a'])), 'b');
  assert.equal(nextUsableModel(models, new Set(['a', 'b'])), 'c');
});

test('nextUsableModel returns null when everything is refused', () => {
  // null is the caller's signal to stop retrying rather than loop.
  assert.equal(nextUsableModel([{ id: 'a' }], new Set(['a'])), null);
  assert.equal(nextUsableModel([], new Set()), null);
});

test('nextUsableModel survives junk instead of throwing mid-turn', () => {
  assert.equal(nextUsableModel(null, new Set()), null);
  assert.equal(nextUsableModel(undefined, undefined), null);
  assert.equal(nextUsableModel([null, {}, { id: 'a' }], new Set()), 'a');
  // An array works as well as a Set, so callers need not care which they hold.
  assert.equal(nextUsableModel([{ id: 'a' }, { id: 'b' }], ['a']), 'b');
});

// The build that produced the confusing "Error (openrouter/nvidia/nemotron…)"
// message offered thinkingmachines/inkling:free, which OpenRouter refuses for
// this app class. Offering it can only ever produce a failed request.
test('the OpenRouter allowlist does not pin the app-gated model', () => {
  const ids = LLM_PROVIDERS.openrouter.models;
  assert.equal(ids.includes('thinkingmachines/inkling:free'), false);
  // Kept deliberately: the gate has only been observed on the larger model,
  // and dropping a working id on the strength of its name costs a usable model.
  assert.ok(ids.includes('thinkingmachines/inkling-small:free'));
});

// The catalogue itself is no help here: inkling:free is listed, priced at zero,
// with no field marking it as gated. So the allowlist is the only place this can
// be prevented, and this test drives the real endpoint to prove it is.
const CATALOGUE = {
  object: 'list',
  data: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'thinkingmachines/inkling:free',
    'nvidia/nemotron-3.5-lightning:free',
    'thinkingmachines/inkling-small:free',
    'cohere/north-mini-code:free',
  ].map((id) => ({
    id,
    pricing: { prompt: '0', completion: '0' },
    context_length: 1000000,
    supported_parameters: ['tools'],
    architecture: { output_modalities: ['text'] },
  })),
};

async function withOpenRouterCatalogue(run) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CATALOGUE));
  });
  await new Promise((r) => upstream.listen(0, r));
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  clearModelCache();
  try {
    await run(`http://127.0.0.1:${app.address().port}`);
  } finally {
    app.close();
    upstream.close();
    clearModelCache();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = savedBase;
  }
}

test('the served OpenRouter picker omits the gated model but keeps its siblings', async () => {
  await withOpenRouterCatalogue(async (base) => {
    const res = await fetch(base + '/api/llm/models?provider=openrouter');
    assert.equal(res.status, 200);
    const served = await res.json();
    const ids = served.map((m) => m.id);
    assert.equal(ids.includes('thinkingmachines/inkling:free'), false, 'the model that answers 403 must not be offered');
    assert.ok(ids.includes('thinkingmachines/inkling-small:free'), 'the sibling stays offered');
    assert.ok(ids.includes('cohere/north-mini-code:free'), 'the rest of the allowlist is untouched');
    // The picker's head is what a refusal-driven auto-switch lands on -- and
    // what the old error message wrongly printed as the model that failed.
    assert.equal(usableChatModels(served)[0].id, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  });
});
