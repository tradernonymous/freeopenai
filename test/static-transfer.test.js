// The whole UI is one 520KB index.html plus a 208KB chatlib.js, and both used to
// go out uncompressed on every load -- 728KB of text, most of it whitespace and
// the long comments this codebase is written in, re-downloaded each time because
// 'no-cache' had no validator to revalidate against.
//
// These assertions are about what actually crosses the wire, so they all go
// through a real listener and read real headers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { createRequestHandler } = require('../server.js');

const root = path.join(__dirname, '..');

function fetchRaw(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function withServer(run) {
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

test('the page is compressed for a client that takes it, and readable after', async () => {
  await withServer(async (port) => {
    const plain = await fetchRaw(port, '/');
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined, 'a client that asked for nothing gets nothing');

    const br = await fetchRaw(port, '/', { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br');
    // The point of the exercise: it has to be a large saving, not a token one.
    assert.ok(br.body.length < plain.body.length * 0.4,
      `brotli saved too little: ${plain.body.length} -> ${br.body.length}`);
    // And it has to decode back to exactly the page, or the app does not boot.
    assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
    assert.equal(Number(br.headers['content-length']), br.body.length,
      'Content-Length has to describe the encoded body, not the original');

    const gz = await fetchRaw(port, '/', { 'accept-encoding': 'gzip, deflate' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);

    // Without this any shared cache in front of the app may hand a brotli body
    // to a client that cannot read it.
    assert.equal(br.headers.vary, 'Accept-Encoding');
  });
});

test('chatlib.js is compressed too, since it is the other half of the payload', async () => {
  await withServer(async (port) => {
    const plain = await fetchRaw(port, '/chatlib.js');
    const br = await fetchRaw(port, '/chatlib.js', { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
    assert.ok(br.body.length < plain.body.length * 0.4);
  });
});

test('a q=0 is a refusal, not a request for that encoding', async () => {
  await withServer(async (port) => {
    const refused = await fetchRaw(port, '/', { 'accept-encoding': 'br;q=0, gzip;q=0' });
    assert.equal(refused.headers['content-encoding'], undefined,
      'naming an encoding at q=0 means the client cannot read it');
    assert.equal(refused.status, 200);
    // A refusal of brotli alone still leaves gzip on the table.
    const gz = await fetchRaw(port, '/', { 'accept-encoding': 'br;q=0, gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
  });
});

test('an unchanged page revalidates for nothing instead of downloading again', async () => {
  await withServer(async (port) => {
    const first = await fetchRaw(port, '/');
    const etag = first.headers.etag;
    assert.ok(etag, 'no validator means every reload is a full download');
    assert.equal(first.headers['cache-control'], 'no-cache',
      'the UI ships in index.html, so it revalidates rather than being reused blind');

    const again = await fetchRaw(port, '/', { 'if-none-match': etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers.etag, etag);

    // A validator that no longer matches must produce the page, not a 304.
    const stale = await fetchRaw(port, '/', { 'if-none-match': '"not-the-page"' });
    assert.equal(stale.status, 200);
    assert.ok(stale.body.length > 1000);

    // The same body under a different encoding is the same resource, so the
    // validator still matches -- and 304 carries no body to mis-encode.
    const conditional = await fetchRaw(port, '/', { 'if-none-match': etag, 'accept-encoding': 'br' });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.body.length, 0);
  });
});

test('a HEAD describes the body it would have sent', async () => {
  await withServer(async (port) => {
    const get = await fetchRaw(port, '/', { 'accept-encoding': 'br' });
    const head = await fetchRaw(port, '/', { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0, 'a HEAD sends no body');
    assert.equal(head.headers['content-encoding'], 'br');
    assert.equal(Number(head.headers['content-length']), get.body.length);
  });
});

test('an unknown path still serves the app, compressed the same way', async () => {
  await withServer(async (port) => {
    // The single-page fallback: a deep link is the app, not a 404.
    const deep = await fetchRaw(port, '/some/chat/route', { 'accept-encoding': 'br' });
    assert.equal(deep.status, 200);
    assert.equal(deep.headers['content-encoding'], 'br');
    assert.ok(deep.headers.etag, 'the fallback needs a validator too, or it re-downloads every time');
    const page = await fetchRaw(port, '/', { 'accept-encoding': 'br' });
    assert.equal(deep.headers.etag, page.headers.etag, 'it is the same page, so it is the same resource');

    // An asset that is missing is still a 404: serving HTML for a missing .js
    // would be a syntax error rather than a diagnosis.
    const missing = await fetchRaw(port, '/nope.js');
    assert.equal(missing.status, 404);
  });
});
