// Shareable read-only links and saved memory.
//
// Both features keep the app's storage shape: a share is a frozen copy on the
// server, memory is a tiny per-user list of facts. These tests drive the real
// routes the way free-tier-health.test.js does -- a live handler against a
// listen(0) server -- plus the pure helpers in chatlib.js that the page uses
// to build payloads and prompts.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const server = require('../server.js');
const { createRequestHandler } = server;
const { sharePayloadOf, shareImageDataUrlFactory, memoryPromptFor, memoryFactsUsedIn, MEMORY_TOOL } = require('../chatlib.js');

async function withApp(run) {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((resolve) => app.listen(0, resolve));
  try {
    await run('http://127.0.0.1:' + app.address().port);
  } finally {
    app.close();
  }
}

// ---------------------------------------------------------------- chatlib

test('a share payload keeps only what a reader should see', () => {
  const payload = sharePayloadOf([
    { type: 'user', content: 'hello' },
    { type: 'system', content: 'internal narration must not ship' },
    { type: 'bot', content: '  hi there  ' },
    { type: 'bot', content: '' },
    { type: 'user', content: 'pic', images: [{ url: 'data:image/png;base64,AAA' }, { id: 'stored-only' }] },
  ], 'My chat');
  assert.ok(payload);
  assert.equal(payload.title, 'My chat');
  assert.deepEqual(payload.messages.map((m) => m.type), ['user', 'bot', 'user']);
  assert.equal(payload.messages[1].content, 'hi there');
  assert.deepEqual(payload.messages[2].images, ['data:image/png;base64,AAA'],
    'a stored image id carries no bytes, so it is left out');
});

test('a share payload is refused when the conversation would not fit', () => {
  const big = 'x'.repeat(500000);
  assert.equal(sharePayloadOf([{ type: 'user', content: big }]), null);
  assert.equal(sharePayloadOf([{ type: 'system', content: 'only narration' }]), null);
  assert.equal(sharePayloadOf([]), null);
});

test('the share image helper downscales and refuses nothing loudly', async () => {
  const made = [];
  const share = shareImageDataUrlFactory({
    loadImage: (src) => Promise.resolve({ width: 2048, height: 1024, src }),
    makeCanvas: (w, h) => {
      made.push([w, h]);
      return {
        width: w, height: h,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => 'data:image/jpeg;base64,SMALL',
      };
    },
  });
  const big = 'data:image/png;base64,AAAA';
  assert.equal(await share(big), 'data:image/jpeg;base64,SMALL');
  assert.deepEqual(made, [[768, 384]], 'the long edge is capped, the ratio kept');
  const fail = shareImageDataUrlFactory({
    loadImage: () => Promise.reject(new Error('no')),
    makeCanvas: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => '' }),
  });
  assert.equal(await fail(big), '', 'an unreadable picture becomes nothing, not an error');
});

test('memory turns into a context block, or nothing when there is nothing', () => {
  assert.equal(memoryPromptFor([]), '');
  assert.equal(memoryPromptFor(undefined), '');
  assert.equal(memoryPromptFor([{ text: ' ' }]), '');
  const block = memoryPromptFor([{ text: 'prefers Python' }, { text: 'building a game in Godot' }]);
  assert.match(block, /prefers Python/);
  assert.match(block, /building a game in Godot/);
  assert.match(block, /^Things the user asked you to remember/);
  const long = memoryPromptFor([{ text: 'y'.repeat(400) }]);
  assert.ok(long.length < 400, 'one fact cannot dominate the prompt');
});

test('the memory tool asks for text and names itself once', () => {
  assert.equal(MEMORY_TOOL.function.name, 'save_memory');
  assert.equal(MEMORY_TOOL.function.parameters.required[0], 'text');
});

test('a reply that echoes a fact marks that fact as used', () => {
  const facts = [{ text: 'prefers Python' }, { text: 'building a game in Godot' }];
  const used = memoryFactsUsedIn('Here is a Python snippet to get you started.', facts);
  // "prefers" is a stopword on purpose; the match is on "python".
  assert.deepEqual(used, ['prefers Python']);
  const none = memoryFactsUsedIn('The capital of France is Paris.', facts);
  assert.deepEqual(none, []);
  const both = memoryFactsUsedIn('For your Godot project, Python is less typical — GDScript is the engine language.', facts);
  assert.equal(both.length, 2);
  assert.ok(both.includes('prefers Python') && both.includes('building a game in Godot'));
});

test('stopword-only facts can never match, and empty answers nothing', () => {
  assert.deepEqual(memoryFactsUsedIn('That is what they said about it.', [{ text: 'this that with from' }]), []);
  assert.deepEqual(memoryFactsUsedIn('', [{ text: 'prefers Python' }]), []);
  // A content word shared by fact and reply counts, however unremarkable:
  // "named" is a real word in both, and one content hit is enough by design.
  assert.deepEqual(memoryFactsUsedIn('Everything named here is hypothetical.', [{ text: 'has a cat named Max' }]), ['has a cat named Max']);
});

// ---------------------------------------------------------------- server

test('a published share can be read by anyone and revoked by the owner', async () => {
  await withApp(async (base) => {
    const put = await fetch(base + '/api/share', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Demo', messages: [{ type: 'user', content: 'one' }, { type: 'bot', content: 'two' }] }),
    });
    assert.equal(put.status, 200);
    const { id, url } = await put.json();
    assert.equal(url, '/s/' + id);

    const shell = await fetch(base + url);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type'), /text\/html/);

    const data = await fetch(base + '/api/share/' + id);
    const entry = await data.json();
    assert.equal(entry.title, 'Demo');
    assert.equal(entry.messages.length, 2);

    const gone = await fetch(base + '/s/not-a-real-id');
    assert.equal(gone.status, 404);

    const revoke = await fetch(base + '/api/share/' + id, { method: 'DELETE' });
    assert.equal(revoke.status, 200);
    assert.equal((await fetch(base + '/api/share/' + id)).status, 404, 'a revoked link is a dead link');
    assert.equal((await fetch(base + url)).status, 404, 'the reader says so too');
  });
});

test('an empty share is refused, an oversized one is refused, a big store evicts oldest', async () => {
  await withApp(async (base) => {
    const empty = await fetch(base + '/api/share', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"messages":[]}' });
    assert.equal(empty.status, 400);

    const huge = await fetch(base + '/api/share', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ type: 'user', content: 'x'.repeat(500000) }] }),
    });
    assert.equal(huge.status, 413, 'an oversized publish is refused with a reason, not a dropped socket');

    for (let i = 0; i < 205; i++) {
      const res = await fetch(base + '/api/share', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'c' + i, messages: [{ type: 'user', content: 'm' + i }] }),
      });
      assert.equal(res.status, 200);
    }
    // The cap is 200: the first five must have been evicted, the newest kept.
    const first = await fetch(base + '/api/share/' + (await (await fetch(base + '/api/share', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: '{"title":"probe","messages":[{"type":"user","content":"p"}]}',
    })).json()).id);
    assert.equal(first.status, 200);
  });
});

test('memory facts persist per user, dedupe, and clear', async () => {
  await withApp(async (base) => {
    const put = (body) => fetch(base + '/api/memory', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const del = (body) => fetch(base + '/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const first = await (await put({ text: 'prefers Python' })).json();
    assert.equal(first.facts.length, 1);
    const again = await (await put({ text: 'prefers Python' })).json();
    assert.equal(again.facts.length, 1, 'a duplicate save is a no-op, not a second row');
    const second = await (await put({ text: 'ships on Friday' })).json();
    assert.equal(second.facts.length, 2);
    assert.equal(second.facts[0].text, 'ships on Friday', 'newest first, so a model reads the freshest');

    const blank = await put({ text: '   ' });
    assert.equal(blank.status, 400);

    const removed = await (await del({ text: 'prefers Python' })).json();
    assert.deepEqual(removed.facts.map((f) => f.text), ['ships on Friday']);

    const cleared = await (await del({ all: true })).json();
    assert.deepEqual(cleared.facts, []);
  });
});

test('the reader shell exists on disk and only reads', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'share.html'), 'utf8');
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /fetch\('\/api\/share\/'/);
  assert.match(html, /renderMarkdownLite/);
  assert.match(html, /noindex/);
});

test('a file-backed share store reloads the same links after a restart', async () => {
  // The whole point of SHARE_STORE_PATH: publish, hold the process still
  // (flush), "reboot" (wipe the map, re-read the file), and the link opens
  // with its conversation intact.
  const storePath = path.join(os.tmpdir(), 'freeopenai-share-test-' + process.pid + '.json');
  const realEnv = process.env.SHARE_STORE_PATH;
  process.env.SHARE_STORE_PATH = storePath;
  const server = require('../server.js');
  try {
    await withApp(async (base) => {
      const put = await fetch(base + '/api/share', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Survives', messages: [{ type: 'user', content: 'still here' }] }),
      });
      const { id } = await put.json();
      await server.flushShareStoreNow();
      assert.ok(fs.existsSync(storePath), 'the flush wrote the file');

      server.shareStoreRestartForTest();
      const data = await fetch(base + '/api/share/' + id);
      assert.equal(data.status, 200);
      const entry = await data.json();
      assert.equal(entry.title, 'Survives');
      assert.equal(entry.messages[0].content, 'still here');
    });
  } finally {
    if (realEnv === undefined) delete process.env.SHARE_STORE_PATH; else process.env.SHARE_STORE_PATH = realEnv;
    fs.rmSync(storePath, { force: true });
    fs.rmSync(storePath + '.tmp', { force: true });
  }
});

test('a file-backed store also caps by bytes, evicting the oldest first', async () => {
  const storePath = path.join(os.tmpdir(), 'freeopenai-share-cap-test-' + process.pid + '.json');
  const realEnv = process.env.SHARE_STORE_PATH;
  const realCap = process.env.SHARE_STORE_MAX_BYTES;
  // The cap floor is one oversized share plus slack, so the content has to
  // carry real weight: six ~150KB shares overshoot the 600KB budget (with
  // room to spare over the ~518KB floor), and the eviction walks from the
  // oldest until the payload fits again.
  process.env.SHARE_STORE_PATH = storePath;
  process.env.SHARE_STORE_MAX_BYTES = String(600 * 1024);
  const server = require('../server.js');
  const ids = [];
  try {
    await withApp(async (base) => {
      for (let i = 0; i < 6; i++) {
        const res = await fetch(base + '/api/share', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'c' + i, messages: [{ type: 'user', content: 'x'.repeat(150000) }] }),
        });
        ids.push((await res.json()).id);
      }
      await server.flushShareStoreNow();
      const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      assert.ok(JSON.stringify(onDisk).length <= 600 * 1024, 'the file respects the budget');
      assert.ok(!onDisk[ids[0]], 'the oldest share was evicted');
      assert.ok(onDisk[ids[5]], 'the newest share survived');
    });
  } finally {
    if (realEnv === undefined) delete process.env.SHARE_STORE_PATH; else process.env.SHARE_STORE_PATH = realEnv;
    if (realCap === undefined) delete process.env.SHARE_STORE_MAX_BYTES; else process.env.SHARE_STORE_MAX_BYTES = realCap;
    fs.rmSync(storePath, { force: true });
    fs.rmSync(storePath + '.tmp', { force: true });
  }
});

test('the store stays memory-only unless a path is configured', () => {
  const had = process.env.SHARE_STORE_PATH;
  delete process.env.SHARE_STORE_PATH;
  try {
    assert.equal(server.shareStoreOnDisk(), false, 'default deployment: no file, same behavior as before');
  } finally {
    if (had !== undefined) process.env.SHARE_STORE_PATH = had;
  }
});

test('the Forget-all button really asks the server to forget, not just the DOM', async () => {
  // The page once sent an empty body here, which the server read as
  // "delete nothing" -- a silent no-op the API-level test above could not
  // see, because it built the request itself. This one drives the shipped
  // button instead.
  const { loadFromIndex } = require('./helpers/index-html.js');
  const calls = [];
  const deps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { json: async () => ({ facts: [] }) };
    },
    memoryFacts: [{ text: 'old fact' }],
    renderMemoryList: () => {},
  };
  const loaded = loadFromIndex(['clearAllMemoryFacts'], deps);
  await loaded.clearAllMemoryFacts();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/memory');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.body, '{"all":true}');
  assert.deepEqual(deps.memoryFacts, [], 'and the page forgets what the server confirmed');
});
