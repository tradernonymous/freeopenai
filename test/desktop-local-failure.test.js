// What a local model server says when it refuses.
//
// "The local model server answered 500." is a status code, not a reason, and
// it left people with nothing to act on. llama-server always sends a reason in
// the body, so it is read and shown -- and the commonest 500 of all is named
// outright: a picture sent to a GGUF with no mmproj projector has no vision to
// read it with, and the server rejects the whole message rather than ignoring
// the image. Nothing in the server's own wording tells you to swap the model.
//
// api.ts is TypeScript, so it is transpiled with the esbuild already in
// desktop/node_modules and driven for real -- a source assertion cannot tell
// whether the body was actually read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const DESKTOP = path.join(__dirname, '..', 'desktop');

function loadApi() {
  const esbuild = require(path.join(DESKTOP, 'node_modules', 'esbuild'));
  const source = fs.readFileSync(path.join(DESKTOP, 'src', 'api.ts'), 'utf8');
  const js = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const filename = path.join(DESKTOP, 'src', 'api.generated.js');
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.join(DESKTOP, 'src'));
  mod._compile(js, filename);
  return mod.exports;
}

/** A refusal shaped like llama-server's. */
function refuses(status, body) {
  return async () => ({
    ok: false,
    status,
    headers: { get: () => 'application/json' },
    text: async () => body,
    json: async () => JSON.parse(body),
  });
}

const PICTURE = [{
  role: 'user',
  content: [
    { type: 'text', text: 'what is in this picture?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
  ],
}];
const WORDS = [{ role: 'user', content: 'hello' }];

async function failureOf(messages, status, body) {
  const api = loadApi();
  const realFetch = globalThis.fetch;
  globalThis.fetch = refuses(status, body);
  try {
    await api.streamLocalChat('http://127.0.0.1:8080', 'local', messages, () => {});
    assert.fail('a refusal must throw');
  } catch (err) {
    return String(err.message || err);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a picture sent to a model that cannot see says so, and what to do', async () => {
  const message = await failureOf(
    PICTURE,
    500,
    JSON.stringify({ error: { message: 'multimodal input is not supported by this server', code: 500 } }),
  );
  assert.match(message, /cannot read pictures/i, 'the cause is named');
  assert.match(message, /mmproj|vision model/i, 'and so is the fix');
  assert.match(message, /multimodal input is not supported/, "the server's own words survive");
});

test('an ordinary refusal carries the reason the server gave', async () => {
  const message = await failureOf(
    WORDS,
    500,
    JSON.stringify({ error: { message: 'the request exceeds the available context size' } }),
  );
  assert.match(message, /500/, 'the status is still there');
  assert.match(message, /exceeds the available context size/, 'with the reason beside it');
  assert.ok(!/cannot read pictures/i.test(message), 'no picture advice when no picture was sent');
});

test('a body that says nothing is reported as saying nothing', async () => {
  const message = await failureOf(WORDS, 503, '');
  assert.match(message, /503/);
  assert.match(message, /without saying why/i, 'an empty body is stated, not invented');
});

test('a wall of text is clipped rather than pasted into the chat', async () => {
  const message = await failureOf(WORDS, 500, JSON.stringify({ error: { message: 'x'.repeat(5000) } }));
  assert.ok(message.length < 600, `message was ${message.length} characters`);
  assert.match(message, /…/, 'and says it was cut');
});
