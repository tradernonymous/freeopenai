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
