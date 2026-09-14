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
    // The upstream's own payload is passed through, with the picture in it, and
    // the service that drew named alongside -- which is the one fact about a
    // picture that cannot be recovered from the picture itself.
    const body = await res.json();
    assert.deepEqual(body.data, [{ url: 'https://img.test/1.png' }]);
    assert.equal(body.provider, 'nara');
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

test('edits refuses a source that is neither a data URL nor a link', async () => {
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-test';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', { prompt: 'x', image: 'not-an-image' });
    // A 400 with the reason, not a malformed multipart body sent upstream to be
    // guessed at -- and not a 502, which would blame the provider for our input.
    // The status is kept even though the route tries providers in turn: one
    // provider tried means its answer is the answer.
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /data URL or an http\(s\) link/);
  } finally {
    app.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
  }
});

test('edits will not be talked into fetching from inside the network', async () => {
  // A link is allowed as a source, because a picture this chat already drew is
  // named by its URL. The address behind it is checked first: the browser chose
  // that URL, and the server must not be the way to reach a private host.
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-test';
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/edits', { prompt: 'x', image: 'http://127.0.0.1:9/pic.png' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not readable from here/);
  } finally {
    app.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
  }
});

test('edits forwards quality, size and n when they are asked for', async () => {
  let seenBody = Buffer.alloc(0);
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks);
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
    const res = await post(app, '/api/llm/images/edits', {
      prompt: 'add a hat',
      image: 'data:image/png;base64,QUJD',
      quality: 'high',
      size: '1024x1024',
      n: 2,
    });
    assert.equal(res.status, 200);
    const body = seenBody.toString('latin1');
    assert.ok(body.includes('name="quality"'), 'quality field present');
    assert.ok(body.includes('high'), 'quality value present');
    assert.ok(body.includes('name="size"'), 'size field present');
    assert.ok(body.includes('name="n"'), 'n field present');
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});

test('generations forwards quality and n when they are asked for', async () => {
  let seenBody = '';
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBody = raw;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: 'https://img.test/1.png' }, { url: 'https://img.test/2.png' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGES_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a cat', quality: 'high', n: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(seenBody), { prompt: 'a cat', model: 'img-alias-1', quality: 'high', n: 2 });
    // Both pictures come back to the browser: reading only data[0] would deliver
    // one image where two were paid for.
    assert.equal((await res.json()).data.length, 2);
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});

test('a preference the upstream refuses is dropped, and the picture still arrives', async () => {
  // The upstream is strict about what it knows (it already refuses an
  // unlisted size with a 400 rather than rewriting it), so a front that does
  // not implement `quality` would otherwise cost the user their picture for
  // the sake of a setting that was only ever a preference.
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(raw);
      if (raw.includes('quality')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unknown field: quality' } }));
        return;
      }
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
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a cat', quality: 'high' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].url, 'https://img.test/1.png');
    assert.equal(seen.length, 2, 'exactly one retry, and only because there was something to drop');
    assert.ok(seen[0].includes('quality'), 'asked for the better tier first');
    assert.equal(seen[1].includes('quality'), false, 'and asked again without it');
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
  }
});

test('a 400 with nothing to drop is reported as it arrives, not re-sent', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(raw);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown model alias' } }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NARA_API_KEY = 'k';
  process.env.NARA_IMAGE_MODEL = 'img-alias-1';
  process.env.NARA_IMAGES_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  const app = await startApp();
  try {
    const res = await post(app, '/api/llm/images/generations', { prompt: 'a cat' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown model alias/);
    assert.equal(seen.length, 1, 'a retry that could only repeat the same request is not a retry');
  } finally {
    app.close(); upstream.close();
    delete process.env.NARA_API_KEY;
    delete process.env.NARA_IMAGE_MODEL;
    delete process.env.NARA_IMAGES_BASE_URL;
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
