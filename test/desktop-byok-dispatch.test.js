// NEURA-054 -- where a BYOK model is actually answered.
//
// byok.js can talk to the user's endpoint and ModelPicker can offer it, but
// neither of those decides anything: a chat turn reaches a provider because
// some `if` in a dispatcher said so. Until the branch exists, picking one of
// your own models quietly reaches the engine instead -- which has never heard
// of the provider id `byok`, so the answer comes back wrong or not at all.
//
// These tests hold the three dispatchers to the branch, and hold the branch
// itself to the two rules that make it safe: a model that is no longer in the
// list is an ERROR (never a fall-through to another provider), and what
// crosses the bridge is the secret's NAME, never a key.
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
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, String(v)),
    removeItem: (k) => rows.delete(k),
  };
}

/** A stand-in for bridge.ts's { byokStream }: it records, it never sees a key. */
function fakeShell(script) {
  const calls = [];
  return {
    calls,
    byokStream: async (args, onChunk, onStatus, signal) => {
      calls.push({ args, signal });
      await (script || (async () => {}))(onChunk, onStatus, signal);
    },
  };
}

function seeded() {
  const store = memoryStorage();
  const added = byok.add({ label: 'Mine', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }, store);
  assert.equal(added.ok, true);
  return { store, entry: added.entry };
}

// ---- the discriminator ----------------------------------------------------

test('only the byok provider id resolves to an endpoint; every other provider is left alone', () => {
  const { store, entry } = seeded();
  assert.equal(byok.PROVIDER_ID, 'byok');
  assert.equal(byok.findByModel(byok.PROVIDER_ID, 'gpt-4o-mini', store).id, entry.id);
  // The providers the other branches own, plus the engine's own ids: none of
  // them may be claimed here, or a Groq model would be sent to someone's key.
  for (const other of ['hf', 'local', 'ollama-local', 'unsloth-local', 'groq', 'cerebras', '']) {
    assert.equal(byok.findByModel(other, 'gpt-4o-mini', store), null, other + ' is not a BYOK provider');
  }
});

test('a model that is no longer in the list is an error, not a fall-through', async () => {
  const { store } = seeded();
  const missing = byok.findByModel(byok.PROVIDER_ID, 'a-model-that-was-deleted', store);
  assert.equal(missing, null);

  const shell = fakeShell();
  await assert.rejects(
    () => byok.streamChat(missing, [{ role: 'user', content: 'hi' }], () => {}, undefined, shell),
    (err) => {
      assert.match(err.message, /no longer in your list/i, 'the refusal is a sentence, not "invalid"');
      return true;
    },
  );
  assert.equal(shell.calls.length, 0, 'nothing was sent anywhere');
});

// ---- what the branch hands the bridge --------------------------------------

test('the dispatched call carries the secret NAME, the frames, and the abort signal', async () => {
  const { store, entry } = seeded();
  const controller = new AbortController();
  const shell = fakeShell(async (onChunk, onStatus) => {
    onStatus(200);
    onChunk('data: {"choices":[{"delta":{"content":"he"}}]}\n');
    onChunk('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n');
  });

  const frames = [];
  await byok.streamChat(
    byok.findByModel(byok.PROVIDER_ID, 'gpt-4o-mini', store),
    [{ role: 'user', content: 'hi' }],
    (frame) => frames.push(frame),
    controller.signal,
    shell,
    [{ type: 'function', function: { name: 'read_file' } }],
  );

  assert.equal(shell.calls.length, 1);
  const { args, signal } = shell.calls[0];
  assert.equal(args.secret, byok.secretName(entry.id), 'the NAME of the credential-store entry');
  assert.equal(args.base, 'https://api.example.com/v1');
  assert.equal(signal, controller.signal, 'Stop reaches the endpoint like any other provider');
  assert.equal(JSON.stringify(shell.calls[0]).includes(SECRET), false, 'no key crosses the bridge');
  const body = JSON.parse(args.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.stream, true);
  assert.equal(body.tools[0].function.name, 'read_file', 'offered tools ride as `tools`, as elsewhere');
  assert.equal(frames.map((f) => f.content || '').join(''), 'hello');
});

test('an already-aborted turn fails as an abort, not as an endpoint error', async () => {
  const { store } = seeded();
  const controller = new AbortController();
  controller.abort();
  const shell = fakeShell(async (onChunk, onStatus, signal) => {
    if (signal && signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
  });
  await assert.rejects(
    () => byok.streamChat(byok.findByModel(byok.PROVIDER_ID, 'gpt-4o-mini', store), [], () => {}, controller.signal, shell),
    (err) => err.name === 'AbortError',
  );
});

// ---- the dispatchers themselves --------------------------------------------

test('streamAny routes a byok target to the endpoint and everything else as before', () => {
  const src = read('desktop', 'src', 'stream-any.ts');
  assert.match(src, /const byok: typeof import\('\.\/byok\.js'\)/);
  assert.match(
    src,
    /if \(target\.provider === byok\.PROVIDER_ID\) \{\s*return byok\.streamChat\(byok\.findByModel\(target\.provider, target\.model\), messages, onFrame, signal, \{ byokStream \}\);/,
    'Quick, Compare and Evals reach the endpoint through the same one switch',
  );
  // The branches that were already there still are, and the engine is still
  // the last word rather than the first.
  assert.match(src, /isSavedProvider\(target\.provider\)/);
  assert.match(src, /target\.provider === 'hf'/);
  assert.ok(
    src.indexOf('byok.PROVIDER_ID') < src.indexOf('return streamChat(target.provider'),
    'the byok branch comes before the engine fall-through',
  );
});

test('chat’s turn streamer and its retry both know the user’s endpoints', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /import \{ byokStream, hasShell/, 'the bridge call, not a key');
  assert.match(chat, /const byok: typeof import\('\.\.\/byok\.js'\)/);

  // runTurn's streamer: tools ride along, so an endpoint answers a tool turn.
  assert.match(
    chat,
    /if \(provider === byok\.PROVIDER_ID\) \{\s*return byok\.streamChat\(byok\.findByModel\(provider, model\), messages, onFrame, signal, \{ byokStream \}, offered\);/,
  );
  // "try again" / "try another model" takes the same road.
  assert.match(
    chat,
    /\} else if \(provider === byok\.PROVIDER_ID\) \{\s*await byok\.streamChat\(byok\.findByModel\(provider, model\), turns, \(frame\) => \{/,
  );
  // The picker's list for this provider is the user's own, never the engine's.
  assert.match(chat, /if \(active\.provider === byok\.PROVIDER_ID\) \{\s*const own = byok\.modelsFor\(active\.provider\);/);

  // Nothing above displaced what was there: hf, my models, local and the
  // engine all still decide first or last exactly as they did.
  for (const kept of [/if \(provider === 'hf'\)/, /if \(isSavedProvider\(provider\)\)/, /if \(provider === 'local'\)/]) {
    assert.match(chat, kept);
  }
  assert.match(chat, /await streamChat\(active\.provider, \{ model, messages: turns \}/, 'the engine is still the else');
});

test('no dispatcher can name, read or pass an API key', () => {
  for (const file of [['desktop', 'src', 'stream-any.ts'], ['desktop', 'src', 'screens', 'ChatScreen.tsx']]) {
    const src = read(...file);
    assert.equal(/byok[A-Za-z]*\.(key|apiKey|token)\b/.test(src), false, file.join('/') + ' reads no key');
    assert.equal(/secretGet\s*\(/.test(src), false, file.join('/') + ' never fetches a secret back into the page');
  }
});
