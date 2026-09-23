// The Android app's hidden Puter page (puter-bridge.html), run in a sandbox
// with a stand-in SDK. What these pin down is the sign-in contract: Puter's
// own puter.auth.signIn() opens its popup only when the page holds a real
// user gesture (hasUserActivation() in its Auth module) and otherwise shows a
// consent prompt inside the page -- which, in a 1x1 invisible WebView, nobody
// can see or tap, so the promise never settled and the app sat on "signing
// in" forever. A call arriving from Kotlin's evaluateJavascript is not a
// gesture, so the page must wait for its own button to be tapped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'puter-bridge.html'), 'utf8');
const SCRIPTS = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function loadBridge({ signedIn = false, signIn } = {}) {
  const elements = {
    'neura-signin': { hidden: true },
    'neura-go': { disabled: false },
    'neura-cancel': { disabled: false },
  };
  const calls = { signIn: 0 };
  const state = { signedIn };
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    location: { href: 'https://app.example/puter-bridge.html' },
    localStorage: { setItem() {}, removeItem() {} },
    document: { getElementById: (id) => elements[id] || null },
    open: () => null,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPTS[0], ctx);
  // What the SDK's own script tag leaves behind before the body script runs.
  ctx.puter = {
    auth: {
      isSignedIn: () => state.signedIn,
      onAuthStateChanged() {},
      signIn: () => {
        calls.signIn++;
        return signIn ? signIn(state) : new Promise(() => {});
      },
    },
  };
  vm.runInContext(SCRIPTS[1], ctx);
  const status = (id) => JSON.parse(ctx.neuraStatus(id));
  return { ctx, elements, calls, state, status };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the page carries a visible prompt with a Continue and a Cancel button', () => {
  assert.match(HTML, /id="neura-signin"[^>]*hidden/);
  assert.match(HTML, /id="neura-go"[^>]*onclick="window\.neuraContinueSignIn\(\)"/);
  assert.match(HTML, /id="neura-cancel"[^>]*onclick="window\.neuraCancelSignIn\(\)"/);
});

test('a sign-in asked for from the app waits for a tap instead of calling Puter', () => {
  const bridge = loadBridge();
  bridge.ctx.neuraSignIn('s1');
  assert.equal(bridge.calls.signIn, 0, 'no gesture yet, so Puter would only show an unseen consent prompt');
  assert.equal(bridge.elements['neura-signin'].hidden, false, 'the prompt is shown for the tap');
  assert.equal(bridge.status('s1').state, 'pending');
});

test('the Continue tap is what calls Puter, and a finished sign-in closes the prompt', async () => {
  const bridge = loadBridge({
    signIn: (state) => {
      state.signedIn = true;
      return Promise.resolve({ username: 'u' });
    },
  });
  bridge.ctx.neuraSignIn('s2');
  bridge.ctx.neuraContinueSignIn();
  assert.equal(bridge.calls.signIn, 1, 'called synchronously inside the tap, where the gesture is');
  assert.equal(bridge.elements['neura-go'].disabled, true, 'a second tap cannot start a second window');
  await settle();
  assert.equal(bridge.status('s2').state, 'done');
  assert.equal(bridge.elements['neura-signin'].hidden, true);
  assert.equal(bridge.elements['neura-go'].disabled, false);
});

test('a refused sign-in reports Puter\'s reason', async () => {
  const bridge = loadBridge({ signIn: () => Promise.reject({ message: 'popup closed' }) });
  bridge.ctx.neuraSignIn('s3');
  bridge.ctx.neuraContinueSignIn();
  await settle();
  assert.deepEqual(bridge.status('s3'), { state: 'error', length: 0, error: 'popup closed' });
  assert.equal(bridge.elements['neura-signin'].hidden, true);
});

test('Cancel ends the job without ever calling Puter', () => {
  const bridge = loadBridge();
  bridge.ctx.neuraSignIn('s4');
  bridge.ctx.neuraCancelSignIn();
  assert.equal(bridge.calls.signIn, 0);
  assert.equal(bridge.status('s4').state, 'error');
  assert.match(bridge.status('s4').error, /cancelled/);
  assert.equal(bridge.elements['neura-signin'].hidden, true);
});

test('an account already signed in finishes without showing anything', () => {
  const bridge = loadBridge({ signedIn: true });
  bridge.ctx.neuraSignIn('s5');
  assert.equal(bridge.status('s5').state, 'done');
  assert.equal(bridge.elements['neura-signin'].hidden, true);
  assert.equal(bridge.calls.signIn, 0);
});

test('a stray Continue or Cancel with no sign-in waiting does nothing', () => {
  const bridge = loadBridge();
  bridge.ctx.neuraContinueSignIn();
  bridge.ctx.neuraCancelSignIn();
  assert.equal(bridge.calls.signIn, 0);
});

test('app builds that still use the old fa4u names reach the same functions and state', async () => {
  const bridge = loadBridge({ signedIn: true });
  for (const name of ['Status', 'Chunk', 'Forget', 'Chat', 'Draw', 'SignIn', 'ContinueSignIn', 'CancelSignIn', 'Diagnose', 'Jobs']) {
    assert.equal(bridge.ctx['fa4u' + name], bridge.ctx['neura' + name], name);
  }
  assert.equal(typeof bridge.ctx.fa4uSignIn, 'function');
  // A flag read through the old name follows the new one, never a stale copy.
  bridge.ctx.neuraSignedIn = true;
  assert.equal(bridge.ctx.fa4uSignedIn, true);
  bridge.ctx.neuraSignedIn = false;
  assert.equal(bridge.ctx.fa4uSignedIn, false);
});
