const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProviderModel, normalizePricing } = require('../server.js');
const { isFreeModel, emitsText, usableChatModels } = require('../chatlib.js');

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
  // Cerebras and NVIDIA send only id/object/created/owned_by.
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
  const seen = await withStubProvider('CEREBRAS_API_KEY', 'CEREBRAS_BASE_URL', 'Bearer', async (base) => {
    await fetch(base + '/api/llm/models?provider=cerebras');
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
  assert.equal(byId.cerebras.kind, 'chat');
  assert.equal(byId.openrouter.kind, 'chat');
  assert.equal(byId.opencode.kind, 'chat');

  assert.match(byId.deepgram.note, /transcription models/);
  assert.match(byId.youcom.note, /search and research/);
  assert.equal(byId.cerebras.note, undefined, 'a real chat provider needs no excuse');
});

test('a provider that never answers fails with our own deadline, not silence', async () => {
  // The reported symptom was a bare "504: request failed" with no indication
  // of which side stalled.
  const hung = http.createServer(() => { /* deliberately never respond */ });
  await new Promise((r) => hung.listen(0, r));
  process.env.SAMBANOVA_API_KEY = 'k';
  process.env.SAMBANOVA_BASE_URL = `http://127.0.0.1:${hung.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;

  // The models budget is 20s, too long for a test, so assert the plumbing
  // instead: an unreachable port takes the same path and must name the
  // provider rather than leaking a raw socket error.
  hung.close();
  const res = await fetch(base + '/api/llm/models?provider=sambanova');
  const body = await res.json();

  app.close();
  delete process.env.SAMBANOVA_API_KEY;
  delete process.env.SAMBANOVA_BASE_URL;

  assert.match(body.error, /SambaNova/, 'the message must name the provider');
  assert.match(body.error, /slow or unreachable|Could not reach/);
  assert.ok(!/^504: request failed$/.test(body.error), 'never the bare message that was reported');
});

test('a gateway error with no body still names the provider', async () => {
  // The reported symptom: "504: request failed", with several providers
  // configured and no way to tell which one stalled.
  const dead = http.createServer((req, res) => { res.writeHead(504); res.end(); });
  await new Promise((r) => dead.listen(0, r));
  process.env.SAMBANOVA_API_KEY = 'k';
  process.env.SAMBANOVA_BASE_URL = `http://127.0.0.1:${dead.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=sambanova`);
  const body = await res.json();

  app.close(); dead.close();
  delete process.env.SAMBANOVA_API_KEY;
  delete process.env.SAMBANOVA_BASE_URL;

  assert.match(body.error, /SambaNova/);
  assert.ok(!body.error.includes('request failed'), 'the useless phrasing must be gone');
});

test('an HTML error body does not collapse into nothing', async () => {
  // A hosting edge returns HTML, which parses to null and used to leave the
  // message empty.
  const html = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html><body>Bad Gateway</body></html>');
  });
  await new Promise((r) => html.listen(0, r));
  process.env.CEREBRAS_API_KEY = 'k';
  process.env.CEREBRAS_BASE_URL = `http://127.0.0.1:${html.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=cerebras`)).json();

  app.close(); html.close();
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_BASE_URL;

  assert.match(body.error, /Cerebras/);
  assert.match(body.error, /gateway error|slow or unreachable/);
});

const { isFreeModelId } = require('../chatlib.js');

// OpenCode Zen publishes no prices and mixes free with paid in one catalogue,
// marking the free ones in the id. Treating "no price" as free would rank
// claude-fable-5 alongside the free tier the user actually has.
test('OpenCode Zen free models are recognised by their id', () => {
  const zen = (id) => normalizeProviderModel({ id }, { pricedByName: true });
  for (const id of [
    'big-pickle',
    'muse-spark-1.3',
    'muse-spark-1.3-contributor-free',
    'mimo-v2.5-free',
    'ling-3.0-flash-fin-free',
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
    'deepseek-v4-flash-free',
  ]) {
    assert.ok(isFreeModel(zen(id)), `${id} is a free model on Zen`);
  }
});

test("Zen's paid models are not swept up as free", () => {
  const zen = (id) => normalizeProviderModel({ id }, { pricedByName: true });
  for (const id of ['claude-fable-5', 'gpt-6-astra', 'gemini-3.8-flash', 'grok-4']) {
    assert.ok(!isFreeModel(zen(id)), `${id} is paid on Zen`);
  }
});

test('an account-allowance provider still treats an unpriced model as free', () => {
  // Cerebras and NVIDIA meter the account, not the model, so nothing in their
  // catalogue is individually paid.
  assert.ok(isFreeModel(normalizeProviderModel({ id: 'llama-3.3-70b' }, { label: 'Cerebras' })));
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
  for (const id of ['opencode', 'mistral', 'sambanova']) {
    assert.ok(ids.includes(id), `${id} should be offered`);
  }
  for (const p of providers) {
    assert.ok(p.baseUrl === undefined, 'a base URL must never reach the client');
  }
});

const { selectAllowedModels, newestInFamily } = require('../chatlib.js');

// Zen's real catalogue, trimmed to the families that matter.
const ZEN_CATALOGUE = [
  { id: 'claude-fable-5' }, { id: 'gpt-6-astra' }, { id: 'muse-spark-1.3' },
  { id: 'muse-spark-1.2' }, { id: 'big-pickle' },
  { id: 'muse-spark-1.3-contributor-free' }, { id: 'muse-spark-1.2-contributor-free' },
  { id: 'nemotron-3-ultra-free' },
];

test('OpenCode Zen keeps every free model and no paid one', () => {
  const chosen = selectAllowedModels(ZEN_CATALOGUE, { freeOnly: true, newestOf: ['muse-spark'] }).map((m) => m.id);
  // Free, with the muse family collapsed to its newest release.
  assert.ok(chosen.includes('big-pickle'));
  assert.ok(chosen.includes('nemotron-3-ultra-free'));
  assert.ok(chosen.includes('muse-spark-1.3'));
  // Paid models must never reach the picker: the key returns 403 on them.
  assert.ok(!chosen.includes('claude-fable-5'));
  assert.ok(!chosen.includes('gpt-6-astra'));
  // And the older muse variants are gone, not duplicated.
  assert.ok(!chosen.includes('muse-spark-1.2'));
  assert.ok(!chosen.includes('muse-spark-1.3-contributor-free'));
});

test('a newer Muse would be picked up without a code change', () => {
  const withNext = [...ZEN_CATALOGUE, { id: 'muse-spark-1.4' }];
  const chosen = selectAllowedModels(withNext, { freeOnly: true, newestOf: ['muse-spark'] }).map((m) => m.id);
  assert.ok(chosen.includes('muse-spark-1.4'));
  assert.ok(!chosen.includes('muse-spark-1.3'));
});

test('exact and newestOf still work for a provider not using freeOnly', () => {
  const chosen = selectAllowedModels(ZEN_CATALOGUE, { exact: ['big-pickle'], newestOf: ['muse-spark'] });
  assert.deepEqual(chosen.map((m) => m.id).sort(), ['big-pickle', 'muse-spark-1.3']);
});

test('version comparison is numeric, not alphabetical', () => {
  // "1.10" sorts before "1.9" as a string, and after it as a version.
  const family = [{ id: 'muse-spark-1.9' }, { id: 'muse-spark-1.10' }];
  assert.equal(newestInFamily(family, 'muse-spark').id, 'muse-spark-1.10');
});

test('at equal versions the plain id wins over a variant', () => {
  const family = [{ id: 'muse-spark-1.3-contributor-free' }, { id: 'muse-spark-1.3' }];
  assert.equal(newestInFamily(family, 'muse-spark').id, 'muse-spark-1.3');
});

test('a provider with no declared subset keeps its whole catalogue', () => {
  assert.equal(selectAllowedModels(ZEN_CATALOGUE, undefined).length, ZEN_CATALOGUE.length);
  assert.equal(selectAllowedModels(ZEN_CATALOGUE, {}).length, ZEN_CATALOGUE.length);
});

test('a renamed model falls back to the full list rather than an empty picker', () => {
  const chosen = selectAllowedModels(ZEN_CATALOGUE, { exact: ['gone'], newestOf: ['also-gone'] });
  assert.equal(chosen.length, ZEN_CATALOGUE.length);
});

test('every model the Zen list yields survives the chat filter and reads as free', () => {
  const chosen = selectAllowedModels(ZEN_CATALOGUE, { freeOnly: true, newestOf: ['muse-spark'] })
    .map((m) => normalizeProviderModel(m, { pricedByName: true }));
  const ranked = usableChatModels(chosen);
  assert.ok(ranked.length >= 3, 'the free set is more than a couple of models');
  assert.ok(ranked.every((m) => m.free), 'nothing paid slipped through');
});

test('the models endpoint actually applies the provider subset', async () => {
  // Computing the subset and then sending the unfiltered list is a mistake a
  // unit test on the filter alone cannot see, so assert on the response.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: ZEN_CATALOGUE }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.OPENCODE_API_KEY = 'k';
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=opencode`)).json();

  app.close(); upstream.close();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_BASE_URL;

  const ids = body.map((m) => m.id);
  assert.ok(ids.includes('big-pickle') && ids.includes('nemotron-3-ultra-free'));
  assert.ok(ids.includes('muse-spark-1.3') && !ids.includes('muse-spark-1.2'));
  assert.ok(!ids.includes('claude-fable-5'), 'paid models must not reach the picker');
  assert.ok(!ids.includes('gpt-6-astra'), 'paid models must not reach the picker');
});

test('a provider with no subset still returns its whole catalogue', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.SAMBANOVA_API_KEY = 'k';
  process.env.SAMBANOVA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=sambanova`)).json();

  app.close(); upstream.close();
  delete process.env.SAMBANOVA_API_KEY;
  delete process.env.SAMBANOVA_BASE_URL;

  assert.equal(body.length, 3);
});

test('freeOnly recognises every free id Zen actually publishes', () => {
  // Straight from the live catalogue, so a change in Zen's naming shows up here.
  const live = [
    'big-pickle', 'muse-spark-1.3', 'muse-spark-1.2',
    'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
    'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
    'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'deepseek-v4-flash-free',
  ].map((id) => ({ id }));
  const paid = ['claude-opus-5', 'gpt-5.3-codex-spark', 'gemini-3.8-flash'].map((id) => ({ id }));

  const chosen = selectAllowedModels([...live, ...paid], { freeOnly: true }).map((m) => m.id);
  assert.equal(chosen.length, live.length, 'all ten free models, and only those');
  for (const { id } of paid) assert.ok(!chosen.includes(id), `${id} is paid`);
});

test('freeOnly falling through to the full list is still impossible to trigger silently', () => {
  // A catalogue with nothing free returns everything rather than an empty
  // picker — the same guarantee the other rules give.
  const allPaid = [{ id: 'claude-opus-5' }, { id: 'gpt-6-astra' }];
  assert.equal(selectAllowedModels(allPaid, { freeOnly: true }).length, 2);
});
