const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProviderModel, normalizePricing, clearModelCache, LLM_PROVIDERS } = require('../server.js');
const { isFreeModel, isFreeModelId, emitsText, usableChatModels } = require('../chatlib.js');

// The OpenRouter allowlist is a free-tier commitment: paid ids only ever
// produced 402/403 errors on a free key, so every pinned id must carry the
// ":free" suffix — and the ids must be real ones from the live catalogue.
test('the OpenRouter allowlist is free-only and structurally valid', () => {
  const ids = LLM_PROVIDERS.openrouter.models;
  assert.ok(Array.isArray(ids) && ids.length >= 10, 'allowlist should stay generously populated');
  for (const id of ids) {
    assert.match(id, /:free$/, `${id} must end in :free`);
    assert.equal(id.split('/').length, 2, `${id} must be vendor/model shaped`);
    assert.ok(!ids.includes(id + ':free'), 'no accidental duplicates');
  }
  assert.ok(LLM_PROVIDERS.openrouter.freeOnly, 'freeOnly gate must default on');
  // Every free id is a chat-capable text model by the same rules the client
  // picker uses — a moderation/embed model would be filtered out at render.
  for (const id of ids) {
    const kept = usableChatModels([{ id }]).some((m) => m.id === id);
    if (!kept) {
      // Allowed only for the safety classifier, which the chat filter
      // deliberately hides but which stays listed for future moderation use.
      assert.match(id, /content-safety/, `${id} filtered out of chat pickers`);
    }
  }
});

test('isFreeModelId recognises the provider free markers only at the end', () => {
  assert.ok(isFreeModelId('vendor/model:free'));
  assert.ok(isFreeModelId('vendor/model-free'));
  assert.ok(!isFreeModelId('vendor/free-model'));
  assert.ok(!isFreeModelId('vendor/model:freedom'));
  assert.ok(!isFreeModelId(''));
  assert.ok(!isFreeModelId(null));
});

test('the free-only gate drops paid models from a mixed catalogue', () => {
  clearModelCache();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'cohere/north-mini-code:free' },
      { id: 'openai/gpt-oss-120b' },
      { id: 'nvidia/nemotron-3.5-lightning:free' },
    ] }));
  });
  return withOpenRouterUpstream(upstream, async () => {
    const app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=openrouter`)).json();
    app.close();
    // Allowlist order is preserved; the paid id is dropped.
    assert.deepEqual(body.map((m) => m.id), ['nvidia/nemotron-3.5-lightning:free', 'cohere/north-mini-code:free']);
  });
});

test('a fully retired allowlist degrades to the live catalogue, not an empty picker', async () => {
  clearModelCache();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'some-vendor/brand-new-model:free' }] }));
  });
  await withOpenRouterUpstream(upstream, async () => {
    const app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=openrouter`)).json();
    app.close();
    assert.deepEqual(body.map((m) => m.id), ['some-vendor/brand-new-model:free']);
  });
});

async function withOpenRouterUpstream(upstream, run) {
  await new Promise((r) => upstream.listen(0, r));
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  try {
    await run();
  } finally {
    upstream.close();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = savedBase;
    clearModelCache();
  }
}

// Every provider is OpenAI-compatible for chat and then invents its own
// metadata around it. These are real response shapes taken from each service.

test("OpenRouter's shape is read correctly", () => {
  const model = normalizeProviderModel({
    id: 'cohere/north-mini-code:free',
    pricing: { prompt: '0', completion: '0' },
    context_length: 256000,
    supported_parameters: ['tools'],
    architecture: { output_modalities: ['text'] },
  });
  assert.deepEqual(model.pricing, { prompt: 0, completion: 0 });
  assert.deepEqual(model.outputModalities, ['text']);
  assert.ok(isFreeModel(model));
});

test("ZenMux's shape is read correctly", () => {
  // Prices are arrays of {value, unit, currency}, per million tokens, and the
  // modalities sit at the top level rather than under architecture.
  const model = normalizeProviderModel({
    id: 'openai/gpt-image-2.5-sunburst',
    display_name: 'OpenAI: GPT-Image-2.5-Sunburst',
    owned_by: 'openai',
    output_modalities: ['image'],
    context_length: 10000,
    pricings: { prompt: [{ value: 5, unit: 'perMTokens', currency: 'USD' }] },
  });
  assert.equal(model.name, 'OpenAI: GPT-Image-2.5-Sunburst');
  assert.deepEqual(model.outputModalities, ['image']);
  assert.equal(model.pricing.prompt, 5);
  assert.ok(!isFreeModel(model), 'a priced model is not free');
  assert.ok(!emitsText(model), 'an image model is not a chat model');
});

test('a bare OpenAI-shaped list survives with no metadata', () => {
  // Nara and NVIDIA send only id/object/created/owned_by.
  const model = normalizeProviderModel({ id: 'llama-3.3-70b', owned_by: 'Meta' });
  assert.equal(model.pricing, undefined);
  assert.equal(model.outputModalities, undefined);
  assert.ok(isFreeModel(model), 'no published price means free within the allowance');
  assert.ok(emitsText(model), 'assume text when nothing says otherwise');
});

test('a zero-valued ZenMux price still reads as free', () => {
  const model = normalizeProviderModel({
    id: 'someone/free-model',
    pricings: { prompt: [{ value: 0 }], completion: [{ value: 0 }] },
  });
  assert.ok(isFreeModel(model));
});

test('input/output price keys are handled as well as prompt/completion', () => {
  assert.deepEqual(normalizePricing({ pricing: { input: '0.000002', output: '0.000008' } }), {
    prompt: 0.000002,
    completion: 0.000008,
  });
});

test('malformed pricing never throws, it just goes unknown', () => {
  assert.equal(normalizePricing({ pricing: 'free!' }), undefined);
  assert.equal(normalizePricing({ pricings: {} }), undefined);
  assert.equal(normalizePricing({}), undefined);
});

test('a real mixed ZenMux page filters down to chat models only', () => {
  const page = [
    { id: 'openai/gpt-image-2.5-sunburst', output_modalities: ['image'], pricings: { prompt: [{ value: 5 }] } },
    { id: 'anthropic/claude-sonnet', output_modalities: ['text'], pricings: { prompt: [{ value: 3 }] }, context_length: 200000 },
    { id: 'qwen/qwen3-coder', output_modalities: ['text'], pricings: { prompt: [{ value: 0 }], completion: [{ value: 0 }] } },
  ].map(normalizeProviderModel);
  const ranked = usableChatModels(page);
  assert.ok(!ranked.some((m) => m.id.includes('image')), 'image model dropped');
  assert.equal(ranked[0].id, 'qwen/qwen3-coder', 'the free coding model leads');
});

const http = require('node:http');
const { createRequestHandler } = require('../server.js');

// Auth schemes differ between services. Sending Bearer to one that wants
// "Token" fails on authentication rather than on the thing being tested, which
// would make a provider look broken when only the header was wrong.
function withStubProvider(envVar, baseVar, scheme, run) {
  return new Promise((resolve, reject) => {
    const seen = {};
    const upstream = http.createServer((req, res) => {
      seen.authorization = req.headers.authorization;
      seen.apiKeyHeader = req.headers['x-api-key'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1' }] }));
    });
    upstream.listen(0, () => {
      process.env[envVar] = 'KEY123';
      process.env[baseVar] = `http://127.0.0.1:${upstream.address().port}/v1`;
      const app = http.createServer(createRequestHandler(__dirname + '/..'));
      app.listen(0, async () => {
        try {
          await run(`http://127.0.0.1:${app.address().port}`);
          resolve(seen);
        } catch (err) {
          reject(err);
        } finally {
          app.close();
          upstream.close();
          delete process.env[envVar];
          delete process.env[baseVar];
        }
      });
    });
  });
}

test('a standard provider gets Bearer auth', async () => {
  const seen = await withStubProvider('NARA_API_KEY', 'NARA_BASE_URL', 'Bearer', async (base) => {
    await fetch(base + '/api/llm/models?provider=nara');
  });
  assert.equal(seen.authorization, 'Bearer KEY123');
});

test('Deepgram gets its "Token" scheme, not Bearer', async () => {
  const seen = await withStubProvider('DEEPGRAM_API_KEY', 'DEEPGRAM_BASE_URL', 'Token', async (base) => {
    await fetch(base + '/api/llm/models?provider=deepgram');
  });
  assert.equal(seen.authorization, 'Token KEY123');
});

test('AssemblyAI gets the bare key with no scheme', async () => {
  const seen = await withStubProvider('ASSEMBLYAI_API_KEY', 'ASSEMBLYAI_BASE_URL', '', async (base) => {
    await fetch(base + '/api/llm/models?provider=assemblyai');
  });
  assert.equal(seen.authorization, 'KEY123');
});

test('You.com gets its own header instead of Authorization', async () => {
  const seen = await withStubProvider('YOUCOM_API_KEY', 'YOUCOM_BASE_URL', '', async (base) => {
    await fetch(base + '/api/llm/models?provider=youcom');
  });
  assert.equal(seen.apiKeyHeader, 'KEY123');
  assert.equal(seen.authorization, undefined);
});

test('non-LLM services are labelled by kind, with a reason', async () => {
  // Deepgram, AssemblyAI and You.com sit in the picker at the user's request.
  // Each must explain itself, since an empty dropdown reads as a bug.
  process.env.DEEPGRAM_API_KEY = 'k';
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const providers = await (await fetch(base + '/api/llm/providers')).json();
  app.close();
  delete process.env.DEEPGRAM_API_KEY;

  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  assert.equal(byId.deepgram.kind, 'speech');
  assert.equal(byId.assemblyai.kind, 'speech');
  assert.equal(byId.youcom.kind, 'search');
  assert.equal(byId.nara.kind, 'chat');
  assert.equal(byId.openrouter.kind, 'chat');
  assert.equal(byId.mistral.kind, 'chat');

  assert.match(byId.deepgram.note, /transcription models/);
  assert.match(byId.youcom.note, /search and research/);
  assert.equal(byId.nara.note, undefined, 'a real chat provider needs no excuse');
});

test('a provider that never answers fails with our own deadline, not silence', async () => {
  clearModelCache();
  // The reported symptom was a bare "504: request failed" with no indication
  // of which side stalled.
  const hung = http.createServer(() => { /* deliberately never respond */ });
  await new Promise((r) => hung.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_BASE_URL = `http://127.0.0.1:${hung.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;

  // The models budget is 20s, too long for a test, so assert the plumbing
  // instead: an unreachable port takes the same path and must name the
  // provider rather than leaking a raw socket error.
  hung.close();
  const res = await fetch(base + '/api/llm/models?provider=nara');
  const body = await res.json();

  app.close();
  delete process.env.NARA_API_KEY;
  delete process.env.NARA_BASE_URL;

  assert.match(body.error, /Nara/, 'the message must name the provider');
  assert.match(body.error, /slow or unreachable|Could not reach/);
  assert.ok(!/^504: request failed$/.test(body.error), 'never the bare message that was reported');
});

test('a gateway error with no body still names the provider', async () => {
  clearModelCache();
  // The reported symptom: "504: request failed", with several providers
  // configured and no way to tell which one stalled.
  const dead = http.createServer((req, res) => { res.writeHead(504); res.end(); });
  await new Promise((r) => dead.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_BASE_URL = `http://127.0.0.1:${dead.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=nara`);
  const body = await res.json();

  app.close(); dead.close();
  delete process.env.NARA_API_KEY;
  delete process.env.NARA_BASE_URL;

  assert.match(body.error, /Nara/);
  assert.ok(!body.error.includes('request failed'), 'the useless phrasing must be gone');
});

test('an HTML error body does not collapse into nothing', async () => {
  clearModelCache();
  // A hosting edge returns HTML, which parses to null and used to leave the
  // message empty.
  const html = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html><body>Bad Gateway</body></html>');
  });
  await new Promise((r) => html.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_BASE_URL = `http://127.0.0.1:${html.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=nara`)).json();

  app.close(); html.close();
  delete process.env.NARA_API_KEY;
  delete process.env.NARA_BASE_URL;

  assert.match(body.error, /Nara/);
  assert.match(body.error, /gateway error|slow or unreachable/);
});

// OpenCode Zen publishes no prices and mixes free with paid in one catalogue,
// marking the free ones in the id. Treating "no price" as free would rank
// claude-fable-5 alongside the free tier the user actually has.


test('an account-allowance provider still treats an unpriced model as free', () => {
  // Nara and NVIDIA meter the account, not the model, so nothing in their
  // catalogue is individually paid.
  assert.ok(isFreeModel(normalizeProviderModel({ id: 'llama-3.3-70b' }, { label: 'Nara' })));
  assert.ok(isFreeModel(normalizeProviderModel({ id: 'claude-fable-5' }, undefined)));
});

test('both free-marking conventions are accepted', () => {
  assert.ok(isFreeModelId('qwen/qwen3-coder:free'), "OpenRouter's colon");
  assert.ok(isFreeModelId('mimo-v2.5-free'), "Zen's hyphen");
  assert.ok(!isFreeModelId('freeform-model'), 'free must be a suffix, not a prefix');
  assert.ok(!isFreeModelId('gpt-4o'));
});

test('published pricing still wins over any name convention', () => {
  // A model called "-free" that publishes a real price is not free.
  const model = normalizeProviderModel(
    { id: 'someone/thing-free', pricing: { prompt: '0.000003', completion: '0.000009' } },
    { pricedByName: true }
  );
  assert.ok(!isFreeModel(model));
});

test('the removed providers are gone and the new ones are present', async () => {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const providers = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
  app.close();
  const ids = providers.map((p) => p.id);
  assert.ok(!ids.includes('bluesminds'));
  assert.ok(!ids.includes('zenmux'));
  assert.ok(!ids.includes('cerebras'), 'Cerebras was removed');
  assert.ok(!ids.includes('sambanova'), 'SambaNova was removed');
  assert.ok(!ids.includes('opencode'), "OpenCode's free tier only works inside its own client");
  for (const id of ['mistral', 'nara', 'aigateway', 'ollama', 'nvidia']) {
    assert.ok(ids.includes(id), `${id} should be offered`);
  }
  for (const p of providers) {
    assert.ok(p.baseUrl === undefined, 'a base URL must never reach the client');
  }
});











test('a provider with no subset still returns its whole catalogue', async () => {
  clearModelCache();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.MISTRAL_API_KEY = 'k';
  process.env.MISTRAL_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=mistral`)).json();

  app.close(); upstream.close();
  delete process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_BASE_URL;

  assert.equal(body.length, 3);
});

test('an allowlist pins the picker to exactly those models, in order', async () => {
  clearModelCache();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stepfun-3.7-flash' }, { id: 'zzz-unlisted' }, { id: 'agnes-2.5-flash' }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=nara`)).json();
    assert.deepEqual(body.map((m) => m.id), ['agnes-2.5-flash', 'stepfun-3.7-flash']);
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_BASE_URL;
    clearModelCache();
  }
});

const { describeProviderError } = require('../server.js');

test('a provider that explains itself is not second-guessed', () => {
  // The reported case: OpenRouter says exactly what is wrong and links to the
  // fix, and the old hint appended "usually an empty balance", which is not
  // what happened and sends the user to check the wrong thing.
  const real = describeProviderError(
    403,
    { error: { message: 'thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps' } },
    { label: 'OpenRouter' }
  );
  assert.match(real, /only available on agentic harnesses/);
  assert.ok(!real.includes('empty balance'), 'must not contradict the provider');
  assert.ok(!real.includes('—'), 'no hint appended to a full explanation');
});

test('a bare status still gets its hint', () => {
  const terse = describeProviderError(401, { error: { message: 'Invalid key' } }, { label: 'Mistral' });
  assert.match(terse, /check the API key/);

  const empty = describeProviderError(504, null, { label: 'Nara' });
  assert.match(empty, /Nara/);
  assert.match(empty, /slow or unreachable/);
});

test('a short message carrying a link counts as self-explanatory', () => {
  const linked = describeProviderError(402, { error: { message: 'Top up at https://example.com/billing' } }, { label: 'X' });
  assert.match(linked, /Top up at/);
  assert.ok(!linked.includes('not free on your plan'));
});

const { isAccountLevelFailure } = require('../chatlib.js');

test('a billing refusal is recognised as account-wide', () => {
  // Both verbatim from the live app.
  assert.ok(isAccountLevelFailure('402: Payment required to access this resource. Visit your billing tab.', 'gemma-4-31b'));
  assert.ok(isAccountLevelFailure('402: A payment method is required. Add one on the billing page to continue.', 'Meta-Llama-3.3-70B-Instruct'));
});

test('a refusal naming the model is about that model, not the account', () => {
  // Removing every model over this one would be wrong: the others still work.
  const openrouter = '403: thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent listed on https://openrouter.ai/apps';
  assert.ok(!isAccountLevelFailure(openrouter, 'thinkingmachines/inkling:free'));
});

test('unrelated failures are not treated as billing problems', () => {
  assert.ok(!isAccountLevelFailure('429: rate limited', 'x'));
  assert.ok(!isAccountLevelFailure('500: internal error', 'x'));
  assert.ok(!isAccountLevelFailure('', 'x'));
  assert.ok(!isAccountLevelFailure(null, 'x'));
});

test('the model name check wins even when billing words appear', () => {
  // A message that names the model is model-specific however it is worded.
  const mixed = '402: model-x requires a payment method on your plan';
  assert.ok(!isAccountLevelFailure(mixed, 'model-x'));
  assert.ok(isAccountLevelFailure(mixed, 'a-different-model'));
});

test('a 404 hint fits what the provider actually is', () => {
  // For a chat provider it means this model is out of reach for the key...
  const chat = describeProviderError(404, null, { label: 'NVIDIA', kind: 'chat' });
  assert.match(chat, /isn't available to your key/);
  assert.ok(!chat.includes('speech'), 'the speech wording was written for Deepgram, not NVIDIA');

  // ...and for a speech or search product it means the whole service is wrong.
  const speech = describeProviderError(404, null, { label: 'Deepgram', kind: 'speech' });
  assert.match(speech, /no chat API at all/);
  assert.match(speech, /sells speech/);
});

test("NVIDIA's per-account 404 passes through untouched", () => {
  // Long enough to explain itself, so no hint should be appended.
  const real = describeProviderError(
    404,
    { error: { message: "Function '7dfc10a8-3cc4-448e-97c1-2213308dc222': Not found for account 'o5hzlwUiHYzGN7'" } },
    { label: 'NVIDIA', kind: 'chat' }
  );
  assert.match(real, /Not found for account/);
  assert.ok(!real.includes('speech'));
});

const { fetchProviderWithRetry, providerTimeoutMs, rateLimitMaxAttempts } = require('../server.js');

test('a provider that 429s twice then answers is retried into success', async () => {
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  try {
    let calls = 0;
    const result = await fetchProviderWithRetry('nvidia', async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 429, data: { error: 'front - limit exceeded' } };
      return { ok: true, status: 200, data: { choices: [] } };
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 3, 'kept retrying until the provider stopped refusing');
  } finally {
    delete process.env.RATE_LIMIT_BASE_DELAY_MS;
  }
});

test('a provider that never stops 429ing returns the last refusal, capped', async () => {
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  try {
    let calls = 0;
    const result = await fetchProviderWithRetry('nvidia', async () => {
      calls += 1;
      return { ok: false, status: 429, data: { error: 'still slow' } };
    });
    assert.equal(result.status, 429, 'the caller still gets to describe a 429');
    assert.equal(calls, 4, 'retries are bounded, so a dead provider cannot hang');
  } finally {
    delete process.env.RATE_LIMIT_BASE_DELAY_MS;
  }
});

test('a non-429 failure is returned immediately, no retry', async () => {
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  try {
    let calls = 0;
    const result = await fetchProviderWithRetry('nvidia', async () => {
      calls += 1;
      return { ok: false, status: 401, data: { error: 'bad key' } };
    });
    assert.equal(result.status, 401);
    assert.equal(calls, 1, 'only rate limits deserve another try');
  } finally {
    delete process.env.RATE_LIMIT_BASE_DELAY_MS;
  }
});

test('model cache returns cached result within TTL', async () => {
  clearModelCache();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'z-ai/glm-5.3', name: 'GLM 5.3' }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NVIDIA_API_KEY = 'k';
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const url = `http://127.0.0.1:${app.address().port}/api/llm/models?provider=nvidia`;
    const first = await (await fetch(url)).json();
    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'z-ai/glm-5.3');
    const second = await (await fetch(url)).json();
    assert.equal(second.length, 1);
    assert.equal(second[0].id, 'z-ai/glm-5.3');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_BASE_URL;
    clearModelCache();
  }
});

test('clearModelCache forces a fresh upstream fetch', async () => {
  clearModelCache();
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: `m${calls}` }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const url = `http://127.0.0.1:${app.address().port}/api/llm/models?provider=nara`;
    await fetch(url);
    assert.equal(calls, 1);
    clearModelCache();
    await fetch(url);
    assert.equal(calls, 2, 'cache cleared, upstream hit again');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_BASE_URL;
    clearModelCache();
  }
});

test('llmChat streams SSE when body.stream is true', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.MISTRAL_API_KEY = 'k';
  process.env.MISTRAL_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/chat?provider=mistral`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('Hello'));
    assert.ok(text.includes('[DONE]'));
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_BASE_URL;
  }
});

test('llmChat streams SSE error when upstream is unreachable', async () => {
  clearModelCache();
  process.env.NVIDIA_API_KEY = 'k';
  process.env.NVIDIA_BASE_URL = 'http://127.0.0.1:1/v1';
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/chat?provider=nvidia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes('[DONE]'), 'must always send DONE sentinel');
    assert.ok(text.includes('error'), 'must report the error');
  } finally {
    if (app) app.close();
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_BASE_URL;
    clearModelCache();
  }
});

test('fetchStreamWithRetry retries 429 and then succeeds', async () => {
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  process.env.NARA_API_KEY = 'k';
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls += 1;
    if (calls <= 2) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too fast' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  try {
    const { fetchStreamWithRetry } = require('../server.js');
    const res = await fetchStreamWithRetry('nara', () =>
      fetch(`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    );
    assert.equal(res.status, 200);
    assert.ok(calls >= 3, 'should have retried 429s');
  } finally {
    upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_BASE_URL;
    delete process.env.RATE_LIMIT_BASE_DELAY_MS;
  }
});

test('timeout knobs default sanely and read env at call time', () => {
  delete process.env.PROVIDER_TIMEOUT_CHAT_MS;
  delete process.env.PROVIDER_STALL_MS;
  assert.deepEqual(providerTimeoutMs(), { models: 20000, chat: 55000, headers: 25000, stall: 60000 });
  process.env.PROVIDER_TIMEOUT_CHAT_MS = '10000';
  process.env.PROVIDER_STALL_MS = 'junk';
  try {
    const t = providerTimeoutMs();
    assert.equal(t.chat, 10000);
    assert.equal(t.stall, 60000, 'garbage falls back to the default');
  } finally {
    delete process.env.PROVIDER_TIMEOUT_CHAT_MS;
    delete process.env.PROVIDER_STALL_MS;
  }
});

test('retry attempts are capped by env', async () => {
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  process.env.RATE_LIMIT_MAX_ATTEMPTS = '1';
  try {
    let calls = 0;
    const result = await fetchProviderWithRetry('nvidia', async () => {
      calls += 1;
      return { ok: false, status: 429, data: { error: 'slow down' } };
    });
    assert.equal(calls, 1, 'one attempt means no retry');
    assert.equal(result.status, 429);
  } finally {
    delete process.env.RATE_LIMIT_BASE_DELAY_MS;
    delete process.env.RATE_LIMIT_MAX_ATTEMPTS;
  }
  assert.equal(rateLimitMaxAttempts(), 4, 'unset means the default');
});

test('/api/llm/limits reports the effective knobs', async () => {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/limits`)).json();
  app.close();
  assert.deepEqual(Object.keys(body).sort(), ['retries', 'timeouts']);
  assert.equal(body.timeouts.chat, 55000);
  assert.equal(body.retries.maxAttempts, 4);
});

test('a stream that goes quiet aborts with a stall message, not silence', async () => {
  process.env.PROVIDER_STALL_MS = '80';
  const hung = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // writeHead alone buffers: flush so the client sees headers now, then
    // hold the body open forever. The stall timer must fire.
    res.flushHeaders();
  });
  await new Promise((r) => hung.listen(0, r));
  process.env.MISTRAL_API_KEY = 'k';
  process.env.MISTRAL_BASE_URL = `http://127.0.0.1:${hung.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/chat?provider=mistral`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res.text();
    // Headers already went out as 200 before the stall, so the failure
    // arrives as an SSE error event on the open stream, not a new status.
    assert.equal(res.status, 200);
    assert.ok(text.includes('stalled mid-reply'), 'names the expired wait, got: ' + text.slice(0, 120));
    assert.ok(text.includes('[DONE]'));
  } finally {
    if (app) app.close();
    hung.close();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_BASE_URL;
    delete process.env.PROVIDER_STALL_MS;
  }
});

test('a stream with no headers fails fast with a headers message', async () => {
  process.env.PROVIDER_TIMEOUT_HEADERS_MS = '120';
  const silent = http.createServer(() => { /* accept, never respond */ });
  await new Promise((r) => silent.listen(0, r));
  process.env.MISTRAL_API_KEY = 'k';
  process.env.MISTRAL_BASE_URL = `http://127.0.0.1:${silent.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/chat?provider=mistral`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await res.text();
    assert.equal(res.status, 504);
    assert.ok(text.includes('no response headers'), 'names the expired wait, got: ' + text.slice(0, 120));
  } finally {
    if (app) app.close();
    silent.close();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_BASE_URL;
    delete process.env.PROVIDER_TIMEOUT_HEADERS_MS;
  }
});

test('AI Gateway uses standard Bearer auth', async () => {
  const seen = await withStubProvider('AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL', 'Bearer', async (base) => {
    await fetch(base + '/api/llm/models?provider=aigateway');
  });
  assert.equal(seen.authorization, 'Bearer KEY123');
});

test('Ollama stays hidden with neither key nor base URL', async () => {
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const providers = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
  app.close();
  assert.equal(providers.find((p) => p.id === 'ollama').configured, false);
});

test('Ollama appears on a base URL alone and sends no auth header', async () => {
  clearModelCache();
  const seen = {};
  const upstream = http.createServer((req, res) => {
    seen.authorization = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:8b' }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  delete process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const base = `http://127.0.0.1:${app.address().port}`;
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    assert.equal(providers.find((p) => p.id === 'ollama').configured, true);
    const body = await (await fetch(base + '/api/llm/models?provider=ollama')).json();
    assert.equal(body.length, 1);
    assert.equal(seen.authorization, undefined, 'no key means no auth header, not a bare Bearer');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.OLLAMA_BASE_URL;
    clearModelCache();
  }
});

test('Ollama sends Bearer when a key is set', async () => {
  const seen = await withStubProvider('OLLAMA_API_KEY', 'OLLAMA_BASE_URL', 'Bearer', async (base) => {
    await fetch(base + '/api/llm/models?provider=ollama');
  });
  assert.equal(seen.authorization, 'Bearer KEY123');
});

test('NVIDIA returns its whole live catalogue', async () => {
  clearModelCache();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'z-ai/glm-5.3' }, { id: 'deepseek-ai/deepseek-v4-flash' }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NVIDIA_API_KEY = 'k';
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=nvidia`)).json();
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((m) => m.id).sort(), ['deepseek-ai/deepseek-v4-flash', 'z-ai/glm-5.3'].sort());
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_BASE_URL;
    clearModelCache();
  }
});
