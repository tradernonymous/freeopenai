// Puter sign-in in the desktop app. The SDK's own signIn() opens a popup and
// waits for it to postMessage a token back; a Tauri webview hands window.open()
// to the system browser, which has no opener to post to, so the button did
// nothing. The bridge now drives the SDK's popup-free path: open the sign-in
// page with a session id, poll /login/wait, hand the token to the SDK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const puter = require('../desktop/src/puter.js');
const images = require('../desktop/src/images.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function fakeSdk() {
  let token = null;
  return {
    defaultGUIOrigin: 'https://puter.com',
    defaultAPIOrigin: 'https://api.puter.com',
    setAuthToken(t) { token = t; },
    auth: { isSignedIn: () => !!token },
  };
}

test('the sign-in URL is the SDK\'s session-mode URL, and the wait URL is its API', () => {
  const api = fakeSdk();
  const url = puter.signInUrl(api, 'abc');
  assert.ok(url.startsWith('https://puter.com/action/sign-in?'));
  assert.match(url, /embedded_in_popup=true/);
  assert.match(url, /cross_origin_isolated=true/);
  assert.match(url, /signin_session=abc/);
  assert.equal(puter.waitUrl(api), 'https://api.puter.com/login/wait');
  // With no SDK facts, the public origins.
  assert.equal(puter.waitUrl(null), 'https://api.puter.com/login/wait');
});

test('signIn opens the page once, polls until the token arrives, and hands it to the SDK', async () => {
  globalThis.puter = fakeSdk();
  try {
    const opened = [];
    const bodies = [];
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://api.puter.com/login/wait');
      bodies.push(JSON.parse(init.body));
      if (calls < 3) return { ok: false };
      return { ok: true, json: async () => ({ auth_token: 'tok-1' }) };
    };
    const ok = await puter.signIn({ open: (url) => opened.push(url), fetchImpl, sleep: async () => {} });
    assert.equal(ok, true);
    assert.equal(opened.length, 1, 'the page opens once, not once per poll');
    assert.equal(calls, 3);
    const session = new URL(opened[0]).searchParams.get('signin_session');
    assert.ok(session.length >= 32);
    for (const body of bodies) assert.equal(body.session, session, 'every poll names the session the page was opened with');
    assert.equal(globalThis.puter.auth.isSignedIn(), true);
  } finally {
    delete globalThis.puter;
  }
});

test('signIn gives up with a sentence, and does not open anything when already signed in', async () => {
  globalThis.puter = fakeSdk();
  try {
    let now = 0;
    const sleep = async (ms) => { now += ms; };
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await assert.rejects(
        puter.signIn({ open: () => {}, fetchImpl: async () => ({ ok: false }), sleep, timeoutMs: 10_000 }),
        /timed out/,
      );
    } finally {
      Date.now = realNow;
    }
    globalThis.puter.setAuthToken('already');
    const opened = [];
    assert.equal(await puter.signIn({ open: (u) => opened.push(u), fetchImpl: async () => { throw new Error('no'); } }), true);
    assert.deepEqual(opened, []);
  } finally {
    delete globalThis.puter;
  }
});

test('the Puter row is offered whether or not the engine mentions it', () => {
  const rows = images.providerChoices({ providers: [{ id: 'x', label: 'X', ready: true }] });
  assert.deepEqual(rows.map((r) => r.id), ['x', 'puter']);
  assert.equal(rows[1].kind, 'browser');
  assert.deepEqual(images.modelsForChoice(rows[1], 'generate'), images.PUTER_GENERATE_MODELS);
  assert.deepEqual(images.providerChoices({}).map((r) => r.id), ['puter']);
});

test('the screen opens the sign-in page through the shell, never a popup', () => {
  const screen = read('desktop', 'src', 'screens', 'ImagesScreen.tsx');
  assert.match(screen, /openUrl\(url\)/);
  assert.match(screen, /puter\.signIn\(open \? \{ open \} : undefined\)/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /call\('open_url', \{ url \}\)/);
  const shell = read('desktop', 'src-tauri', 'src', 'net.rs');
  assert.match(shell, /pub fn open_url\(/, 'the shell has the command');
  assert.match(shell, /OPEN_HOSTS/, 'and it is allowlisted');
  assert.match(read('desktop', 'src-tauri', 'src', 'main.rs'), /net::open_url/);
});
