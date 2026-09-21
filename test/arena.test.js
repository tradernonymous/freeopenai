// Arena: the same message fanned to several already-configured providers at
// once. pickArenaProviders/modelForArenaProvider/streamArenaReply are the
// three pieces small enough to extract and test in isolation; sendArenaMessage
// itself is DOM orchestration (bubbles, finalizeMessage) covered by the
// browser smoke suite instead, the same split the rest of this file's
// neighbours (tool-parallel, images) already use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { errorDetailFromBody, parseSseChunk } = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['pickArenaProviders', 'modelForArenaProvider', 'streamArenaReply'];

function harness() {
  // ARENA_SIZE is a sibling const in app.js, not one of the extracted
  // functions -- a free reference from the sandbox's point of view, so it
  // needs a stand-in the same as any other page-scope name would.
  const deps = { errorDetailFromBody, parseSseChunk, ARENA_SIZE: 3 };
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, deps);
  return loadFromIndex(NAMES, deps);
}

test('pickArenaProviders keeps only configured chat providers, capped at ARENA_SIZE', async () => {
  const realFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url) => {
    calledUrls.push(url);
    return new globalThis.Response(JSON.stringify([
      { id: 'a', label: 'A', configured: true, kind: 'chat' },
      { id: 'img', label: 'Img', configured: true, kind: 'image' },
      { id: 'b', label: 'B', configured: false, kind: 'chat' },
      { id: 'c', label: 'C', configured: true, kind: 'chat' },
      { id: 'd', label: 'D', configured: true, kind: 'chat' },
      { id: 'e', label: 'E', configured: true, kind: 'chat' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { pickArenaProviders } = harness();
    const picked = await pickArenaProviders();
    assert.deepEqual(calledUrls, ['/api/llm/providers']);
    assert.deepEqual(picked, [{ id: 'a', label: 'A' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }]);
  } finally {
    global.fetch = realFetch;
  }
});

test('pickArenaProviders answers an empty list rather than throwing when the route fails', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const { pickArenaProviders } = harness();
    assert.deepEqual(await pickArenaProviders(), []);
  } finally {
    global.fetch = realFetch;
  }
});

test('modelForArenaProvider reads the provider\'s own first model', async () => {
  const realFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url) => {
    calledUrls.push(url);
    return new globalThis.Response(JSON.stringify([{ id: 'nara-large' }, { id: 'nara-small' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { modelForArenaProvider } = harness();
    assert.equal(await modelForArenaProvider('nara'), 'nara-large');
    assert.deepEqual(calledUrls, ['/api/llm/models?provider=nara']);
  } finally {
    global.fetch = realFetch;
  }
});

test('modelForArenaProvider answers empty rather than throwing on an empty catalogue', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new globalThis.Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const { modelForArenaProvider } = harness();
    assert.equal(await modelForArenaProvider('nara'), '');
  } finally {
    global.fetch = realFetch;
  }
});

test('streamArenaReply posts the model and history, and streams deltas into the renderer', async () => {
  const realFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    const body = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
      + 'data: [DONE]\n\n';
    return new globalThis.Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const { streamArenaReply } = harness();
    const appended = [];
    const renderer = { appendText: (t) => appended.push(t), flush: () => {} };
    const convo = [{ role: 'user', content: 'hi' }];
    await streamArenaReply('nara', 'nara-large', convo, renderer, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/llm/chat?provider=nara');
    assert.equal(requests[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].init.body), { model: 'nara-large', messages: convo, stream: true });
    assert.equal(appended.join(''), 'Hello');
  } finally {
    global.fetch = realFetch;
  }
});

test('streamArenaReply throws the upstream\'s own reason on a non-OK response, and sends nothing further', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new globalThis.Response(JSON.stringify({ error: 'model not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  try {
    const { streamArenaReply } = harness();
    const renderer = { appendText: () => {}, flush: () => {} };
    await assert.rejects(
      () => streamArenaReply('nara', 'ghost-model', [], renderer, undefined),
      /model not found/,
    );
  } finally {
    global.fetch = realFetch;
  }
});
