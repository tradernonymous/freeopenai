// Android has no browser cookie jar its own network layer can read (Custom
// Tabs are isolated from the app by design -- that isolation is exactly why
// they replace a WebView here). Neither direction of the OAuth round trip can
// ride a cookie the way desktop's does, so both cross through a short-lived,
// single-use, opaque code instead of the session token itself -- one code to
// prove identity going in (/api/github/handoff), one to carry the result back
// out (/api/github/pickup), each bound to the app user it was minted for.
// These tests boot the real request handler and stub only the calls to
// github.com.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequestHandler } = require('../server.js');

const VARS = ['AUTH_USER_1', 'AUTH_PASS_1', 'AUTH_USER_2', 'AUTH_PASS_2', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];

// server.js freezes its module-level session secret the moment it is
// required, so a test cannot hand it one after the fact -- the app's own
// /api/login is what actually mints a session, and using it here is also the
// more honest test: it is exactly how NativeApi.SessionManager gets one.
async function login(base, username, password) {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, 'test setup: login must succeed');
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie');
  const cut = setCookie.indexOf(';');
  return (cut < 0 ? setCookie : setCookie.slice(0, cut)).split('=').slice(1).join('=');
}

async function handoff(base, session) {
  const res = await fetch(base + '/api/github/handoff', { method: 'POST', headers: { Cookie: `fo_auth=${session}` } });
  assert.equal(res.status, 200, 'test setup: handoff must succeed');
  return (await res.json()).handoff;
}

async function withApp(env, fn) {
  const saved = {};
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  const server = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = global.fetch;
  global.fetch = (url, init) => {
    const href = String(url);
    if (href.startsWith('https://github.com/login/oauth/access_token')) {
      return Promise.resolve({ ok: true, json: async () => ({ access_token: 'gho_test' }) });
    }
    if (href === 'https://api.github.com/user') {
      return Promise.resolve({ ok: true, json: async () => ({ login: 'octo', avatar_url: 'https://x/o.png' }) });
    }
    return realFetch(url, init);
  };
  try {
    await fn({ base });
  } finally {
    global.fetch = realFetch;
    server.close();
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function cookieMap(setCookieHeaders) {
  const out = {};
  for (const line of setCookieHeaders || []) {
    const pair = line.split(';')[0];
    const cut = pair.indexOf('=');
    if (cut > 0) out[pair.slice(0, cut)] = pair.slice(cut + 1);
  }
  return out;
}

test('an unauthenticated request to /api/github/authorize is refused without ?client=android', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' }, async ({ base }) => {
    const res = await fetch(base + '/api/github/authorize', { redirect: 'manual' });
    assert.equal(res.status, 401, 'the normal gate still applies to every other caller');
  });
});

test('/api/github/handoff itself needs a real session, same as any other API route', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw' }, async ({ base }) => {
    const res = await fetch(base + '/api/github/handoff', { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

test('client=android with an unknown or expired handoff code is refused when the login gate is on', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' }, async ({ base }) => {
    const res = await fetch(base + '/api/github/authorize?client=android&handoff=garbage', { redirect: 'manual' });
    assert.equal(res.status, 401);
  });
});

test('the full android round trip: handoff proves identity, authorize never sees a session, the callback hands back a single-use pickup code', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' }, async ({ base }) => {
    const session = await login(base, 'alice', 'pw');
    const code = await handoff(base, session);

    const authRes = await fetch(base + `/api/github/authorize?client=android&handoff=${code}`, { redirect: 'manual' });
    assert.equal(authRes.status, 302);
    assert.match(authRes.headers.get('location'), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const authCookies = cookieMap(authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [authRes.headers.get('set-cookie')]);
    assert.ok(authCookies.fo_gh_state, 'state cookie set');
    assert.equal(authCookies.fo_gh_client, 'android');
    assert.equal('fo_auth' in authCookies, false, 'the session token never crosses into a cookie or this URL');

    // A used-up handoff code does not work a second time.
    const reused = await fetch(base + `/api/github/authorize?client=android&handoff=${code}`, { redirect: 'manual' });
    assert.equal(reused.status, 401);

    // The callback is hit by the same Custom Tab -- it carries the state
    // cookie authorize just set, but still no fo_auth cookie of its own.
    const cookieHeader = Object.entries(authCookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const cbRes = await fetch(base + `/api/github/callback?code=abc&state=${authCookies.fo_gh_state}`, {
      headers: { Cookie: cookieHeader },
      redirect: 'manual',
    });
    assert.equal(cbRes.status, 302);
    const location = cbRes.headers.get('location');
    assert.match(location, /^neuraos:\/\/github-connected\?code=[0-9a-f]{48}&login=octo$/, 'a deep link, not a cookie, carries the result back to the app');
    const pickupCode = new URL(location).searchParams.get('code');

    const pickupRes = await fetch(base + `/api/github/pickup?code=${pickupCode}`, { headers: { Cookie: `fo_auth=${session}` } });
    assert.equal(pickupRes.status, 200);
    const { session: sealed } = await pickupRes.json();
    assert.ok(sealed && sealed.split('.').length === 3, 'a sealed session, opaque to the app');

    const again = await fetch(base + `/api/github/pickup?code=${pickupCode}`, { headers: { Cookie: `fo_auth=${session}` } });
    assert.equal(again.status, 404, 'single-use: the code is gone after the first redemption');

    const statusRes = await fetch(base + '/api/github/status', { headers: { Cookie: `fo_auth=${session}; fo_gh=${sealed}` } });
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.connected, true);
    assert.deepEqual(status.accounts, [{ login: 'octo', avatarUrl: 'https://x/o.png' }]);
  });
});

test('a pickup code cannot be redeemed by a different signed-in user', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw1', AUTH_USER_2: 'mallory', AUTH_PASS_2: 'pw2', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' }, async ({ base }) => {
    const aliceSession = await login(base, 'alice', 'pw1');
    const mallorySession = await login(base, 'mallory', 'pw2');
    const code = await handoff(base, aliceSession);

    const authRes = await fetch(base + `/api/github/authorize?client=android&handoff=${code}`, { redirect: 'manual' });
    const authCookies = cookieMap(authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [authRes.headers.get('set-cookie')]);
    const cbRes = await fetch(base + `/api/github/callback?code=abc&state=${authCookies.fo_gh_state}`, {
      headers: { Cookie: Object.entries(authCookies).map(([k, v]) => `${k}=${v}`).join('; ') },
      redirect: 'manual',
    });
    const pickupCode = new URL(cbRes.headers.get('location')).searchParams.get('code');

    // Mallory intercepts (or simply guesses) Alice's pickup code and tries to
    // redeem it as herself.
    const stolen = await fetch(base + `/api/github/pickup?code=${pickupCode}`, { headers: { Cookie: `fo_auth=${mallorySession}` } });
    assert.equal(stolen.status, 404, 'wrong identity: refused, and the code is now gone even for Alice');

    const legitimate = await fetch(base + `/api/github/pickup?code=${pickupCode}`, { headers: { Cookie: `fo_auth=${aliceSession}` } });
    assert.equal(legitimate.status, 404, 'a mismatched attempt still consumes the single use');
  });
});

test('an unknown or expired pickup code is refused, not silently empty', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw' }, async ({ base }) => {
    const session = await login(base, 'alice', 'pw');
    const res = await fetch(base + `/api/github/pickup?code=${crypto.randomBytes(24).toString('hex')}`, {
      headers: { Cookie: `fo_auth=${session}` },
    });
    assert.equal(res.status, 404);
  });
});

test('the desktop and web flows are unchanged: no client param still goes through the cookie', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' }, async ({ base }) => {
    const session = await login(base, 'alice', 'pw');
    const authRes = await fetch(base + '/api/github/authorize', { headers: { Cookie: `fo_auth=${session}` }, redirect: 'manual' });
    assert.equal(authRes.status, 302);
    const authCookies = cookieMap(authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [authRes.headers.get('set-cookie')]);
    assert.equal(authCookies.fo_gh_client, '', 'no client flag for a plain web/desktop request');

    const cookieHeader = `fo_auth=${session}; ${Object.entries(authCookies).map(([k, v]) => `${k}=${v}`).join('; ')}`;
    const cbRes = await fetch(base + `/api/github/callback?code=abc&state=${authCookies.fo_gh_state}`, {
      headers: { Cookie: cookieHeader },
      redirect: 'manual',
    });
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.get('location'), '/?view=settings', 'the normal browser landing, not a deep link');
  });
});
