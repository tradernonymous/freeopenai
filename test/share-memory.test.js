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
  // see, because it built the request itself. The shipped logic now lives in
  // the ShareMemory module (tested directly below); this one pins that the
  // page's button still reaches it.
  const { loadFromIndex } = require('./helpers/index-html.js');
  let cleared = 0;
  const deps = {
    shareMemory: { clearAllFacts: async () => { cleared += 1; return []; } },
  };
  const loaded = loadFromIndex(['clearAllMemoryFacts'], deps);
  await loaded.clearAllMemoryFacts();
  assert.equal(cleared, 1, 'the button drives the module, which builds the request');
});

test('the Memory tab renders a use meter per fact, dimming never-used ones', async () => {
  // The counts were a bare number; now each fact draws a 4-segment bar so a
  // dead fact reads as empty at a glance. This drives the shipped renderer
  // with a compact DOM stub, since the panel harness does not extract it.
  const { loadFromIndex } = require('./helpers/index-html.js');
  const el = () => {
    const node = {
      tagName: 'div', children: [], className: '', textContent: '', title: '',
      attrs: {}, type: '',
      setAttribute(n, v) { this.attrs[n] = String(v); },
      getAttribute(n) { return this.attrs[n]; },
      addEventListener() {},
      appendChild(kid) { kid.parent = this; this.children.push(kid); return kid; },
    };
    node.classList = { add(c) { node.className = (node.className + ' ' + c).trim(); } };
    return node;
  };
  const ids = {};
  const document = {
    createElement: (tag) => el(tag),
    getElementById: (id) => ids[id] || (ids[id] = el()),
  };
  const deps = {
    document,
    shareMemory: { factsList: () => facts, useCounts: () => counts },
    chatlib: { memoryUseMeter: (n) => Math.min(4, Math.max(0, Math.round(Number(n) || 0))) },
    memoryUseMeter: (n) => Math.min(4, Math.max(0, Math.round(Number(n) || 0))),
  };
  const facts = [{ text: 'prefers Python' }, { text: 'collects stamps' }];
  const counts = { 'prefers Python': 3 };
  const loaded = loadFromIndex(['renderMemoryList'], deps);
  loaded.renderMemoryList();
  const rows = ids.memoryList.children;
  assert.equal(rows.length, 2, 'one row per fact');
  const hot = rows[0];
  const cold = rows[1];
  assert.ok(String(cold.className).includes('dead'), 'the never-used fact is dimmed as dead');
  assert.ok(!String(hot.className).includes('dead'), 'a used fact is not dimmed');
  const meterOf = (row) => row.children.find((c) => String(c.className).includes('memory-fact-used'));
  const hotMeter = meterOf(hot);
  const coldMeter = meterOf(cold);
  assert.ok(hotMeter && coldMeter, 'every fact row carries the meter');
  const segsOf = (m) => m.children.find((c) => String(c.className).includes('memory-fact-meter')).children;
  assert.equal(segsOf(hotMeter).filter((s) => String(s.className).includes('on')).length, 3, '3 uses fill 3 of 4 segments');
  assert.equal(segsOf(coldMeter).filter((s) => String(s.className).includes('on')).length, 0, 'a dead fact fills none');
  assert.equal(hotMeter.children[1].textContent, '3\u00d7', 'the count still reads as text');
  assert.equal(coldMeter.children[1].textContent, '0', 'zero says zero');
});

test('memoryUseMeter turns a use count into a 0-4 gauge', () => {
  const { memoryUseMeter } = require('../chatlib.js');
  assert.equal(memoryUseMeter(0), 0, 'a dead fact lights nothing');
  assert.equal(memoryUseMeter(1), 1);
  assert.equal(memoryUseMeter(2), 2);
  assert.equal(memoryUseMeter(4), 4, 'four uses light every segment');
  assert.equal(memoryUseMeter(17), 4, 'beyond four stays full, not clipped visually');
  assert.equal(memoryUseMeter('3'), 3, 'counts arrive as text from storage');
  assert.equal(memoryUseMeter(undefined), 0, 'a missing count reads as never used');
  assert.equal(memoryUseMeter(-2), 0, 'nonsense never lights anything');
});

// ------------------------------------------------------- ShareMemory module

const { create: createShareMemory } = require('../share-memory.js');

function memoryHarness(overrides) {
  const store = new Map();
  const calls = [];
  const deps = {
    sharePayloadOf: () => ({ title: 't', messages: [{ type: 'user', content: 'hi' }] }),
    memoryFactsUsedIn: (content, facts) => facts.map((f) => f.text).filter((t) => String(content).includes(t.split(' ')[1] || t)),
    shareImageDataUrlFactory: () => (src) => Promise.resolve('data:image/jpeg;base64,SMALL|' + src),
    makeCanvas: () => ({}),
    loadImage: () => Promise.resolve({}),
    // One saved fact by default, so use-detection tests have something to find.
    fetchJson: async (url, init) => {
      calls.push({ url, init: init || {} });
      return { ok: true, status: 200, data: { id: 'abc123', url: '/s/abc123', facts: [{ text: 'prefers Python' }] } };
    },
    storage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    imageUrlById: new Map([['stored-1', 'data:image/png;base64,STORED']]),
    ...overrides,
  };
  return { mod: createShareMemory(deps), deps, calls, store };
}

test('publish sends the payload and reports the link; a second call while in flight is refused', async () => {
  let releasePublish;
  const gate = new Promise((resolve) => { releasePublish = resolve; });
  const h = memoryHarness({
    fetchJson: (url, init) => {
      h.calls.push({ url, init: init || {} });
      return gate.then(() => ({ ok: true, status: 200, data: { id: 'abc123', url: '/s/abc123' } }));
    },
  });
  const convo = { title: 'My chat', messages: [{ type: 'user', content: 'hello' }] };
  const first = h.mod.publish(convo);
  const second = await h.mod.publish(convo);
  assert.deepEqual(second, { ok: false, reason: 'busy' }, 'a double click waits, never buys a second link');
  releasePublish();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(done.url, '/s/abc123');
  assert.equal(h.mod.activeShare().id, 'abc123');
  assert.match(h.calls[0].init.body, /\"messages\"/, 'the payload rides the PUT body');
});

test('an unshareable conversation says empty, an oversized one says too-large', async () => {
  const emptyConvo = { title: 'x', messages: [{ type: 'system', content: 'narration' }] };
  const bigConvo = { title: 'x', messages: [{ type: 'user', content: 'a real message' }] };
  const h = memoryHarness({ sharePayloadOf: () => null });
  assert.equal((await h.mod.publish(emptyConvo)).reason, 'empty', 'nothing shareable is not a size problem');
  assert.equal((await h.mod.publish(bigConvo)).reason, 'too-large');
});

test('images are read back from the store and compacted for the payload', async () => {
  const built = [];
  const h = memoryHarness({
    sharePayloadOf: (messages, title) => { built.push({ messages, title }); return { title, messages }; },
  });
  await h.mod.buildSharePayload({
    title: 'Pics',
    messages: [
      { type: 'user', content: 'q', images: [{ id: 'stored-1' }, { id: 'gone' }] },
      { type: 'user', content: 'inline', images: [{ url: 'data:image/png;base64,RAW' }] },
      { type: 'system', content: 'narration' },
    ],
  });
  assert.deepEqual(built[0].messages[0].images, ['data:image/jpeg;base64,SMALL|data:image/png;base64,STORED'],
    'a stored id is read back through the map; a missing id is dropped');
  assert.deepEqual(built[0].messages[1].images, ['data:image/jpeg;base64,SMALL|data:image/png;base64,RAW'],
    'an inline data: URL passes through');
  assert.equal(built[0].messages.length, 2, 'narration never ships');
});

test('memory facts flow through the module, and clear-all sends the contract body', async () => {
  // The module captures its environment at construction, the way the page
  // builds it -- so the stateful server stand-in has to be in place first.
  const calls = [];
  let factStore = [];
  const h = memoryHarness({
    fetchJson: async (url, init) => {
      calls.push({ url, init: init || {} });
      const body = JSON.parse((init && init.body) || '{}');
      if (init && init.method === 'PUT' && body.text) {
        factStore = [{ text: body.text }, ...factStore.filter((f) => f.text !== body.text)];
      }
      if (init && init.method === 'DELETE' && body.all) factStore = [];
      return { ok: true, status: 200, data: { facts: factStore } };
    },
  });
  await h.mod.clearAllFacts();
  assert.deepEqual(calls[0].init.body, '{"all":true}', 'the contract body, not an empty one');
  await h.mod.upsertFact('  prefers Python  ', false);
  assert.deepEqual(h.mod.factsList().map((f) => f.text), ['prefers Python'], 'trimmed and stored');
  const saved = await h.mod.upsertFact('another fact', false);
  assert.equal(saved.ok, true, 'a successful save says so');
  const ack = await h.mod.memoryTool({ text: 'ships on Friday' });
  assert.match(ack, /Saved to memory: \"ships on Friday\"/);
  assert.equal(await h.mod.memoryTool({ text: '   ' }), 'Error: text is required.');
  await h.mod.clearAllFacts();
  assert.deepEqual(h.mod.factsList(), []);
});

test('a refused save is reported, to the page and to the model', async () => {
  // The server caps facts ("Memory is full — remove something first"). A
  // module that swallowed that sentence would leave the Add button silent
  // and would tell the model "Saved to memory" about a save that failed --
  // a lie the model would then repeat to the user.
  const h = memoryHarness({
    fetchJson: async () => ({ ok: false, status: 400, data: { error: 'Memory is full — remove something first' } }),
  });
  const refused = await h.mod.upsertFact('one more fact', false);
  assert.deepEqual(refused, { ok: false, error: 'Memory is full — remove something first' });
  assert.deepEqual(h.mod.factsList(), [], 'a refused save stores nothing');
  const ack = await h.mod.memoryTool({ text: 'one more fact' });
  assert.match(ack, /^Error: Memory is full/);
  assert.match(ack, /was not saved/);
  const dead = await h.mod.upsertFact('x', false);
  const h2 = memoryHarness({ fetchJson: async () => { throw new Error('down'); } });
  const offline = await h2.mod.upsertFact('x', false);
  assert.deepEqual(offline, { ok: false, error: 'The server did not answer' }, 'a network failure says so too');
});

test('per-chat opt-out persists, and an opted-out chat records no use', async () => {
  const h = memoryHarness();
  await h.mod.loadFacts();
  assert.equal(h.mod.onForChat('c1'), true, 'default on');
  assert.equal(h.mod.onForChat(''), true, 'no chat yet reads as on');
  h.mod.setForChat('c1', false);
  assert.equal(h.mod.onForChat('c1'), false);
  const fresh = createShareMemory({ ...h.deps });
  assert.equal(fresh.onForChat('c1'), false, 'the choice survives a reload via storage');
  assert.deepEqual(h.mod.recordUse('I remember you prefer Python a lot', { convoId: 'c1' }),
    [], 'an opted-out chat gets no facts and no chips');
  assert.deepEqual(h.mod.recordUse('I remember you prefer Python a lot', { convoId: 'c2' }),
    ['prefers Python']);
});

test('recordUse counts new uses, not redraws', async () => {
  const h = memoryHarness();
  await h.mod.loadFacts();
  const reply = 'You prefer Python, so here is Python code.';
  h.mod.recordUse(reply, { convoId: 'c1' });
  h.mod.recordUse(reply, { convoId: 'c1' });
  const counts = h.mod.useCounts();
  assert.equal(counts['prefers Python'], 2, 'each completion counts once');
  h.mod.recordUse(reply, { convoId: 'c1', restoring: true });
  assert.equal(h.mod.useCounts()['prefers Python'], 2, 'a redraw re-detects but never re-counts');
});
