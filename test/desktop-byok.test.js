// NEURA-054 -- bring your own key.
//
// The promise this feature makes is narrow and testable: the user's API key
// lives in the OS credential store, is read per call on the Rust side, and
// NEVER exists in the page -- not in localStorage, not in a module, not in a
// URL, not in a log, not in diagnostics. These tests hold the code to that,
// plus the address rule (https, or http only on this machine) and the rule
// that deleting an endpoint deletes its key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const byok = require('../desktop/src/byok.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const SECRET = 'sk-live-do-not-leak-0123456789';

function memoryStorage() {
  const rows = new Map();
  return {
    rows,
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, String(v)),
    removeItem: (k) => rows.delete(k),
    /** Everything this page would persist, as one string. */
    dump: () => JSON.stringify([...rows.entries()]),
  };
}

/** A stand-in for bridge.ts: the credential store lives on the other side. */
function fakeShell() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    secretSet: async (name, value) => { calls.push(['set', name]); store.set(name, value); },
    secretDelete: async (name) => { calls.push(['delete', name]); store.delete(name); },
    byokStream: async (args, onChunk, onStatus) => {
      calls.push(['stream', args.secret, args.base]);
      // The shell is handed a NAME, never a value: assert it here, since this
      // is the exact boundary the feature is about.
      assert.ok(!JSON.stringify(args).includes(SECRET), 'the key must not cross into the shell call');
      onStatus?.(200);
      onChunk('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
      onChunk('data: [DONE]\n');
    },
  };
}

// ---- the address rule -----------------------------------------------------

test('a plain-http endpoint is refused, and the refusal says why', () => {
  const refused = byok.validateBaseUrl('http://api.example.com/v1');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /http is refused for api\.example\.com/);
  assert.match(refused.reason, /clear text/, 'the reason names the actual risk');
  assert.equal(refused.url, '', 'a refused URL is not handed back half-accepted');
});

test('https anywhere, http only for a runtime on this machine', () => {
  assert.equal(byok.validateBaseUrl('https://api.example.com/v1/').url, 'https://api.example.com/v1');
  assert.equal(byok.validateBaseUrl('http://127.0.0.1:8080/v1').ok, true);
  assert.equal(byok.validateBaseUrl('http://localhost:8080/v1').ok, true);
  assert.equal(byok.validateBaseUrl('http://[::1]:8080/v1').ok, true);
  assert.equal(byok.validateBaseUrl('http://127.0.0.1.evil.com/v1').ok, false, 'not this machine');
  assert.equal(byok.validateBaseUrl('ftp://api.example.com').ok, false);
  assert.equal(byok.validateBaseUrl('api.example.com/v1').ok, false, 'no scheme');
  assert.equal(byok.validateBaseUrl('').ok, false);
});

test('every refusal is a sentence a person can act on', () => {
  for (const bad of ['', 'api.example.com', 'ftp://x.example', 'http://api.example.com', 'https://u:p@api.example.com', 'https://api.example.com/v1?key=sk-1']) {
    const result = byok.validateBaseUrl(bad);
    assert.equal(result.ok, false, `${bad} is refused`);
    assert.ok(result.reason.length > 20 && /[.!]$/.test(result.reason), `${bad} says why: ${result.reason}`);
  }
});

test('a key can never be talked into the URL', () => {
  assert.match(byok.validateBaseUrl('https://user:sk-live@api.example.com/v1').reason, /user:password/);
  assert.match(byok.validateBaseUrl('https://api.example.com/v1?api_key=sk-live').reason, /never travel in a URL/);
  assert.equal(byok.validateBaseUrl('https://api.example.com/v1#sk-live').ok, false);
});

test('the chat URL is the OpenAI one, built from the base only', () => {
  assert.equal(byok.chatUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
});

// ---- the key is never in the page ----------------------------------------

test('adding an endpoint stores the key in the credential store and nothing else', async () => {
  const store = memoryStorage();
  const shell = fakeShell();
  const added = byok.add({ label: 'Example', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }, store);
  assert.equal(added.ok, true);
  const saved = await byok.saveKey(added.entry.id, SECRET, shell);
  assert.equal(saved.ok, true, saved.reason);

  // The credential store has it...
  assert.equal(shell.store.get(byok.secretName(added.entry.id)), SECRET);
  // ...and everything the page persists does not.
  assert.ok(!store.dump().includes(SECRET), 'the key is not in localStorage');
  assert.ok(!store.dump().includes('sk-live'), 'not even a fragment of it');
  const row = byok.list(store)[0];
  assert.deepEqual(Object.keys(row).sort(), ['addedAt', 'baseUrl', 'id', 'label', 'model']);
  assert.ok(!JSON.stringify(row).includes(SECRET));
  // Nothing the module returns carries a key, and there is no way to ask.
  assert.equal(typeof byok.keyFor, 'undefined');
  assert.ok(!JSON.stringify(saved).includes(SECRET), 'the answer does not echo the key');
});

test('a stored endpoint that somehow carries a key is dropped, not repaired', () => {
  const store = memoryStorage();
  store.setItem(byok.STORE_KEY, JSON.stringify([
    { id: 'hand-edited', label: 'x', baseUrl: 'https://api.example.com/v1', model: 'm', addedAt: 1, key: SECRET },
  ]));
  assert.deepEqual(byok.list(store), [], 'an entry with a credential on it is not an entry this app keeps');
});

test('a key with a line break or a space is refused before it is stored', async () => {
  const shell = fakeShell();
  assert.equal(byok.validateKey('').ok, false);
  assert.equal(byok.validateKey('sk-live abc').ok, false);
  assert.equal(byok.validateKey('sk-live\n').ok, false);
  const refused = await byok.saveKey('an-id', 'sk-live abc', shell);
  assert.equal(refused.ok, false);
  assert.equal(shell.store.size, 0, 'nothing was stored');
  assert.ok(!refused.reason.includes('sk-live'), 'the refusal does not quote the key back');
});

test('the streaming call hands the shell the secret NAME, never the key', async () => {
  const store = memoryStorage();
  const shell = fakeShell();
  const added = byok.add({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }, store);
  await byok.saveKey(added.entry.id, SECRET, shell);
  const frames = [];
  await byok.streamChat(added.entry, [{ role: 'user', content: 'hi' }], (f) => frames.push(f), undefined, shell);
  const streamed = shell.calls.find((c) => c[0] === 'stream');
  assert.equal(streamed[1], byok.secretName(added.entry.id));
  assert.equal(streamed[2], 'https://api.example.com/v1');
  assert.deepEqual(frames.map((f) => f.content).filter(Boolean), ['hi']);
});

test('a failing turn explains the status without quoting a credential', async () => {
  const store = memoryStorage();
  const shell = fakeShell();
  const added = byok.add({ baseUrl: 'https://api.example.com/v1', model: 'm' }, store);
  shell.byokStream = async (_args, onChunk, onStatus) => {
    onStatus(401);
    onChunk('{"error":{"message":"Incorrect API key provided"}}');
  };
  await assert.rejects(
    () => byok.streamChat(added.entry, [], () => {}, undefined, shell),
    (err) => {
      assert.match(err.message, /refused the key \(401\)/);
      assert.ok(!err.message.includes(SECRET));
      return true;
    },
  );
});

test('without a shell the page refuses instead of falling back to fetch', async () => {
  const entry = { id: 'x', label: 'x', baseUrl: 'https://api.example.com/v1', model: 'm', addedAt: 1 };
  await assert.rejects(() => byok.streamChat(entry, [], () => {}, undefined, null), /installed desktop app/);
  const noStore = await byok.saveKey('x', SECRET, null);
  assert.equal(noStore.ok, false);
  assert.match(noStore.reason, /credential manager/);
});

// ---- deleting -------------------------------------------------------------

test('deleting an endpoint deletes its stored key', async () => {
  const store = memoryStorage();
  const shell = fakeShell();
  const added = byok.add({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }, store);
  await byok.saveKey(added.entry.id, SECRET, shell);
  assert.equal(shell.store.size, 1);

  const gone = await byok.remove(added.entry.id, shell, store);
  assert.equal(gone.ok, true, gone.reason);
  assert.equal(shell.store.size, 0, 'the credential store entry went with it');
  assert.deepEqual(byok.list(store), []);
});

test('a key the credential store will not delete keeps the endpoint visible', async () => {
  const store = memoryStorage();
  const shell = fakeShell();
  const added = byok.add({ baseUrl: 'https://api.example.com/v1', model: 'm' }, store);
  await byok.saveKey(added.entry.id, SECRET, shell);
  shell.secretDelete = async () => { throw new Error('the credential manager is locked'); };

  const gone = await byok.remove(added.entry.id, shell, store);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /could not be removed/);
  assert.equal(byok.list(store).length, 1, 'a row nobody can see is a key nobody can remove');
});

test('removing something that is not there says so', async () => {
  const store = memoryStorage();
  const gone = await byok.remove('nope', fakeShell(), store);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /not in your list/);
});

// ---- the list, and the picker's rows --------------------------------------

test('the same endpoint and model is not added twice', () => {
  const store = memoryStorage();
  byok.add({ baseUrl: 'https://api.example.com/v1', model: 'm' }, store);
  const again = byok.add({ baseUrl: 'https://api.example.com/v1/', model: 'm' }, store);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already in your list/);
  assert.equal(byok.list(store).length, 1);
});

test('ids are unique and made only of the characters the credential store allows', () => {
  const store = memoryStorage();
  const a = byok.add({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }, store);
  const b = byok.add({ baseUrl: 'https://api.example.com/v2', model: 'gpt-4o-mini' }, store);
  assert.notEqual(a.entry.id, b.entry.id);
  for (const row of byok.list(store)) {
    assert.match(row.id, /^[a-z0-9._-]{1,64}$/);
    assert.match(byok.secretName(row.id), /^byok\.[a-z0-9._-]{1,64}$/);
  }
});

test('no provider row until there is an endpoint, then one with its models', () => {
  const store = memoryStorage();
  assert.equal(byok.providerRow(store), null);
  byok.add({ label: 'Example', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }, store);
  assert.equal(byok.providerRow(store).id, byok.PROVIDER_ID);
  assert.deepEqual(byok.modelsFor(byok.PROVIDER_ID, store), [{ id: 'gpt-4o-mini', free: 'Example' }]);
  assert.deepEqual(byok.modelsFor('hf', store), []);
  assert.equal(byok.findByModel(byok.PROVIDER_ID, 'gpt-4o-mini', store).baseUrl, 'https://api.example.com/v1');
  assert.equal(byok.findByModel('hf', 'gpt-4o-mini', store), null);
});

// ---- the code itself ------------------------------------------------------

test('the frontend never reads a key back out of the shell', () => {
  const source = read('desktop', 'src', 'byok.js');
  assert.ok(!/secretGet|secret_get/.test(source), 'byok.js has no way to read a stored key');
  const picker = read('desktop', 'src', 'components', 'ModelPicker.tsx');
  assert.ok(!/secretGet/.test(picker), 'the picker has no way to read a stored key either');
  assert.ok(!/localStorage\s*[.[]/.test(picker), 'the picker touches no storage itself');
  // The key field is a password field that the webview will not remember.
  assert.match(picker, /type="password"/);
  assert.match(picker, /autoComplete="off"/);
  // It is cleared the moment the credential store has it.
  assert.match(picker, /setKey\(''\)/);
});

test('nothing logs the key', () => {
  for (const file of [['desktop', 'src', 'byok.js'], ['desktop', 'src', 'components', 'ModelPicker.tsx']]) {
    const source = read(...file);
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(source), `${file.join('/')} logs nothing`);
  }
});

test('the request is made in Rust, because that is where the key is', () => {
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /byok_chat_stream/);
  assert.ok(!/byokStream[\s\S]{0,600}apiKey/.test(bridge), 'the BYOK wrapper takes no key argument');
  const rust = read('desktop', 'src-tauri', 'src', 'byok.rs');
  assert.match(rust, /secrets::read/, 'the shell reads the key itself');
  assert.match(rust, /redirect::Policy::none/, 'a redirect must not carry the Authorization header away');
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /byok::byok_chat_stream/);
  assert.match(main, /byok::byok_chat_cancel/);
});

test('the credential store names BYOK keys the same way on both sides', () => {
  const rust = read('desktop', 'src-tauri', 'src', 'secrets.rs');
  const prefix = /BYOK_PREFIX: &str = "([^"]+)"/.exec(rust);
  assert.ok(prefix, 'secrets.rs declares the prefix');
  assert.equal(prefix[1], byok.SECRET_PREFIX, 'byok.js and secrets.rs agree on the prefix');
  assert.equal(byok.secretName('api-example-com-m'), 'byok.api-example-com-m');
});

test('byok.js publishes its global the way the bundle loads it', () => {
  // The bundle leaves a `module` in scope; a UMD wrapper that takes the
  // CommonJS branch only would never publish the global, and the picker would
  // read undefined (see test/desktop-umd.test.js for the bug this repeats).
  const vm = require('node:vm');
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('desktop', 'src', 'byok.js'), sandbox, { filename: 'byok.js' });
  assert.ok(sandbox.FreeAI4UByok, 'FreeAI4UByok was not published');
  assert.equal(typeof sandbox.FreeAI4UByok.streamChat, 'function');
});

test('diagnostics never learn about an endpoint key', () => {
  const diag = read('desktop', 'src-tauri', 'src', 'diag.rs');
  assert.ok(!/byok/i.test(diag), 'the diagnostics facts do not touch the BYOK secrets');
  const crash = read('desktop', 'src-tauri', 'src', 'crash.rs');
  assert.ok(!/byok/i.test(crash), 'a crash log does not touch them either');
});
