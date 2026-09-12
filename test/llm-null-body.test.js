// Reported as:
//
//   Error (openrouter/nvidia/nemotron-3.5-lightning:free):
//   Cannot read properties of null (reading 'parseFailed')
//
// The chain: the provider answered with an OK status and a body that could not
// be read as an object, the proxy forwarded that as `200 null`, and the client
// read a field off the null it got back.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { safeJson, errorDetailFromBody } = require('../chatlib.js');
const { createRequestHandler, clearModelCache } = require('../server.js');

test('safeJson never hands a caller a null to read a field off', async () => {
  // `null` is perfectly valid JSON, so res.json() resolves rather than throwing
  // and the existing catch never sees it.
  const out = await safeJson({ json: async () => null });
  assert.equal(out && out.parseFailed, true, 'a null body is unreadable, not a value');
  assert.match(out.error, /unreadable/);
});

test('safeJson still refuses to invent an object for a real payload', async () => {
  const payload = { choices: [{ message: { content: 'hi' } }] };
  assert.deepEqual(await safeJson({ json: async () => payload }), payload);
  // An empty body parses as nothing at all, and must not reach a caller either.
  for (const body of [null, 0, '', 'text', undefined]) {
    const out = await safeJson({ json: async () => body });
    assert.equal(out && out.parseFailed, true, `${JSON.stringify(body)} must not pass through`);
  }
});

// The two shapes a failed response arrives in, plus the ones that carry nothing
// at all -- a body of `null` used to throw where this returns a string.
test('an error detail is read from JSON, from an SSE frame, or not at all', () => {
  assert.equal(errorDetailFromBody(JSON.stringify({ error: 'plain' })), 'plain');
  assert.equal(errorDetailFromBody('data: ' + JSON.stringify({ error: 'framed' }) + '\n\n'), 'framed');
  // A nested provider error keeps its message rather than printing [object Object].
  assert.equal(errorDetailFromBody(JSON.stringify({ error: { message: 'nested' } })), 'nested');
  // The interesting frame is not always the first one.
  assert.equal(errorDetailFromBody('data: [DONE]\ndata: ' + JSON.stringify({ error: 'later' })), 'later');
  assert.equal(errorDetailFromBody(JSON.stringify({ message: 'top level' })), 'top level');

  // Nothing usable came back, and none of these may throw.
  for (const body of ['null', '', '   ', null, undefined, '<html>502 Bad Gateway</html>', 'data: [DONE]\n\n', '{}', '[1,2,3]']) {
    assert.equal(errorDetailFromBody(body), '', `expected no detail from ${JSON.stringify(body)}`);
  }
});

// The proxy has to stop forwarding a success it cannot actually report. Sending
// `200 null` is what made the client's own bug reachable.
async function withChatUpstream(respond, run) {
  const upstream = http.createServer((req, res) => respond(res));
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

const chat = (base) => fetch(base + '/api/llm/chat?provider=openrouter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'nvidia/nemotron-3.5-lightning:free', messages: [{ role: 'user', content: 'hi' }] }),
});

test('an OK status with an unreadable body is reported, not forwarded as null', async () => {
  await withChatUpstream((res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  }, async (base) => {
    const res = await chat(base);
    const raw = await res.text();
    assert.notEqual(res.status, 200, 'a success it cannot report is not a success');
    assert.notEqual(raw.trim(), 'null', 'the client must not be handed a bare null');
    const body = JSON.parse(raw);
    assert.ok(typeof body.error === 'string' && body.error.length, 'and it has to explain itself');
    assert.match(body.error, /nothing readable/i);
  });
});

test('an OK status with a literal null body is not forwarded either', async () => {
  // JSON.parse('null') is null, which is why the client's own guard missed it.
  await withChatUpstream((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('null');
  }, async (base) => {
    const res = await chat(base);
    assert.notEqual(res.status, 200);
    assert.ok(JSON.parse(await res.text()).error);
  });
});

test('an empty OK body is not forwarded either', async () => {
  await withChatUpstream((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('');
  }, async (base) => {
    const res = await chat(base);
    assert.notEqual(res.status, 200);
    assert.ok(JSON.parse(await res.text()).error);
  });
});

test('a real reply still passes through untouched', async () => {
  const reply = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
  await withChatUpstream((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  }, async (base) => {
    const res = await chat(base);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), reply);
  });
});
