// NEURA-056, the wiring half: the index is only worth building if the coding
// agent actually spends it.
//
// project-scout.js is tested on its own in desktop-project-scout.test.js -- the
// walk, the caps, the digest. What is tested HERE is that runAgent uses it:
// the map reaches the system prompt before the first model call, find_symbol
// answers with paths and line numbers and never with file contents, a write
// makes the next answer say the map is stale, and a folder that cannot be
// indexed still runs the turn.
//
// Everything runs over a fake tree and a scripted model, so nothing here
// touches a filesystem or a network.
const test = require('node:test');
const assert = require('node:assert/strict');

const scout = require('../desktop/src/project-scout.js');
const agent = require('../desktop/src/coding-agent.js');

// ---- the fakes ------------------------------------------------------------

/** A memory store with localStorage's three methods, so save/load work. */
function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/**
 * The folder the agent's callbacks see: `files` is { 'rel/path': text }, and
 * directories are implied by the paths exactly as a real lister sees them.
 */
function fakeFolder(files) {
  const meta = new Map();
  for (const [path, text] of Object.entries(files)) {
    meta.set(path, { text: String(text), size: String(text).length, mtime: 1000 });
  }
  const listed = [];
  const read = [];

  const listFiles = async (root, dir) => {
    assert.equal(root, ROOT, 'the lister is always called with the session root');
    listed.push(dir);
    const prefix = dir ? `${dir}/` : '';
    const dirs = new Set();
    const entries = [];
    for (const path of meta.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const record = meta.get(path);
        entries.push({ name: rest, dir: false, size: record.size, mtime: record.mtime });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    for (const name of dirs) entries.push({ name, dir: true, size: 0 });
    return { entries };
  };

  const readFile = async (root, path) => {
    assert.equal(root, ROOT, 'the reader is always called with the session root');
    read.push(path);
    const record = meta.get(path);
    if (!record) throw new Error(`no such file: ${path}`);
    return { text: record.text, binary: false, bytes: record.size };
  };

  const writeFile = async (root, path, content) => {
    meta.set(path, { text: String(content), size: String(content).length, mtime: 2000 });
    return { path, bytes: String(content).length };
  };

  const editFile = async (root, path, oldText, newText) => {
    const record = meta.get(path);
    const next = String(record ? record.text : '').replace(oldText, newText);
    meta.set(path, { text: next, size: next.length, mtime: 2000 });
    return { path, replaced: 1, bytes: next.length };
  };

  return { meta, listed, read, listFiles, readFile, writeFile, editFile };
}

const ROOT = '/work/sample';

const FILES = {
  'package.json': '{"name":"sample"}',
  'README.md': '# Sample\n\n## Approval gate\n',
  'src/approval.js': [
    'export const GATE_KEY = "gate";',
    '',
    'export function approveRequest(request) {',
    '  return !!request;',
    '}',
    '',
    'class ApprovalQueue {',
    '  push() {}',
    '}',
  ].join('\n'),
  'src/index.js': 'export function boot() {\n  return 1;\n}\n',
};

/**
 * A model that replies with the scripted lines in order. The last line is
 * usually plain prose, which is how the agent learns the turn is over.
 */
function scriptedModel(replies) {
  const seen = [];
  let at = 0;
  const sendMessage = async (messages) => {
    seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
    const reply = at < replies.length ? replies[at] : 'All done.';
    at += 1;
    return reply;
  };
  return { sendMessage, seen, systemPromptOf: (turn) => seen[turn][0].content };
}

function toolCall(name, args) {
  return '```tool\n' + JSON.stringify({ name, args }) + '\n```';
}

/** A session pointed at the fake folder with the user's request as step 0. */
function session(request) {
  const s = agent.createSession(ROOT, 'test-model', 'test-provider');
  s.plan = [{ id: 0, title: request, status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
  return s;
}

/** project-scout is read off the global, exactly as CodeScreen provides it. */
function withScout(store, run) {
  const hadScout = globalThis.FreeAI4UProjectScout;
  const hadStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
    ? globalThis.localStorage : undefined;
  globalThis.FreeAI4UProjectScout = scout;
  globalThis.localStorage = store;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.FreeAI4UProjectScout = hadScout;
      if (hadStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = hadStorage;
    });
}

// ---- the tool is offered --------------------------------------------------

test('NEURA-056 wiring: find_symbol is a read-only tool the model is told about', () => {
  const tool = agent.TOOLS.find((t) => t.name === 'find_symbol');
  assert.ok(tool, 'find_symbol is in TOOLS');
  assert.ok(!tool.mutating, 'looking something up never needs approval');
  assert.ok(agent.systemPrompt().includes('find_symbol('), 'the prompt lists it with its signature');
});

// ---- the map reaches the prompt -------------------------------------------

test('NEURA-056 wiring: the first system prompt already carries the map', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  const model = scriptedModel(['Nothing to do here.']);
  await withScout(store, async () => {
    const events = [];
    await agent.runAgent(session('where is the approval gate?'), {
      sendMessage: model.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
      onEvent: (e) => events.push(e),
    });

    const prompt = model.systemPromptOf(0);
    assert.ok(prompt.includes('Project map'), 'the map block is in the prompt');
    assert.ok(prompt.includes('Entry points:'), 'the entry points are there before any tool call');
    assert.ok(prompt.includes('package.json'), 'the manifest is named as an entry point');
    assert.ok(prompt.includes('src'), 'the areas name the source directory');

    const building = events.filter((e) => e.type === 'index');
    assert.deepEqual(building.map((e) => e.state), ['building', 'ready'],
      'the UI is told the index is being built and then that it is ready');
    assert.ok(building[1].status.fileCount >= 4, 'the ready event carries the file count');

    // And the map was stored, so the next run does not walk the tree again.
    const stored = scout.load(ROOT, store);
    assert.ok(stored, 'the index was saved');
    assert.equal(stored.root, ROOT);
  });
});

test('NEURA-056 wiring: a saved, still-matching index is reused, not rebuilt', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  await withScout(store, async () => {
    const first = scriptedModel(['Done.']);
    await agent.runAgent(session('map it'), {
      sendMessage: first.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
    });
    const readsAfterBuild = folder.read.length;
    assert.ok(readsAfterBuild > 0, 'the build read files for symbols');

    const second = scriptedModel(['Done again.']);
    await agent.runAgent(session('map it again'), {
      sendMessage: second.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
    });
    // checkFresh walks names and sizes only; the project-notes probe is the
    // only reason the reader is touched at all on the second run.
    const extra = folder.read.slice(readsAfterBuild);
    assert.ok(extra.every((p) => /AGENTS\.md|CLAUDE\.md/.test(p)),
      `the second run re-read only the notes candidates, got ${JSON.stringify(extra)}`);
    assert.ok(second.systemPromptOf(0).includes('Project map'), 'and it still had the map');
  });
});

// ---- find_symbol answers with places, not contents ------------------------

test('NEURA-056 wiring: find_symbol answers path:line and never file contents', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  const model = scriptedModel([
    toolCall('find_symbol', { query: 'approveRequest' }),
    'Found it.',
  ]);
  await withScout(store, async () => {
    const steps = [];
    const done = await agent.runAgent(session('where is approveRequest?'), {
      sendMessage: model.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
      onEvent: (e) => { if (e.type === 'step') steps.push(e.step); },
    });

    const step = done.plan.find((s) => s.tool === 'find_symbol');
    assert.ok(step, 'the call ran');
    assert.equal(step.status, 'done');
    assert.match(step.result, /src\/approval\.js:3\s+function approveRequest/,
      `expected a path:line row, got:\n${step.result}`);
    // The index knows the file's text; the answer must not leak it.
    assert.ok(!step.result.includes('return !!request'), 'no file contents crossed the boundary');
    assert.ok(!step.result.includes('GATE_KEY = '), 'not even a one-line declaration body');
    assert.ok(step.result.includes('No parser'), 'the answer carries the regex-level caveat');
    // And the model got the same rows back, not a second read_file round trip.
    const fed = model.seen[1][model.seen[1].length - 1];
    assert.ok(fed.content.includes('src/approval.js:3'), 'the model was fed the location');
  });
});

test('NEURA-056 wiring: a name the index cannot see is admitted, not invented', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  const model = scriptedModel([toolCall('find_symbol', { query: 'somethingGenerated' }), 'Nothing there.']);
  await withScout(store, async () => {
    const done = await agent.runAgent(session('where is somethingGenerated?'), {
      sendMessage: model.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
    });
    const step = done.plan.find((s) => s.tool === 'find_symbol');
    assert.equal(step.status, 'done');
    assert.match(step.result, /No match in the index/);
    assert.match(step.result, /search the files directly/);
  });
});

// ---- staleness ------------------------------------------------------------

test('NEURA-056 wiring: a saved map that no longer matches the folder is rebuilt, not trusted', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  await withScout(store, async () => {
    const first = scriptedModel(['Mapped.']);
    await agent.runAgent(session('map it'), {
      sendMessage: first.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
    });

    // Someone else edits the folder between runs: same names, new sizes.
    folder.meta.set('src/approval.js', { text: 'export function approveRequest() {}\n', size: 36, mtime: 5000 });

    const stale = { ...scout.load(ROOT, store), digest: 'not-the-current-digest' };
    scout.save(stale, store);

    const second = scriptedModel([toolCall('find_symbol', { query: 'approveRequest' }), 'ok']);
    const done = await agent.runAgent(session('where is approveRequest?'), {
      sendMessage: second.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
    });
    const step = done.plan.find((s) => s.tool === 'find_symbol');
    // The run rebuilt rather than answering from the old map, and the rebuilt
    // map points at the new line.
    assert.match(step.result, /src\/approval\.js:1/, `expected the rebuilt line, got:\n${step.result}`);
  });
});

test('NEURA-056 wiring: a write marks the map stale for the next lookup', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  const model = scriptedModel([
    toolCall('write_file', { path: 'src/approval.js', content: 'export function approveRequest() {}\n' }),
    toolCall('find_symbol', { query: 'approveRequest' }),
    'Done.',
  ]);
  await withScout(store, async () => {
    const done = await agent.runAgent(session('rewrite the gate'), {
      sendMessage: model.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
      writeFile: folder.writeFile,
      // No onDecision: the approval is auto-approved below via the resolver.
      onDecision: (_id, resolve) => resolve({ approved: true }),
    });

    const wrote = done.plan.find((s) => s.tool === 'write_file');
    assert.equal(wrote.status, 'done', 'the write went through');

    const look = done.plan.find((s) => s.tool === 'find_symbol');
    assert.match(look.result, /^STALE INDEX: this session changed src\/approval\.js/,
      `expected the staleness warning first, got:\n${look.result}`);
    assert.match(look.result, /src\/approval\.js:3/, 'it still answers, from the pre-edit map it admits to');

    // The warning is durable: the stored index carries it too, so the next
    // session does not start by trusting a map this one invalidated.
    const stored = scout.load(ROOT, store);
    assert.equal(stored.stale, true);
    assert.match(stored.staleReason, /src\/approval\.js/);
  });
});

test('NEURA-056 wiring: an edit marks the map stale too', async () => {
  const store = memoryStore();
  const folder = fakeFolder(FILES);
  const model = scriptedModel([
    toolCall('edit_file', { path: 'src/index.js', old_text: 'return 1;', new_text: 'return 2;' }),
    'Done.',
  ]);
  await withScout(store, async () => {
    await agent.runAgent(session('bump it'), {
      sendMessage: model.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
      editFile: folder.editFile,
      onDecision: (_id, resolve) => resolve({ approved: true }),
    });
    const stored = scout.load(ROOT, store);
    assert.equal(stored.stale, true);
    assert.match(stored.staleReason, /src\/index\.js/);
  });
});

// ---- failure degrades, never crashes --------------------------------------

test('NEURA-056 wiring: a folder that cannot be listed still runs the turn', async () => {
  const store = memoryStore();
  const model = scriptedModel(['I will need to look around.']);
  await withScout(store, async () => {
    const events = [];
    const done = await agent.runAgent(session('do something'), {
      sendMessage: model.sendMessage,
      // scanTree survives an unreadable folder, so the failure that must be
      // survivable here is the one it cannot: a lister that is not there.
      listFiles: undefined,
      readFile: async () => { throw new Error('nope'); },
      onEvent: (e) => events.push(e),
    });
    assert.equal(done.status, 'done', 'the turn finished');
    assert.ok(!model.systemPromptOf(0).includes('Project map'), 'and simply had no map');
  });
});

test('NEURA-056 wiring: an indexing failure degrades to a readable note', async () => {
  const store = memoryStore();
  const model = scriptedModel([toolCall('find_symbol', { query: 'anything' }), 'ok']);
  const broken = {
    sendMessage: model.sendMessage,
    listFiles: async () => { throw new Error('the disk went away'); },
    readFile: async () => { throw new Error('the disk went away'); },
  };
  await withScout(store, async () => {
    // A lister that always throws: scanTree swallows it, so the index comes out
    // empty rather than failing -- and an empty map must still be honest.
    const done = await agent.runAgent(session('where is anything?'), broken);
    assert.equal(done.status, 'done');
    const step = done.plan.find((s) => s.tool === 'find_symbol');
    assert.equal(step.status, 'done', 'find_symbol answered instead of throwing');
    assert.match(step.result, /No index has been built|No match in the index|No project index/);
  });
});

test('NEURA-056 wiring: without project-scout loaded, nothing changes', async () => {
  const folder = fakeFolder(FILES);
  const model = scriptedModel([toolCall('find_symbol', { query: 'approveRequest' }), 'ok']);
  const had = globalThis.FreeAI4UProjectScout;
  delete globalThis.FreeAI4UProjectScout;
  try {
    const done = await agent.runAgent(session('where is approveRequest?'), {
      sendMessage: model.sendMessage,
      listFiles: folder.listFiles,
      readFile: folder.readFile,
    });
    assert.ok(!model.systemPromptOf(0).includes('Project map'), 'no map block');
    const step = done.plan.find((s) => s.tool === 'find_symbol');
    assert.equal(step.status, 'done');
    assert.match(step.result, /No project index has been built/);
    assert.match(step.result, /list_files and read_file/, 'and it says what to do instead');
  } finally {
    if (had === undefined) delete globalThis.FreeAI4UProjectScout;
    else globalThis.FreeAI4UProjectScout = had;
  }
});

// ---- the pieces the screen uses -------------------------------------------

test('NEURA-056 wiring: scoutIO binds the session root to the agent callbacks', async () => {
  const folder = fakeFolder(FILES);
  const io = agent.scoutIO({ listFiles: folder.listFiles, readFile: folder.readFile }, ROOT);
  const listing = await io.listFiles('');
  assert.ok(listing.entries.some((e) => e.name === 'package.json'));
  const file = await io.readFile('package.json');
  assert.equal(file.text, FILES['package.json']);
  assert.equal(agent.scoutIO({}, ROOT), null, 'no lister, no I/O');
});

test('NEURA-056 wiring: renderMatches prints places and nothing else', () => {
  const answer = {
    ok: true,
    query: 'boot',
    matches: [{ path: 'src/index.js', line: 1, name: 'boot', kind: 'function', exported: true, score: 12, why: 'symbol' }],
    note: 'a caveat',
    stale: false,
    staleReason: '',
  };
  const text = agent.renderMatches(answer);
  assert.equal(text.split('\n')[0], 'src/index.js:1  function boot');
  assert.ok(text.includes('a caveat'));
  assert.ok(agent.renderMatches(null).includes('No project index'));
});
