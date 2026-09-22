// The fixes from the first EXE review:
//   * Hugging Face sign-in did nothing: the OAuth app is gone (invalid_client)
//     and the failure died in CORS. It is a checked access token now.
//   * GitHub looked unconnected after sign-in: the account cookie was Lax
//     (server side, test/desktop-cors.test.js), "another account" never asked
//     GitHub for the chooser, and every shell event arrived wrapped, so the
//     "finished" signal -- and Ollama's streamed replies -- never matched.
//   * One "Auto" context for every local model: now per model, sized to the
//     machine and capped at what the model was trained for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// CRLF on a Windows checkout would break the slicing below.
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

function memoryStore() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

// ---- Hugging Face ----------------------------------------------------------------

test('the token page opens with the Inference Providers permission ticked', () => {
  const hfAuth = require('../desktop/src/hf-auth.js');
  assert.match(hfAuth.TOKEN_PAGE, /^https:\/\/huggingface\.co\/settings\/tokens\/new\?/);
  assert.match(hfAuth.TOKEN_PAGE, /ownUserPermissions=inference\.serverless\.write/);
});

test('a pasted token is checked before it is kept', async () => {
  const hfAuth = require('../desktop/src/hf-auth.js');
  const store = memoryStore();
  const saved = globalThis.localStorage;
  globalThis.localStorage = store;
  try {
    await assert.rejects(hfAuth.useToken('not-a-token', async () => { throw new Error('must not be called'); }), /start with hf_/);
    const refuse = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(hfAuth.useToken('hf_' + 'a'.repeat(30), refuse), /refused/);
    const readOnly = async () => ({ ok: true, status: 200, json: async () => ({ name: 'x', auth: { accessToken: { fineGrained: { global: ['discussion.write'], scoped: [] } } } }) });
    await assert.rejects(hfAuth.useToken('hf_' + 'b'.repeat(30), readOnly), /Inference Providers/);
    assert.equal(store.getItem(hfAuth.TOKEN_KEY), null, 'nothing is stored for a refused token');
    const good = async (url, init) => {
      assert.match(url, /whoami-v2/);
      assert.match(init.headers.Authorization, /^Bearer hf_c/);
      return { ok: true, status: 200, json: async () => ({ name: 'printezy', auth: { accessToken: { fineGrained: { global: ['inference.serverless.write'] } } } }) };
    };
    const who = await hfAuth.useToken('  hf_' + 'c'.repeat(30) + ' ', good);
    assert.equal(who.name, 'printezy');
    assert.equal(hfAuth.accessToken().access_token, 'hf_' + 'c'.repeat(30), 'trimmed and kept');
    assert.equal(hfAuth.accessToken().source, 'pat');
    hfAuth.signOut();
  } finally {
    globalThis.localStorage = saved;
  }
});

test('every Hugging Face sign-in button is the token flow, not the dead device code', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  const library = read('desktop', 'src', 'screens', 'LibraryScreen.tsx');
  const connectors = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  for (const [name, src] of [['ChatScreen', chat], ['LibraryScreen', library], ['ConnectorsCard', connectors]]) {
    assert.match(src, /<HfSignIn/, `${name} uses the shared sign-in`);
    assert.ok(!/startDeviceCode\(/.test(src), `${name} no longer starts a device code`);
  }
  const box = read('desktop', 'src', 'components', 'HfSignIn.tsx');
  assert.match(box, /hfAuth\.useToken\(/);
  assert.match(box, /openUrl\(hfAuth\.TOKEN_PAGE\)/);
  assert.match(box, /type="password"/, 'the token is not shown on screen');
});

// ---- shell events ---------------------------------------------------------------

test('shell events are unwrapped, and unlisten uses the id listen returned', () => {
  const bridge = read('desktop', 'src', 'bridge.ts');
  const body = bridge.slice(bridge.indexOf('async function subscribe<T>'), bridge.indexOf('export function onLocalDownload'));
  assert.match(body, /'payload' in message && 'event' in message/);
  assert.match(body, /message\.payload/);
  assert.match(body, /eventId = await call\('plugin:event\|listen'/);
  assert.match(body, /eventId \}\)/);
  assert.ok(!/eventId: id/.test(bridge), 'the callback id is never passed to unlisten');
  assert.match(bridge, /export async function onLocalRun[\s\S]{0,120}subscribe<LocalRunChunk>/, 'no second copy of the listener');
});

// ---- GitHub -----------------------------------------------------------------------

test('GitHub sign-in asks as the desktop, and for the chooser when adding', () => {
  const card = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  assert.match(card, /authorize\?client=desktop\$\{adding \? '&add=1' : ''\}/);
  assert.match(card, /const adding = accounts\.length > 0/);
  assert.match(card, /refreshGithub\(true\)/, 'Refresh says what it found');
  assert.match(card, /landingNote\(landed\)/);
  const rust = read('desktop', 'src-tauri', 'src', 'net.rs');
  assert.match(rust, /next\.query\(\)/, 'the landing query reaches the app');
});

test('the landing note reads "GitHub gave back the same account"', () => {
  // The helper is in a .tsx file; its logic is small enough to check directly.
  const card = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  const fn = card.slice(card.indexOf('export function landingNote'), card.indexOf('\n}\n', card.indexOf('export function landingNote')) + 2);
  const js = fn.replace(/export function landingNote\(landed: string\): \{ same: boolean; login: string \}/, 'function landingNote(landed)');
  const landingNote = new Function(`${js}; return landingNote;`)();
  assert.deepEqual(landingNote('/?view=settings&gh=same&login=octo'), { same: true, login: 'octo' });
  assert.deepEqual(landingNote('/?view=settings'), { same: false, login: '' });
  assert.deepEqual(landingNote(''), { same: false, login: '' });
});

// ---- context window per model --------------------------------------------------

const run = require('../desktop/src/run-settings.js');
const GB = 1024 ** 3;

test("Ollama's /api/show gives the trained context and the cache cost", () => {
  const limits = run.parseOllamaShow({
    model_info: {
      'general.architecture': 'qwen3',
      'qwen3.context_length': 40960,
      'qwen3.block_count': 36,
      'qwen3.attention.head_count': 32,
      'qwen3.attention.head_count_kv': 8,
      'qwen3.attention.key_length': 128,
      'qwen3.attention.value_length': 128,
      'qwen3.embedding_length': 4096,
    },
  });
  assert.equal(limits.trainCtx, 40960);
  assert.equal(limits.kvBytesPerToken, 36 * 8 * 256 * 2);
  assert.deepEqual(run.parseOllamaShow({}), { source: 'ollama' });
  assert.equal(run.parseLlamaModels({ data: [{ meta: { n_ctx_train: 131072 } }] }).trainCtx, 131072);
  assert.equal(run.parseLlamaModels({}).trainCtx, undefined);
});

test('Auto fits the machine and never passes the model', () => {
  const small = { trainCtx: 4096 };
  assert.equal(run.autoCtx(small, { bytes: 1 * GB }, { ramGb: 64 }), 4096, 'capped at the trained context');
  const big = { trainCtx: 262144, kvBytesPerToken: 128 * 1024 };
  assert.equal(run.autoCtx(big, { bytes: 1 * GB }, { ramGb: 64 }), run.AUTO_CAP, 'a huge model is not given 262k by default');
  // 16 GB RAM (12.8 usable), 9 GB of weights, 128 KiB per token: 16k fits, 32k does not.
  assert.equal(run.autoCtx(big, { bytes: 9 * GB }, { ramGb: 16 }), 16384);
  // The weights fit a 4 GB card, so the cache is held to it too.
  assert.equal(run.autoCtx(big, { bytes: 2.5 * GB, gpuLayers: -1 }, { ramGb: 16, vramGb: 4 }), 8192);
  // CPU-only ignores the card.
  assert.equal(run.autoCtx(big, { bytes: 2.5 * GB, gpuLayers: 0 }, { ramGb: 16, vramGb: 4 }), run.AUTO_CAP);
  // Nothing fits: the smallest step, not zero.
  assert.equal(run.autoCtx(big, { bytes: 40 * GB }, { ramGb: 16 }), run.CTX_STEPS[0]);
});

test("a picked size is honoured up to the model's maximum, and the slider stops there", () => {
  assert.equal(run.effectiveCtx({ ctx: 65536 }, { trainCtx: 32768 }), 32768);
  assert.equal(run.effectiveCtx({ ctx: 8192 }, { trainCtx: 32768 }), 8192);
  assert.equal(run.effectiveCtx({ ctx: 8192 }, null), 8192);
  assert.deepEqual(run.ctxSteps({ trainCtx: 40960 }), [0, 2048, 4096, 8192, 16384, 32768, 40960]);
  assert.equal(run.ctxSteps(null).length, run.CTX_STEPS.length + 1);
  const store = memoryStore();
  run.setLimits('ollama:qwen3', { trainCtx: 40960 }, store);
  assert.equal(run.limitsFor('ollama:qwen3', store).trainCtx, 40960);
  assert.equal(run.limitsFor('other', store), null);
});

test('the resolved context is always SENT, to both runtimes', () => {
  const src = read('desktop', 'src', 'run-model.ts');
  assert.match(src, /runSettings\.loadArgs\(resolvedValues\(entry\), cores\)/, 'llama-server gets -c explicitly');
  assert.match(src, /const values = resolvedValues\(entry\);[\s\S]{0,300}ollamaOptions\(values\)/, 'Ollama gets num_ctx explicitly');
  assert.match(src, /\/api\/show/);
  assert.match(src, /\/v1\/models/);
  assert.deepEqual(run.ollamaOptions({ ctx: 8192 }).num_ctx, 8192);
  assert.equal(run.loadArgs({ ctx: 8192 }).ctx, 8192);
});
