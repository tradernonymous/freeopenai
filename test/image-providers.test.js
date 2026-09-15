// Image generation used to be Nara's and only Nara's, so a key for any other
// provider this app chats on could not draw: the one image route answered
// "Image generation needs NARA_IMAGE_MODEL", naming a service the operator had
// not configured. These tests point the route at a stand-in for each kind of
// upstream and check that every provider that can draw actually draws -- and
// that the chain moves on when one of them says no.
//
// What differs between the services is the shape of the request, so the shape is
// what most of these assert: an OpenAI body, an HF task body, an NVCF GenAI body,
// and an edit that rides either multipart file parts or a reference URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler } = require('../server.js');

// Every variable that decides which providers are configured. Cleared before
// each test so one test's key cannot be what makes the next one pass.
const PROVIDER_VARS = [
  'NARA_API_KEY', 'NARA_IMAGE_MODEL', 'NARA_IMAGES_BASE_URL', 'NARA_IMAGE_SIZE',
  'OPENROUTER_API_KEY', 'OPENROUTER_IMAGE_MODEL', 'OPENROUTER_IMAGES_BASE_URL',
  'NVIDIA_API_KEY', 'NVIDIA_IMAGE_MODEL', 'NVIDIA_IMAGES_BASE_URL',
  'HF_TOKEN', 'HF_IMAGE_MODEL', 'HF_IMAGES_BASE_URL',
  'OMNIROUTE_API_KEY', 'OMNIROUTE_IMAGE_MODEL',
  'OLLAMA_IMAGE_MODEL',
  'IMAGE_PROVIDER',
  'OPENROUTER_FREE_ONLY',
];

function clearProviders() {
  for (const name of PROVIDER_VARS) delete process.env[name];
  // OpenRouter's Image API has no free tier, so a free-only key is not an image
  // candidate at all. Most tests here are about the drawing paths rather than
  // that gate, so the baseline is a key with credits on it; the gate has a test
  // of its own below.
  process.env.OPENROUTER_FREE_ONLY = '0';
}

// A stand-in upstream that records every request and answers with whatever the
// test said, in the shape that service actually answers in.
async function upstreamOf(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      seen.push({ url: req.url, headers: req.headers, body: raw.toString('utf8'), bytes: raw });
      handler(req, res, raw, seen.length - 1);
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function startApp() {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  return app;
}

function post(app, path, body) {
  return fetch(`http://127.0.0.1:${app.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function jsonAnswer(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test.beforeEach(clearProviders);
test.afterEach(clearProviders);

test('an OpenRouter key alone draws, with no Nara key in sight', async () => {
  // The bug this covers: chat on OpenRouter, ask for a picture, and be told to
  // set NARA_IMAGE_MODEL.
  const up = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/or.png' }] }));
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'openrouter');
    assert.equal(body.data[0].url, 'https://img.test/or.png');
    assert.equal(up.seen.length, 1);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('the store’s model is the default when the operator names none', async () => {
  const up = await upstreamOf((req, res, raw) => {
    assert.equal(req.url, '/images/generations');
    assert.deepEqual(JSON.parse(raw), { model: 'google/gemini-2.5-flash-image', prompt: 'a fox' });
    jsonAnswer(res, 200, { data: [{ b64_json: 'AAA' }] });
  });
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].b64_json, 'AAA');
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a provider that refuses the whole request is stepped past, not reported as the end', async () => {
  const first = await upstreamOf((req, res) => jsonAnswer(res, 403, { error: { message: 'plan does not include images' } }));
  const second = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/nv.png' }] }));
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = first.url;
  process.env.NVIDIA_API_KEY = 'nv-key';
  process.env.NVIDIA_IMAGES_BASE_URL = second.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'nvidia', 'the second service is the one that drew');
    assert.equal(first.seen.length, 1);
    assert.equal(second.seen.length, 1);
  } finally {
    app.close();
    await new Promise((r) => first.server.close(r));
    await new Promise((r) => second.server.close(r));
  }
});

test('a named provider is honoured exactly, with nothing behind it', async () => {
  const up = await upstreamOf((req, res) => jsonAnswer(res, 500, { error: 'boom' }));
  const other = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/other.png' }] }));
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  process.env.NVIDIA_API_KEY = 'nv-key';
  process.env.NVIDIA_IMAGES_BASE_URL = other.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', provider: 'openrouter' });
    // Naming a service is a decision. Spending a second operator's key because
    // the first said no would be a different choice made on their behalf.
    assert.equal(res.status, 500);
    assert.equal(other.seen.length, 0);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
    await new Promise((r) => other.server.close(r));
  }
});

test('an unknown named provider is refused with the list, not silently ignored', async () => {
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', provider: 'midjourney' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown image provider "midjourney".*nara/s);
  } finally {
    app.close();
  }
});

test('a refusal ends the chain, because every provider is being asked the same thing', async () => {
  const refused = await upstreamOf((req, res) => jsonAnswer(res, 400, { error: { message: 'moderation_flagged' } }));
  const other = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/other.png' }] }));
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = refused.url;
  process.env.NVIDIA_API_KEY = 'nv-key';
  process.env.NVIDIA_IMAGES_BASE_URL = other.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a gory poster' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).refused, true);
    assert.equal(other.seen.length, 0, 'a second key is not spent to hear it refused again');
  } finally {
    app.close();
    await new Promise((r) => refused.server.close(r));
    await new Promise((r) => other.server.close(r));
  }
});

test('when every provider fails the message names each one and what it said', async () => {
  const up = await upstreamOf((req, res) => jsonAnswer(res, 500, { error: 'boom' }));
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  process.env.HF_TOKEN = 'hf-key';
  process.env.HF_IMAGES_BASE_URL = 'http://127.0.0.1:9';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /OpenRouter \(/);
    assert.match(body.error, /HuggingFace \(/);
    assert.deepEqual(body.tried, ['OpenRouter', 'HuggingFace']);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('nothing configured at all names every variable that would help', async () => {
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /No image provider is ready/);
    assert.match(body.error, /NARA_API_KEY/);
    assert.match(body.error, /OPENROUTER_API_KEY/);
    assert.match(body.error, /HF_TOKEN/);
    assert.match(body.error, /Puter/, 'and says Puter needs no configuration at all');
  } finally {
    app.close();
  }
});

// ---- the shapes -------------------------------------------------------------

test('the HuggingFace task route is read as bytes, not as a document', async () => {
  // Text-to-image on HF is not the OpenAI-compatible router: it is the task
  // route, {inputs, parameters} in and the picture itself out.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const up = await upstreamOf((req, res, raw) => {
    assert.equal(req.url, '/models/stabilityai/stable-diffusion-3-medium-diffusers');
    assert.deepEqual(JSON.parse(raw), { inputs: 'a fox', parameters: { width: 1024, height: 1024 } });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  process.env.HF_TOKEN = 'hf-key';
  process.env.HF_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', size: '1024x1024' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'huggingface');
    assert.equal(body.data[0].b64_json, png.toString('base64'));
    assert.equal(body.data[0].media_type, 'image/png');
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('the NVCF GenAI shape is normalized, and its 404 falls through to the OpenAI one', async () => {
  let attempt = 0;
  const up = await upstreamOf((req, res, raw) => {
    attempt++;
    if (attempt === 1) {
      assert.equal(req.url, '/genai/black-forest-labs/flux.1-schnell');
      assert.deepEqual(JSON.parse(raw), { prompt: 'a fox', mode: 'base', aspect_ratio: '16:9' });
      jsonAnswer(res, 200, { artifacts: [{ base64: 'RkxVWA==' }] });
      return;
    }
    // A self-hosted visual-genai NIM documents an OpenAI-compatible images API
    // instead, and the 404 is what moves the request there.
    assert.equal(req.url, '/images/generations');
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/nim.png' }] });
  });
  process.env.NVIDIA_API_KEY = 'nv-key';
  process.env.NVIDIA_IMAGES_BASE_URL = up.url;
  process.env.NVIDIA_IMAGE_MODEL = 'black-forest-labs/flux.1-schnell';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', size: '1640x856' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'nvidia');
    assert.equal(body.data[0].b64_json, 'RkxVWA==');
    assert.equal(body.data[0].media_type, 'image/png', 'the NVCF shape is rewritten, not passed through');
    assert.equal(attempt, 1);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('an operator’s default size is used when the caller asks for none', async () => {
  const up = await upstreamOf((req, res, raw) => {
    assert.equal(JSON.parse(raw).size, '1024x1024');
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/1.png' }] });
  });
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGE_SIZE = '1024x1024';
  process.env.NARA_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 200);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('one service’s default size never decides what another is asked for', async () => {
  const up = await upstreamOf((req, res, raw) => {
    assert.equal('size' in JSON.parse(raw), false);
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/1.png' }] });
  });
  // Set, and deliberately not applied: NARA_IMAGE_SIZE is Nara's, and 1024x1024
  // is not a size OpenRouter was asked about.
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGE_SIZE = '1024x1024';
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', provider: 'openrouter' });
    assert.equal(res.status, 200);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a size this store has not agreed to is a preference, and is not what loses the picture', async () => {
  // 1640x856 is Nara's, and Nara refuses a size outside its own list. Sending it
  // anyway and then giving up would cost the user their picture over a setting
  // that was only ever a preference.
  const seen = [];
  const up = await upstreamOf((req, res, raw) => {
    seen.push(JSON.parse(raw));
    if (seen.length === 1) {
      jsonAnswer(res, 400, { error: { message: 'Unsupported size' } });
      return;
    }
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/1.png' }] });
  });
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', size: '1640x856' });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].size, '1640x856', 'asked for the shape first');
    assert.equal('size' in seen[1], false, 'and asked again without it');
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

// ---- edits ------------------------------------------------------------------

test('an edit to a service that takes a reference rides the generations endpoint', async () => {
  const up = await upstreamOf((req, res, raw) => {
    assert.equal(req.url, '/images/generations');
    const body = JSON.parse(raw);
    assert.equal(body.model, 'google/gemini-2.5-flash-image');
    assert.equal(body.prompt, 'make it red');
    // The source reaches the service as a reference URL, which is what routes an
    // edit there rather than a draw from scratch.
    assert.deepEqual(body.input_references, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/edited.png' }] });
  });
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', { prompt: 'make it red', image: 'data:image/png;base64,QUJD' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].url, 'https://img.test/edited.png');
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a painted mask goes to a service that can take one, and is reported when it cannot', async () => {
  // Puter has no mask field and neither does a reference URL, so a service given
  // one would edit the whole picture while the user watched a region they drew
  // being ignored. Dropping it is right; dropping it silently is not.
  const up = await upstreamOf((req, res, raw) => {
    const text = raw.toString('utf8');
    assert.equal(text.includes('mask.png'), false, 'a references service is never sent a mask');
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/edited.png' }] });
  });
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', {
      prompt: 'add horns',
      image: 'data:image/png;base64,QUJD',
      mask: 'data:image/png;base64,REVG',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notes.length, 1);
    assert.match(body.notes[0], /mask was dropped/);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a mask reaches the multipart route as a file part, alongside the picture', async () => {
  let seen = '';
  const up = await upstreamOf((req, res, raw) => {
    seen = raw.toString('latin1');
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/edited.png' }] });
  });
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', {
      prompt: 'add horns',
      image: 'data:image/png;base64,QUJD',
      mask: 'data:image/png;base64,REVG',
    });
    assert.equal(res.status, 200);
    assert.ok(seen.includes('filename="image.png"'));
    assert.ok(seen.includes('filename="mask.png"'));
    assert.equal((await res.json()).notes, undefined);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

// ---- what the page reads ----------------------------------------------------

test('the provider report says what is ready, with which model, and what is missing', async () => {
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.NARA_API_KEY = 'nara-key';
  const app = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/images/providers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const openrouter = body.providers.find((p) => p.id === 'openrouter');
    assert.equal(openrouter.ready, true);
    assert.equal(openrouter.model, 'google/gemini-2.5-flash-image');
    assert.equal(openrouter.edits, 'reference');
    // Nara is configured but has no alias, so it is listed as not ready with the
    // reason -- which is the whole point of reporting it.
    const nara = body.providers.find((p) => p.id === 'nara');
    assert.equal(nara.ready, false);
    assert.match(nara.reason, /NARA_IMAGE_MODEL/);
    assert.deepEqual(nara.sizes, ['1024x1024', '1640x856', '1024x1280', '2048x1024']);
    // The browser's own backends cannot be reported by the server, but the page
    // needs to know one exists so its picker can offer it.
    assert.equal(body.browser.id, 'puter');
  } finally {
    app.close();
  }
});

// ---- following the conversation --------------------------------------------
//
// The page no longer offers a second picker for images: the image request goes
// to the provider and model the conversation is already on. These tests are the
// route's half of that promise -- the chat's provider is asked first, its model
// is offered to it, and neither turns a service that cannot draw into a dead end.

test('the chat’s own provider is asked first, with the chat’s own model', async () => {
  const hugging = await upstreamOf((req, res) => res.end(Buffer.from([1, 2, 3])));
  const openrouter = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/chat-model.png' }] }));
  // Nara is configured and would otherwise lead the order: this is the assertion
  // that the conversation's choice outranks the deployment's default.
  process.env.NARA_API_KEY = 'nara-key';
  process.env.NARA_IMAGE_MODEL = 'nara-image';
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = openrouter.url;
  process.env.HF_TOKEN = 'hf';
  process.env.HF_IMAGE_MODEL = 'stabilityai/stable-diffusion-xl-base-1.0';
  process.env.HF_IMAGES_BASE_URL = hugging.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', {
      prompt: 'a fox',
      preferProvider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'openrouter');
    assert.equal(openrouter.seen.length, 1, 'the chat’s provider draws the picture');
    assert.equal(hugging.seen.length, 0, 'and the rest of the order was not spent');
    assert.equal(JSON.parse(openrouter.seen[0].body).model, 'google/gemini-2.5-flash-image');
  } finally {
    app.close();
    await new Promise((r) => openrouter.server.close(r));
    await new Promise((r) => hugging.server.close(r));
  }
});

test('a chat model that cannot draw is not the end of the provider', async () => {
  // A 400 is never billed, which is what makes this a preference and not a
  // gamble: the provider is asked again with the model it would have used.
  let attempts = 0;
  const up = await upstreamOf((req, res, raw) => {
    attempts++;
    const body = JSON.parse(raw);
    if (body.model === 'some-chat-model') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not an image model' } }));
    }
    assert.equal(body.model, 'google/gemini-2.5-flash-image', 'the provider’s own model is the second try');
    jsonAnswer(res, 200, { data: [{ url: 'https://img.test/fallback.png' }] });
  });
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', {
      prompt: 'a fox',
      preferProvider: 'openrouter',
      model: 'some-chat-model',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].url, 'https://img.test/fallback.png');
    assert.equal(attempts, 2);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a preference is not a pin: a provider that cannot draw is stepped past', async () => {
  const hugging = await upstreamOf((req, res, raw) => {
    // Deliberately not the store's default: this test is about the order
    // carrying on past a preference, and an explicit model that happened to
    // equal the default would not show the override was honoured.
    assert.equal(req.url, '/models/stabilityai/stable-diffusion-xl-base-1.0');
    assert.equal(JSON.parse(raw).inputs, 'a fox');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([0xff, 0xd8, 0xff]));
  });
  const nara = await upstreamOf((req, res) => jsonAnswer(res, 500, { error: 'down' }));
  process.env.NARA_API_KEY = 'nara-key';
  process.env.NARA_IMAGE_MODEL = 'nara-image';
  process.env.NARA_IMAGES_BASE_URL = nara.url;
  process.env.HF_TOKEN = 'hf';
  process.env.HF_IMAGE_MODEL = 'stabilityai/stable-diffusion-xl-base-1.0';
  process.env.HF_IMAGES_BASE_URL = hugging.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', {
      prompt: 'a fox',
      preferProvider: 'nara',
      model: 'nara-chat-model',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).provider, 'huggingface', 'the order carries on behind the preference');
  } finally {
    app.close();
    await new Promise((r) => nara.server.close(r));
    await new Promise((r) => hugging.server.close(r));
  }
});

test('a size the service does not offer is swapped for its nearest, and said out loud', async () => {
  // Nara declares its sizes. Handing it 1536x1024 used to mean the draw failed on
  // a service that was ready and had credits -- refused for a reason nobody
  // typed. It now draws 1640x856, the closest shape it offers, and the swap is a
  // sentence in `notes` rather than something found later in the download.
  const up = await upstreamOf((req, res, raw) => {
    const body = JSON.parse(raw);
    assert.equal(body.size, '1640x856');
    jsonAnswer(res, 200, { data: [{ b64_json: 'AAA' }] });
  });
  process.env.NARA_API_KEY = 'nara-key';
  process.env.NARA_IMAGE_MODEL = 'nara-image';
  process.env.NARA_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a banner', size: '1536x1024' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data[0].b64_json, 'AAA');
    assert.equal(body.notes.length, 1);
    assert.match(body.notes[0], /asked for 1536x1024 — Nara draws 1640x856/);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a size the service does offer is passed through untouched, with nothing to report', async () => {
  const up = await upstreamOf((req, res, raw) => {
    assert.equal(JSON.parse(raw).size, '2048x1024');
    jsonAnswer(res, 200, { data: [{ b64_json: 'AAA' }] });
  });
  process.env.NARA_API_KEY = 'nara-key';
  process.env.NARA_IMAGE_MODEL = 'nara-image';
  process.env.NARA_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a banner', size: '2048x1024' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).notes, undefined);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

// --- The three reasons drawing failed on every provider at once ---

test('a free-only OpenRouter key is not asked to draw, because it cannot', async () => {
  // OpenRouter's Image API has no free tier. Asking anyway spends a round trip
  // to be told "402 Insufficient credits. This account never purchased
  // credits." -- a fact about the account, so every later attempt gets the same.
  const up = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/or.png' }] }));
  delete process.env.OPENROUTER_FREE_ONLY;
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.ok(res.status >= 400, 'a key that cannot draw should not report success');
    // The message has to say how to get back in, not merely that it failed.
    assert.match(JSON.stringify(await res.json()), /OPENROUTER_FREE_ONLY=0/);
    assert.equal(up.seen.length, 0, 'a provider that cannot draw must not be contacted');
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a key with credits still draws on OpenRouter', async () => {
  // The gate above is the free-only case and nothing wider: a paid key is
  // unaffected, which is what makes OPENROUTER_FREE_ONLY=0 a real way back in.
  const up = await upstreamOf((req, res) => jsonAnswer(res, 200, { data: [{ url: 'https://img.test/or.png' }] }));
  process.env.OPENROUTER_FREE_ONLY = '0';
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).provider, 'openrouter');
    assert.equal(up.seen.length, 1);
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('a shape the service rejects is dropped and retried, on 422 as well as 400', async () => {
  // NVIDIA answers a field it does not accept with
  //   422 {"type":"extra_forbidden","loc":["body","aspect_ratio"]}
  // Two things were wrong: the retry only looked for 400, and aspect_ratio sat
  // outside the drop-preferences mechanism entirely -- so the retry re-sent the
  // very field that caused the refusal, for every model, every time.
  const bodies = [];
  const up = await upstreamOf((req, res, raw) => {
    const body = JSON.parse(raw.toString() || '{}');
    bodies.push(body);
    if (body.aspect_ratio) {
      return jsonAnswer(res, 422, [{ type: 'extra_forbidden', loc: ['body', 'aspect_ratio'] }]);
    }
    jsonAnswer(res, 200, { artifacts: [{ base64: 'UElD' }] });
  });
  process.env.NVIDIA_API_KEY = 'nv-key';
  process.env.NVIDIA_IMAGES_BASE_URL = up.url;
  const app = await startApp();
  try {
    // 1640x856 is what the table calls 16:9, and "16:9" is the value NVIDIA
    // named in the refusal. A size with no aspect in the table sends no
    // aspect_ratio at all and would test nothing.
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a fox', size: '1640x856' });
    assert.equal(res.status, 200, 'the retry without the shape should have drawn');
    assert.ok(JSON.stringify(await res.json()).includes('UElD'));
    assert.ok(bodies.length >= 2, 'expected a second attempt without the rejected field');
    assert.ok(bodies[0].aspect_ratio, 'the first attempt carries the shape that was asked for');
    assert.equal(bodies[bodies.length - 1].aspect_ratio, undefined, 'the retry still carried aspect_ratio');
  } finally {
    app.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('the HuggingFace default is a model that provider still serves', async () => {
  // FLUX.1-schnell was retired from hf-inference and answers 410 "deprecated
  // and no longer supported", which made HuggingFace a guaranteed failure in
  // the chain rather than a fallback.
  const { LLM_PROVIDERS } = require('../server.js');
  assert.equal(
    LLM_PROVIDERS.huggingface.image.defaultModel,
    'stabilityai/stable-diffusion-3-medium-diffusers',
  );
  assert.doesNotMatch(LLM_PROVIDERS.huggingface.image.defaultModel, /FLUX\.1-schnell/);
});
