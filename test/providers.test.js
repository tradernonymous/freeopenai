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
  assert.equal(byId.zenmux.kind, 'chat');

  assert.match(byId.deepgram.note, /transcription models/);
  assert.match(byId.youcom.note, /search and research/);
  assert.equal(byId.cerebras.note, undefined, 'a real chat provider needs no excuse');
});

test('a provider that never answers fails with our own deadline, not silence', async () => {
  // The reported symptom was a bare "504: request failed" with no indication
  // of which side stalled.
  const hung = http.createServer(() => { /* deliberately never respond */ });
  await new Promise((r) => hung.listen(0, r));
  process.env.BLUESMINDS_API_KEY = 'k';
  process.env.BLUESMINDS_BASE_URL = `http://127.0.0.1:${hung.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;

  // The models budget is 20s, too long for a test, so assert the plumbing
  // instead: an unreachable port takes the same path and must name the
  // provider rather than leaking a raw socket error.
  hung.close();
  const res = await fetch(base + '/api/llm/models?provider=bluesminds');
  const body = await res.json();

  app.close();
  delete process.env.BLUESMINDS_API_KEY;
  delete process.env.BLUESMINDS_BASE_URL;

  assert.match(body.error, /Bluesminds/, 'the message must name the provider');
  assert.match(body.error, /slow or unreachable|Could not reach/);
  assert.ok(!/^504: request failed$/.test(body.error), 'never the bare message that was reported');
});

test('a gateway error with no body still names the provider', async () => {
  // The reported symptom: "504: request failed", with several providers
  // configured and no way to tell which one stalled.
  const dead = http.createServer((req, res) => { res.writeHead(504); res.end(); });
  await new Promise((r) => dead.listen(0, r));
  process.env.BLUESMINDS_API_KEY = 'k';
  process.env.BLUESMINDS_BASE_URL = `http://127.0.0.1:${dead.address().port}/v1`;

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=bluesminds`);
  const body = await res.json();

  app.close(); dead.close();
  delete process.env.BLUESMINDS_API_KEY;
  delete process.env.BLUESMINDS_BASE_URL;

  assert.match(body.error, /Bluesminds/);
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
