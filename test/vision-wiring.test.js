// The image path lives in index.html, which has no harness -- and that is how an
// attached image came to be dropped in silence on every direct provider. These
// tests pull the shipped functions out of the file and run them with canvas and
// fetch stubs, so the pipeline is exercised as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  errorDetailFromBody,
  isAccountLevelFailure,
  isModelScopedRefusal,
  modelForImage,
  nextUsableModel,
  refusedModelIds,
  isSendableImageUrl,
  withImageTurn,
  isRetryableStatus,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_IMAGE_EDGE,
  MAX_MODEL_REFUSAL_RETRIES,
} = require('../chatlib.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

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

function declarationOf(name) {
  const start = HTML.indexOf(`function ${name}(`);
  const asyncPrefix = HTML.slice(Math.max(0, start - 6), start).endsWith('async ') ? 'async ' : '';
  return asyncPrefix + sourceOf(name);
}

const NAMES = ['insistOnImageModel', 'imageDataUrlForRequest', 'renderScaledImage', 'streamProviderChat'];

function load(deps) {
  const body = NAMES.map(declarationOf).join('\n') + `\nreturn { ${NAMES.join(', ')} };`;
  return new Function('deps', `with (deps) {\n${body}\n}`)(deps);
}

// A canvas that reports a payload size the test controls, so the shrink loop can
// be driven without encoding anything.
function canvasStub(sizer, onRender) {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: function toDataURL() {
      if (onRender) onRender({ width: this.width, height: this.height });
      return 'data:image/jpeg;base64,' + 'A'.repeat(sizer(this.width));
    },
  };
}

function baseDeps(overrides = {}) {
  const status = [];
  const writes = [];
  const errors = [];
  const deps = {
    selectedProvider: 'openrouter',
    selectedModel: 'text-only',
    providerModels: [{ id: 'text-only' }, { id: 'sees', vision: true }],
    modelsRefusedBy: new Set(),
    PUTER_PROVIDER: 'puter',
    MAX_MODEL_REFUSAL_RETRIES,
    MAX_IMAGE_EDGE,
    MAX_IMAGE_DATA_URL_CHARS,
    errorDetailFromBody,
    isAccountLevelFailure,
    isModelScopedRefusal,
    modelForImage,
    nextUsableModel,
    refusedModelIds,
    isSendableImageUrl,
    withImageTurn,
    // Reached only when a provider refuses a model mid-stream; a stub keeps the
    // sandbox honest about it rather than letting a ReferenceError hide in a
    // path this file does not exercise.
    forgetRefusedModel: () => null,
    localStorage: { setItem: (k, v) => writes.push([k, v]) },
    showStatus: (kind, text) => status.push(`${kind}: ${text}`),
    renderModelOptions() {},
    updateModelLabel() {},
    suspendProvider() {},
    autoRetryEnabled: false,
    RATE_LIMIT_BASE_DELAY_MS: 1,
    safeJson: async (res) => res.json(),
    normalizeProviderReply: (data) => ({ reply: data.answer }),
    isRateLimitError: () => false,
    isRetryableStatus,
    abortError: () => new Error('aborted'),
    parseSseChunk: () => [],
    // Defaults that fail loudly: a test that forgets to stub one must not get a
    // swallowed ReferenceError that reads as "no image" instead.
    createImageBitmap: async () => { throw new Error('no createImageBitmap stub'); },
    fetch: async () => { throw new Error('no fetch stub'); },
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
    ...overrides,
  };
  deps.status = status;
  deps.writes = writes;
  deps.errors = errors;
  return deps;
}

test('the extracted source is the shipped one, and still brace-matches cleanly', () => {
  for (const name of NAMES) {
    // Comments are stripped first: a backtick quoted in prose cannot confuse
    // the scanner, but one in code can, and that is what this guards.
    const code = sourceOf(name).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(code.includes('`'), false, `${name}() gained a template literal -- the scanner needs updating`);
  }
});

test('a text-only model is swapped for one that can see, and the swap is announced', () => {
  const deps = baseDeps();
  const { insistOnImageModel } = load(deps);
  const chosen = insistOnImageModel();
  assert.equal(chosen, 'sees');
  assert.equal(deps.selectedModel, 'sees');
  // Silent is how this bug felt from the outside, so the move is visible.
  assert.ok(deps.status.some((s) => s.includes('can read images')), 'the switch is announced');
  assert.deepEqual(deps.writes, [['provider:openrouter:model', 'sees']], 'and remembered for the next turn');
});

test('a model that can already see is not swapped, and nothing is written', () => {
  const deps = baseDeps({ selectedModel: 'sees' });
  const { insistOnImageModel } = load(deps);
  assert.equal(insistOnImageModel(), 'sees');
  assert.equal(deps.selectedModel, 'sees');
  assert.deepEqual(deps.writes, []);
  assert.deepEqual(deps.status, []);
});

test('a provider with no image-capable model reports rather than sends the picture to be ignored', () => {
  const deps = baseDeps({ providerModels: [{ id: 'text-only' }, { id: 'also-text' }] });
  const { insistOnImageModel } = load(deps);
  assert.equal(insistOnImageModel(), null);
  // The selection must be left alone: a null result means "explain and stop",
  // and quietly re-pointing the model would hide the reason.
  assert.equal(deps.selectedModel, 'text-only');
  assert.deepEqual(deps.writes, []);
});

// A page-scope name missing from the sandbox does not fail loudly: it throws a
// ReferenceError that these functions catch, so the test sees a plausible null.
// That silently produced two false passes while this file was being written, so
// the names the extracted code closes over are derived and checked instead of
// being remembered.
test('every page-scope name the extracted code closes over is in the sandbox', () => {
  // Analysed with comments and string literals removed, or prose such as
  // "Request failed (" reads as a call to a function named `failed`.
  const sources = NAMES.map(sourceOf).join('\n')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const declared = new Set([...sources.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const notNames = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'async', 'function',
    'delete', 'void', 'in', 'of', 'do', 'else', 'throw', 'yield', 'instanceof', 'super', 'this', 'case',
    'Error', 'JSON', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'RegExp', 'Date',
    'Map', 'Set', 'TypeError', 'RangeError', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'Infinity', 'NaN',
    'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'globalThis',
    // Globals in both the browser and Node, so `with` falls through to them.
    'TextDecoder', 'TextEncoder', 'Buffer', 'URL', 'URLSearchParams', 'AbortController',
    // Promise executor parameters of an inline wait (`new Promise((resolve, reject) => …)`).
    'resolve', 'reject',
  ]);
  // A leading dot means a method call (`.drawImage(`), which is not page scope.
  const referenced = new Set([...sources.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const deps = baseDeps();
  const missing = [...referenced].filter((n) => !declared.has(n) && !notNames.has(n) && !(n in deps));
  assert.deepEqual(missing, [], `these page-scope names are missing from baseDeps(): ${missing.join(', ')}`);
});

test('an oversized image is re-encoded smaller until it fits under the cap', async () => {
  const renders = [];
  // Sized so the first attempts are far too big and a later one lands under the
  // cap: 1600*1000*0.85, 1200*1000*0.75, 900*1000*0.65.
  const deps = baseDeps({
    createImageBitmap: async () => ({ width: 4000, height: 3000, close() {} }),
    document: { createElement: () => canvasStub((width) => width * 1000, (r) => renders.push(r)) },
  });
  const { imageDataUrlForRequest } = load(deps);
  const url = await imageDataUrlForRequest({ name: 'photo.jpg' });
  assert.ok(url, 'a usable image came back');
  // The function swallows failures and returns null, so a hidden ReferenceError
  // would look exactly like an image that could not be shrunk.
  assert.deepEqual(deps.errors, [], 'it failed for no reason it logged');
  assert.ok(url.length <= MAX_IMAGE_DATA_URL_CHARS, 'and it fits the cap');
  assert.ok(renders.length > 1, 'it took more than one attempt');
  // Every attempt must be smaller than the last, or the loop cannot converge.
  for (let i = 1; i < renders.length; i++) {
    assert.ok(renders[i].width < renders[i - 1].width, `attempt ${i} shrank`);
  }
  // And never larger than the configured edge.
  assert.ok(renders.every((r) => r.width <= MAX_IMAGE_EDGE));
});

test('an image that cannot be shrunk enough yields null, so the caller explains', async () => {
  const deps = baseDeps({
    createImageBitmap: async () => ({ width: 4000, height: 3000, close() {} }),
    document: { createElement: () => canvasStub((width) => width * 1000000) },
  });
  const { imageDataUrlForRequest } = load(deps);
  assert.equal(await imageDataUrlForRequest({ name: 'huge.png' }), null);
});

test('an unreadable image yields null rather than throwing mid-turn', async () => {
  const deps = baseDeps({
    createImageBitmap: async () => { throw new Error('not decodable'); },
  });
  const { imageDataUrlForRequest } = load(deps);
  assert.equal(await imageDataUrlForRequest({ name: 'broken.png' }), null);
});

test('scaling down uses the long edge and never enlarges a small image', () => {
  const seen = [];
  const deps = baseDeps({
    document: { createElement: () => canvasStub(() => 10, (r) => seen.push(r)) },
  });
  const { renderScaledImage } = load(deps);
  renderScaledImage({ width: 4000, height: 2000 }, MAX_IMAGE_EDGE, 0.85);
  assert.deepEqual(seen[0], { width: 1600, height: 800 });
  // A small screenshot is left at its own size: upscaling invents detail.
  renderScaledImage({ width: 100, height: 50 }, MAX_IMAGE_EDGE, 0.85);
  assert.deepEqual(seen[1], { width: 100, height: 50 });
});

test('the request that actually goes out carries the image and the model that can read it', async () => {
  // End to end through the shipped pipeline: swap the model, build the turn,
  // send it -- and check what the provider would have received.
  const sent = [];
  const deps = baseDeps({
    fetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      };
    },
  });
  const { insistOnImageModel, streamProviderChat } = load(deps);
  const renderer = { full: '', appendText() {}, appendReasoning() {}, flush() {}, abort() {} };

  assert.equal(insistOnImageModel(), 'sees');
  const convo = withImageTurn([{ role: 'user', content: 'what is this?' }], PNG, 'what is this?');
  await streamProviderChat(convo, renderer, undefined);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, 'sees', 'the request names the model that can see');
  assert.equal(sent[0].stream, true);
  assert.deepEqual(sent[0].messages[0].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: PNG } },
  ]);
});
