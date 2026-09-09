const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// index.html's script has bitten us three times with the same bug: a top-level
// `let`/`const` declared further down the file than the initializeApp() call
// that reads it. That's a temporal dead zone -- initialization throws, and the
// page silently loses whatever ran after it (a font size, a picker, a whole
// sidebar). None of it is visible to eslint or to the unit tests.
//
// So boot the real script against a stub DOM. We don't need the page to work
// here, only to get through initialization without a ReferenceError.

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((code) => code.trim().length > 200);
}

// Answers every property access with another callable stub, so the script can
// do document.getElementById('x').classList.toggle(...) without us modelling
// any of it. Anything numeric-ish returns 0 and anything string-ish '' via the
// primitive coercion traps.
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined; // never look like a promise
      if (prop === 'length') return 0;
      if (prop === 'style' || prop === 'dataset' || prop === 'classList') return stub();
      return stub();
    },
    set() { return true; },
    has() { return true; },
    apply() { return stub(); },
    construct() { return stub(); },
  });
}

function bootSandbox() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage,
    location: { search: '', pathname: '/', href: '/' },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: () => 0,
    document: stub(),
    // Left undefined on purpose: the script guards on `typeof puter ===
    // 'undefined'` and shows a load error, which is a real code path worth
    // exercising rather than stubbing away.
    puter: undefined,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Set,
    Map,
    Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const chatlib = fs.readFileSync(path.join(__dirname, '..', 'chatlib.js'), 'utf8');

test('index.html has exactly one main inline script', () => {
  assert.equal(inlineScripts(html).length, 1);
});

test('the page initializes without a temporal-dead-zone error', () => {
  const sandbox = bootSandbox();
  const context = vm.createContext(sandbox);
  // chatlib.js loads first in the page, via its own <script src>.
  vm.runInContext(chatlib, context);

  let thrown = null;
  try {
    vm.runInContext(inlineScripts(html)[0], context);
  } catch (err) {
    thrown = err;
  }

  if (thrown && /before initialization|is not defined/i.test(thrown.message)) {
    assert.fail(
      `initializeApp() hit a declaration that hadn't run yet: ${thrown.message}\n` +
        'Move that top-level let/const above the initializeApp() call.'
    );
  }
});

test('state read during initialization is declared before initializeApp() runs', () => {
  const script = inlineScripts(html)[0];
  const initCall = script.indexOf('\n        initializeApp();');
  assert.ok(initCall > 0, 'expected a top-level initializeApp() call');

  // Every name initializeApp() reaches has burned us at least once.
  const readDuringInit = [
    'selectedModel',
    'selectedEffort',
    'effortRejectedBy',
    'conversations',
    'activeConversationId',
    'githubConnected',
  ];
  for (const name of readDuringInit) {
    const declared = script.search(new RegExp(`^\\s*(?:let|const|var)\\s+${name}\\b`, 'm'));
    assert.ok(declared !== -1, `${name} should be declared at the top level`);
    assert.ok(
      declared < initCall,
      `${name} is declared after the initializeApp() call, so initialization will throw`
    );
  }
});
