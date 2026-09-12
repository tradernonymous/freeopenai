// The HuggingFace provider rides the shared OpenAI-compatible machinery, so
// what deserves its own tests is only what is HuggingFace-specific: the
// allowlist is declared, the picker serves the allowlist intersected with the
// live catalogue (a retired upstream id disappears instead of failing at send
// time), the router label reaches the picker, chat reaches the router with the
// HF token, and the env knobs (HF_BASE_URL / HF_MODELS)
// still work like every other provider's.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LLM_PROVIDERS, createRequestHandler, clearModelCache } = require('../server.js');

function startUpstream() {
  return http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        // Three ids: two allowlisted, one paid model the free tier can never
        // use, and one allowlisted id missing entirely (retired upstream).
        data: [
          { id: 'zai-org/GLM-5.3', owned_by: 'zai-org' },
          { id: 'meta-llama/Llama-3.1-8B-Instruct', owned_by: 'meta-llama' },
          { id: 'some-vendor/paid-model', owned_by: 'some-vendor' },
        ],
      }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      // Consume the request body (resume) or 'end' never fires and the
      // handler never answers -- the client then hangs to its full timeout.
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-hf-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hf works' }, finish_reason: 'stop' }],
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('HuggingFace declares the priced-catalogue allowlist', () => {
  const provider = LLM_PROVIDERS.huggingface;
  assert.ok(provider, 'the provider exists');
  assert.equal(provider.baseUrl, 'https://router.huggingface.co/v1');
  assert.equal(provider.envVar, 'HF_TOKEN');
  assert.ok(Array.isArray(provider.models) && provider.models.length >= 100, `declares the full priced catalogue, got ${provider.models && provider.models.length}`);
  // Ids are Hub namespace ids, which is what the router serves.
  for (const id of provider.models) assert.match(id, /^[^/]+\/[^/]+$/, `id looks like a Hub repo: ${id}`);
  // The reason for the provider: usable models at every price point.
  assert.ok(provider.models.includes('zai-org/GLM-5.3'));
  assert.ok(provider.models.includes('openai/gpt-oss-120b'));
  // The list is ordered cheapest-first, so the zero-priced offerings (which
  // never touch credits) lead it.
  const zeroPriced = ['Qwen/Qwen3.8-27B', 'inclusionAI/Ling-3.0-flash-VL', 'prism-ml/Ternary-Bonsai-27B-gguf', 'inclusionAI/Ling-3.0-flash-Fin', 'prism-ml/Ternary-Bonsai-27B-AWQ-4bit'];
  assert.deepEqual([...provider.models.slice(0, 5)].sort(), zeroPriced.sort(), 'the five zero-priced models lead the picker');
  // A repeated id must not be possible twice in the picker.
  assert.equal(new Set(provider.models).size, provider.models.length, 'no duplicate ids');
});

test('the picker serves the allowlist intersected with the catalogue, in declared order', async () => {
  clearModelCache();
  const upstream = startUpstream();
  await new Promise((r) => upstream.listen(0, r));
  process.env.HF_TOKEN = 'hf_test_token';
  process.env.HF_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const listed = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=huggingface`)).json();
    const ids = listed.map((m) => m.id);
    // Declared order kept (cheapest-first puts Llama 3.1 8B ahead of GLM 5.3);
    // retired id dropped; paid model never offered.
    assert.deepEqual(ids, ['meta-llama/Llama-3.1-8B-Instruct', 'zai-org/GLM-5.3']);
    assert.ok(!ids.includes('some-vendor/paid-model'), 'a model outside the free allowlist must not be offered');
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.HF_TOKEN;
    delete process.env.HF_BASE_URL;
    clearModelCache();
  }
});

test('the provider reaches the picker only with a key, under its label', async () => {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  try {
    // No token: present in the source list but not configured, so the picker
    // (which filters on `configured`) never shows it.
    let providers = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
    assert.ok(!providers.some((p) => p.id === 'huggingface' && p.configured), 'no key means not offered');
    // With one: offered under the label the picker shows.
    process.env.HF_TOKEN = 'hf_test_token';
    providers = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/providers`)).json();
    const hf = providers.find((p) => p.id === 'huggingface');
    assert.ok(hf && hf.configured, 'a key puts it in the picker');
    assert.equal(hf.label, 'HuggingFace');
  } finally {
    app.close();
    delete process.env.HF_TOKEN;
  }
});

test('chat goes to the router with the HF token as Bearer', async () => {
  const upstream = startUpstream();
  const seen = {};
  upstream.on('request', (req) => {
    seen.auth = req.headers.authorization;
    seen.url = req.url;
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.HF_TOKEN = 'hf_test_token';
  process.env.HF_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/chat?provider=huggingface`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'zai-org/GLM-5.3', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.auth, 'Bearer hf_test_token', 'the HF token travels as Bearer');
    assert.ok(seen.url.startsWith('/v1/'), `the router keeps its /v1 root: ${seen.url}`);
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.HF_TOKEN;
    delete process.env.HF_BASE_URL;
    clearModelCache();
  }
});

test('HF_MODELS replaces the pinned allowlist', async () => {
  clearModelCache();
  const upstream = startUpstream();
  await new Promise((r) => upstream.listen(0, r));
  process.env.HF_TOKEN = 'hf_test_token';
  process.env.HF_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.HF_MODELS = 'some-vendor/paid-model, meta-llama/Llama-3.1-8B-Instruct';
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const listed = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=huggingface`)).json();
    // The operator's list wins as-is; the "paid" id is their choice, not ours.
    assert.deepEqual(listed.map((m) => m.id), ['some-vendor/paid-model', 'meta-llama/Llama-3.1-8B-Instruct']);
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.HF_TOKEN;
    delete process.env.HF_BASE_URL;
    delete process.env.HF_MODELS;
    clearModelCache();
  }
});
