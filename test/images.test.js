const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler } = require('../server.js');

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

test('generations without a key is a clear 400, not a leak', async () => {
  delete process.env.NARA_API_KEY;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a cat' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /NARA_API_KEY/);
  } finally {
    app.close();
  }
});

test('generations without a prompt is a 400', async () => {
  process.env.NARA_API_KEY = 'k';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: '  ' });
    assert.equal(res.status, 400);
  } finally {
    app.close();
    delete process.env.NARA_API_KEY;
  }
});

test('generations without a model alias is a guided 400', async () => {
  // Found by pointing the app at the real service: Nara answers "Image model is
  // required" to a body without one, which arrived here looking like our bug.
  process.env.NARA_API_KEY = 'k';
  delete process.env.NARA_IMAGE_MODEL;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a cat' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /NARA_IMAGE_MODEL/);
  } finally {
    app.close();
    delete process.env.NARA_API_KEY;
  }
});

test('generations sends the configured alias, so the upstream has a model to use', async () => {
  let seenBody = '';
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBody = raw;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://img.test/2.png' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGES_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a red circle' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(seenBody), { prompt: 'a red circle', model: 'img-alias-1' });
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});

test('generations proxies prompt JSON upstream and returns the payload', async () => {
  let seenBody = '';
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBody = raw;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://img.test/1.png' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGES_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a red circle' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: [{ url: 'https://img.test/1.png' }] });
    assert.deepEqual(JSON.parse(seenBody), { prompt: 'a red circle', model: 'img-alias-1' });
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});

test('edits without an image model is a guided 400', async () => {
  process.env.NARA_API_KEY = 'k';
  delete process.env.NARA_IMAGE_MODEL;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', { prompt: 'x', image: 'data:image/png;base64,AA==' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /NARA_IMAGE_MODEL/);
  } finally {
    app.close();
    delete process.env.NARA_API_KEY;
  }
});

test('edits builds multipart with image, mask, prompt and model', async () => {
  let seenType = '';
  let seenBody = Buffer.alloc(0);
  const upstream = http.createServer((req, res) => {
    seenType = req.headers['content-type'] || '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://img.test/2.png' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-test';
  process.env.NARA_IMAGES_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', {
      prompt: 'add a hat',
      image: 'data:image/png;base64,QUJD',
      mask: 'data:image/png;base64,REVG',
      model: 'img-test',
    });
    assert.equal(res.status, 200);
    assert.match(seenType, /^multipart\/form-data; boundary=/);
    const text = seenBody.toString('latin1');
    assert.ok(text.includes('filename="image.png"'), 'image part present');
    assert.ok(text.includes('filename="mask.png"'), 'mask part present');
    assert.ok(text.includes('add a hat'), 'prompt part present');
    assert.ok(text.includes('img-test'), 'model part present');
    assert.ok(seenBody.includes(Buffer.from([0x41, 0x42, 0x43])), 'image bytes survive base64');
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});

test('edits rejects non-data-URL image input', async () => {
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-test';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', { prompt: 'x', image: 'https://img.test/1.png' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /data URL/);
  } finally {
    app.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
  }
});

test('an upstream refusal passes through named, not bare', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'forbidden', message: 'plan does not include images' } }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  // Set, or the request would be refused for having no model alias and never
  // reach the upstream this test is about.
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGES_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a cat' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Nara|plan does not include/);
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});
