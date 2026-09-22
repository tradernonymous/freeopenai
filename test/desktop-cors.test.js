// The desktop shell is a browser-grade origin on a different site from the
// engine, so the engine must answer CORS for it -- and for the vite dev
// server -- without ever handing that grant (credentials included) to an
// arbitrary public website. These tests boot the real request handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, corsOriginFor } = require('../server.js');

const VARS = ['AUTH_USER_1', 'AUTH_PASS_1', 'AUTH_USER_2', 'AUTH_PASS_2'];

async function withApp(env, fn) {
  const saved = {};
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  const server = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base });
  } finally {
    server.close();
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('corsOriginFor: the desktop shell and localhost, nothing else', () => {
  assert.equal(corsOriginFor('http://tauri.localhost'), 'http://tauri.localhost');
  assert.equal(corsOriginFor('tauri://localhost'), 'tauri://localhost');
  assert.equal(corsOriginFor('http://localhost:1420'), 'http://localhost:1420');
  assert.equal(corsOriginFor('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(corsOriginFor('https://evil.example'), null, 'a public site gets no grant');
  assert.equal(corsOriginFor(undefined), null, 'same-origin requests need none');
});

test('the engine answers CORS for the desktop shell on plain GETs', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw1' }, async ({ base }) => {
    for (const origin of ['http://tauri.localhost', 'http://localhost:1420']) {
      const res = await fetch(base + '/api/health', { headers: { Origin: origin } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), origin, origin);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true', origin);
    }
    const stranger = await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  });
});

test('OPTIONS preflights are answered, not 405', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw1' }, async ({ base }) => {
    const res = await fetch(base + '/api/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers'), /content-type/i);
  });
});

test('a desktop sign-in sticks: SameSite=None; Secure on https, and /api/session knows the user', async () => {
  await withApp({ AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw1' }, async ({ base }) => {
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://tauri.localhost', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /SameSite=None/, 'a cross-site cookie must be None or the browser drops it');
    assert.match(setCookie, /Secure/, 'None without Secure is rejected by the browser');

    const pair = setCookie.split(';')[0];
    const session = await fetch(base + '/api/session', {
      headers: { Origin: 'http://tauri.localhost', 'X-Forwarded-Proto': 'https', Cookie: pair },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user, 'alice');

    // A same-site browser login keeps the stricter Lax cookie.
    const web = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    assert.match(web.headers.get('set-cookie') || '', /SameSite=Lax/);
  });
});

// The GitHub account cookie was Lax, so the desktop's cross-site fetches never
// carried it: sign-in "worked" and /api/github/status still said nobody was
// connected. It now gets the same treatment as the session cookie.
test('githubCookieSameSite: cross-site for the desktop, Lax for browsers and plain http', () => {
  const { githubCookieSameSite } = require('../server.js');
  const req = (headers) => ({ headers });
  assert.equal(githubCookieSameSite(req({ 'x-forwarded-proto': 'https', origin: 'http://tauri.localhost' })), '; SameSite=None; Secure');
  assert.equal(githubCookieSameSite(req({ 'x-forwarded-proto': 'https', cookie: 'fo_gh_client=desktop' })), '; SameSite=None; Secure',
    'the sign-in callback has no Origin; the marker from authorize stands in');
  assert.equal(githubCookieSameSite(req({ 'x-forwarded-proto': 'https', origin: 'https://evil.example' })), '; SameSite=Lax; Secure');
  assert.equal(githubCookieSameSite(req({ 'x-forwarded-proto': 'https' })), '; SameSite=Lax; Secure', 'the web app keeps Lax');
  assert.equal(githubCookieSameSite(req({ origin: 'http://tauri.localhost' })), '; SameSite=Lax', 'None needs Secure, so plain http stays Lax');
});

test('a desktop GitHub sign-in is remembered for the callback, and disconnect answers cross-site', async () => {
  const saved = { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET };
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  try {
    await withApp({}, async ({ base }) => {
      const start = await fetch(base + '/api/github/authorize?client=desktop&add=1', { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(start.status, 302);
      const cookies = start.headers.getSetCookie().join('\n');
      assert.match(cookies, /fo_gh_client=desktop/);
      assert.match(cookies, /fo_gh_add=1/);
      assert.match(start.headers.get('location'), /prompt=select_account/, 'another account means the account picker');
      const out = await fetch(base + '/api/github/disconnect', {
        method: 'POST',
        headers: { Origin: 'http://tauri.localhost', 'x-forwarded-proto': 'https' },
      });
      assert.match(out.headers.getSetCookie().join('\n'), /fo_gh=;[^\n]*SameSite=None; Secure/);
    });
  } finally {
    for (const [k, v] of [['GITHUB_CLIENT_ID', saved.id], ['GITHUB_CLIENT_SECRET', saved.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('GitHub writes from another website are refused; the engine and the desktop may write', async () => {
  const { isForeignOrigin } = require('../server.js');
  const req = (origin) => ({ headers: { origin, host: 'engine.example', 'x-forwarded-proto': 'https' } });
  assert.equal(isForeignOrigin(req(undefined)), false, 'no Origin: not a browser cross-site write');
  assert.equal(isForeignOrigin(req('https://engine.example')), false, 'the engine itself');
  assert.equal(isForeignOrigin(req('http://tauri.localhost')), false, 'the desktop app');
  assert.equal(isForeignOrigin(req('https://evil.example')), true);
  assert.equal(isForeignOrigin(req('null')), true, 'a sandboxed page counts as foreign');
  await withApp({}, async ({ base }) => {
    const res = await fetch(base + '/api/github/disconnect', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });
});
