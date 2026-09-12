// index.html has no harness, so a wrong model name in an error and a retry that
// never fired both shipped unnoticed. This pulls the functions involved straight
// out of the shipped file and runs them against stubs, so the wiring is
// exercised as written rather than as described.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The real decisions, not stubs, so this exercises the shipped pairing of
// index.html's wiring with chatlib.js's rules.
const {    errorDetailFromBody,
    isAccountLevelFailure,
    isModelScopedRefusal,
    nextUsableModel,
    refusedModelIds,
    safeJson,
    isRetryableStatus,
    MAX_MODEL_REFUSAL_RETRIES,
} = require('../chatlib.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Realistic ids matter, not placeholders like 'a': isAccountLevelFailure treats
// a message naming the model as model-scoped, and 'a' is a substring of words
// such as "payment", which silently inverts the outcome.
const MODELS = [
  'meta/llama-3.3-70b',
  'qwen/qwen3-235b-a22b',
  'deepseek/deepseek-v3.1',
  'mistralai/mistral-medium-3.5-128b',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'cohere/north-mini-code:free',
  'z-ai/glm-5.3',
  'amazon/nova-pro',
  'google/gemma-4-31b',
];

// The source of a named function, from `function` through its closing brace.
function sourceOf(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html no longer defines ${name}() -- re-point this test`);
  // Walk past the parameter list first: a default such as `extra = {}` contains
  // a brace that would otherwise read as the body opening.
  let params = 0;
  let i = HTML.indexOf('(', start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === '(') params++;
    else if (HTML[i] === ')' && !--params) break;
  }
  let depth = 0;
  i = HTML.indexOf('{', i);
  let quote = null;
  for (; i < HTML.length; i++) {
    const ch = HTML[i];
    const next = HTML[i + 1];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { i = HTML.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { i = HTML.indexOf('*/', i); if (i === -1) break; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && !--depth) return HTML.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces while reading ${name}()`);
}

// Keep the `async` keyword that precedes the declaration.
function declarationOf(name) {
  const start = HTML.indexOf(`function ${name}(`);
  const asyncPrefix = HTML.slice(Math.max(0, start - 6), start).endsWith('async ') ? 'async ' : '';
  return asyncPrefix + sourceOf(name);
}

// The page's functions close over page-scope variables. `with` resolves those
// reads and, more usefully, makes an assignment such as `selectedModel = next`
// land back on the deps object, so the test can watch it move.
function load(deps) {
  const names = ['forgetRefusedModel', 'callModel', 'streamProviderChat'];
  const body = names.map(declarationOf).join('\n') + `\nreturn { ${names.join(', ')} };`;
  return new Function('deps', `with (deps) {\n${body}\n}`)(deps);
}

// Both shapes of a refusal, because the two request paths read it differently:
// a plain request gets JSON, a streamed one gets an SSE frame.
const refusalMessage = (id) => `403: ${id} is only available on agentic harnesses`;
const refusal = (id) => ({
  ok: false,
  status: 403,
  json: async () => ({ error: refusalMessage(id) }),
  text: async () => 'data: ' + JSON.stringify({ error: refusalMessage(id) }) + '\n\n',
});

function harness({ models, answers, streamed = null }) {
  const requests = [];
  const status = [];
  const renderer = {
    full: '',
    reasoning: '',
    appendText(t) { this.full += t; },
    appendReasoning(t) { this.reasoning += t; },
    flush() {},
    abort() {},
  };
  const deps = {
    selectedProvider: 'openrouter',
    selectedModel: models[0],
    providerModels: models.map((id) => ({ id })),
    modelsRefusedBy: new Set(),
    PUTER_PROVIDER: 'puter',
    MAX_MODEL_REFUSAL_RETRIES,
    errorDetailFromBody,
    isAccountLevelFailure,
    isModelScopedRefusal,
    nextUsableModel,
    refusedModelIds,
    autoRetryEnabled: false,
    RATE_LIMIT_BASE_DELAY_MS: 1,
    localStorage: { setItem() {} },
    showStatus: (kind, text) => status.push(`${kind}: ${text}`),
    renderModelOptions() {},
    updateModelLabel() {},
    suspendProvider(detail) { status.push(`suspended: ${detail}`); },
    // The real one: a stubbed safeJson would hide exactly the null-body
    // handling these tests exist to check.
    safeJson,
    normalizeProviderReply: (data) => ({ reply: data.answer }),
    isRateLimitError: () => false,
    isRetryableStatus,
    abortError: () => new Error('aborted'),
    parseSseChunk: () => (streamed ? [{ choices: [{ delta: { content: streamed } }] }] : []),
    fetch: async (url, init) => {
      const id = JSON.parse(init.body).model;
      requests.push(id);
      if (!answers(id)) return refusal(id);
      return {
        ok: true,
        status: 200,
        json: async () => ({ answer: id }),
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => (sent
                ? { done: true }
                : ((sent = true), { done: false, value: Buffer.from('data: chunk\n') })),
            };
          },
        },
      };
    },
  };
  return { deps, requests, status, renderer, ...load(deps) };
}

test('the extracted source is the shipped one, and still brace-matches cleanly', () => {
  // The three functions this file depends on must parse the same way in both
  // files; a rename or a template literal in them invalidates the extraction.
  for (const name of ['forgetRefusedModel', 'callModel', 'streamProviderChat']) {
    // Comments are stripped first: a backtick quoted in prose cannot confuse
    // the scanner, but one in code can, and that is what this guards.
    const code = sourceOf(name).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(code.includes('`'), false, `${name}() gained a template literal -- the scanner needs updating`);
  }
});

test('a refused model is retried with the next one, and the turn still answers', async () => {
  const h = harness({ models: MODELS.slice(0, 3), answers: (id) => id === MODELS[1] });
  const reply = await h.callModel([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(h.requests, MODELS.slice(0, 2), 'asked the refused model once, then the next one');
  assert.equal(reply.reply, MODELS[1]);
  assert.equal(h.deps.selectedModel, MODELS[1]);
  // The refusal is a per-model fact, so it must be remembered rather than
  // re-tried on the next message.
  assert.ok(h.deps.modelsRefusedBy.has('openrouter:' + MODELS[0]));
});

test('a model that is not refused is never re-asked', async () => {
  const h = harness({ models: MODELS.slice(0, 2), answers: (id) => id === MODELS[0] });
  const reply = await h.callModel([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(h.requests, MODELS.slice(0, 1));
  assert.equal(reply.reply, MODELS[0]);
  assert.equal(h.deps.modelsRefusedBy.size, 0);
});

test('a whole refusing list is bounded, then reported against the last model tried', async () => {
  // Nine refusals, a bound of three: without it this would spend nine requests
  // and hide the failure behind a slow crawl.
  const h = harness({ models: MODELS, answers: () => false });
  let error = null;
  try { await h.callModel([{ role: 'user', content: 'hi' }]); } catch (err) { error = err; }
  assert.ok(error, 'it must fail rather than answer nothing');
  assert.equal(h.requests.length, MAX_MODEL_REFUSAL_RETRIES + 1, 'one attempt plus the bound, not the whole catalogue');
  // This is the reported bug: the error has to name the model that refused,
  // which is the last one *asked* -- not the one the picker moved to next.
  const lastAsked = h.requests[h.requests.length - 1];
  assert.equal(error.modelId, lastAsked);
  assert.equal(error.providerId, 'openrouter');
  assert.notEqual(h.deps.selectedModel, lastAsked, 'the picker should have moved on');
  assert.ok(MODELS.includes(h.deps.selectedModel), 'and moved to a model that exists');
});

test('the error label reads the failure, not the current selection', () => {
  const match = HTML.match(/const failedOn = ([^;]+);/);
  assert.ok(match, 'index.html no longer computes a failedOn label -- re-point this test');
  const label = (vars) => new Function('vars', `with (vars) { return ${match[1]}; }`)(vars);
  // A refusal moves selectedModel on before the error is rendered, so reading
  // the selection here is what printed a model the app never called.
  const error = Object.assign(new Error('403: gated'), { modelId: MODELS[0], providerId: 'openrouter' });
  assert.equal(label({ error, selectedProvider: 'openrouter', selectedModel: MODELS[1] }), 'openrouter/' + MODELS[0]);
  // A failure with no model attached -- a dropped connection, say -- still
  // reports something usable rather than "undefined".
  assert.equal(label({ error: new Error('offline'), selectedProvider: 'nvidia', selectedModel: MODELS[0] }), 'nvidia/' + MODELS[0]);
});

test('a streaming turn retries before rendering, so no half-answer is left behind', async () => {
  const h = harness({ models: MODELS.slice(0, 2), answers: (id) => id === MODELS[1], streamed: 'hi' });
  await h.streamProviderChat([{ role: 'user', content: 'hi' }], h.renderer, undefined);
  assert.deepEqual(h.requests, MODELS.slice(0, 2));
  // The refusal arrives on the headers, so the first attempt rendered nothing;
  // a retry can therefore never duplicate or garble what the user sees.
  assert.equal(h.renderer.full, 'hi');
});

test('an account-level refusal suspends the provider instead of walking models', async () => {
  const h = harness({ models: MODELS.slice(0, 3), answers: () => false });
  h.deps.fetch = async () => ({
    ok: false,
    status: 402,
    json: async () => ({ error: '402: A payment method is required.' }),
    text: async () => JSON.stringify({ error: '402: A payment method is required.' }),
  });
  await h.callModel([{ role: 'user', content: 'hi' }]).catch(() => {});
  // Every model fails identically here, so removing them one at a time would
  // spend a failed request per model for no gain.
  assert.equal(h.status.filter((s) => s.startsWith('suspended:')).length, 1);
  // And nothing was treated as a per-model refusal.
  assert.equal(h.deps.modelsRefusedBy.size, 0);
});

// The reported crash: the proxy forwarded a 200 whose body was a bare `null`,
// and the client read `data.parseFailed` off it.
const nullBody = (status) => ({ ok: status === 200, status, json: async () => null, text: async () => 'null' });

test('a reply whose body is null is reported, not crashed on', async () => {
  const h = harness({ models: MODELS.slice(0, 4), answers: () => false });
  h.deps.fetch = async () => nullBody(200);
  let error = null;
  try { await h.callModel([{ role: 'user', content: 'hi' }]); } catch (err) { error = err; }
  assert.ok(error, 'it has to fail rather than answer nothing');
  assert.doesNotMatch(error.message, /Cannot read properties of null/, 'the TypeError is the bug');
  assert.match(error.message, /unreadable/i, 'and the user is told what happened');
  // The label still names the model that was actually called.
  assert.ok(MODELS.slice(0, 4).includes(error.modelId));
});

test('a streamed reply whose body is null is reported, not crashed on', async () => {
  const h = harness({ models: MODELS.slice(0, 3), answers: () => false });
  h.deps.fetch = async () => nullBody(502);
  const renderer = { full: '', appendText() {}, appendReasoning() {}, flush() {}, abort() {} };
  let error = null;
  try { await h.streamProviderChat([{ role: 'user', content: 'hi' }], renderer, undefined); } catch (err) { error = err; }
  assert.ok(error);
  assert.doesNotMatch(error.message, /Cannot read properties of null/);
  // Nothing was readable, so the status is the only fact left to report.
  assert.match(error.message, /502/);
});

test('a streamed failure keeps the provider own wording instead of losing it', async () => {
  // The server reports a failed stream as an SSE frame. Reading the body as
  // JSON meant the frame could not be parsed, so the explanation was dropped
  // and the refusal looked generic -- which also hid account-level refusals
  // from the code that is supposed to recognise them.
  const h = harness({ models: MODELS.slice(0, 2), answers: () => false });
  const frame = 'data: ' + JSON.stringify({ error: '403: ' + MODELS[0] + ' is only available on agentic harnesses' }) + '\n\n';
  h.deps.fetch = async () => ({ ok: false, status: 403, text: async () => frame });
  const renderer = { full: '', appendText() {}, appendReasoning() {}, flush() {}, abort() {} };
  let error = null;
  try { await h.streamProviderChat([{ role: 'user', content: 'hi' }], renderer, undefined); } catch (err) { error = err; }
  assert.ok(error);
  assert.match(error.message, /only available on agentic harnesses/, 'the provider explained itself, so keep it');
  // And it is still recognised as being about that model, so the next one is tried.
  assert.ok(h.deps.modelsRefusedBy.has('openrouter:' + MODELS[0]));
});
