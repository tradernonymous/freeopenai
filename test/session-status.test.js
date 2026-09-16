const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

// The secret has to be known before server.js loads, because it reads it once
// at require time; a token minted here must verify against that same secret.
process.env.SESSION_SECRET = 'session-status-test-secret';
const { createRequestHandler } = require('../server.js');
const { signSession, SESSION_TTL_MS } = require('../auth.js');

const root = path.join(__dirname, '..');

async function withServer(run) {
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

async function withLoginGate(run) {
  const saved = { AUTH_USER_1: process.env.AUTH_USER_1, AUTH_PASS_1: process.env.AUTH_PASS_1 };
  process.env.AUTH_USER_1 = 'phone';
  process.env.AUTH_PASS_1 = 'phone-password';
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function get(port, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/session', method: 'GET', headers: cookie ? { cookie } : {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('/api/session reports an open deployment as ungated', async () => {
  await withServer(async (port) => {
    const res = await get(port);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { gate: false, user: null });
  });
});

test('/api/session is 401 without a session when the gate is on', async () => {
  await withLoginGate(() =>
    withServer(async (port) => {
      const res = await get(port);
      assert.equal(res.status, 401);
      assert.equal(res.headers['set-cookie'], undefined);
    })
  );
});

test('/api/session names the signed-in account and leaves a fresh session alone', async () => {
  await withLoginGate(() =>
    withServer(async (port) => {
      const token = signSession('session-status-test-secret', 'phone');
      const res = await get(port, 'fo_auth=' + token);
      assert.equal(res.status, 200);
      assert.equal(res.body.gate, true);
      assert.equal(res.body.user, 'phone');
      assert.ok(res.body.expiresAt > Date.now());
      assert.equal(res.headers['set-cookie'], undefined, 'a young session is not reissued');
    })
  );
});

test('/api/session renews a session past half its life', async () => {
  await withLoginGate(() =>
    withServer(async (port) => {
      // Signed four days ago on a seven-day life: three left, under half.
      const token = signSession('session-status-test-secret', 'phone', Date.now() - (4 * SESSION_TTL_MS) / 7);
      const res = await get(port, 'fo_auth=' + token);
      assert.equal(res.status, 200);
      const reissued = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('fo_auth='));
      assert.ok(reissued, 'a fresh cookie comes back');
      assert.match(reissued, /HttpOnly/);
      assert.notEqual(reissued.split(';')[0], 'fo_auth=' + token, 'a new token, not the old one echoed');
    })
  );
});

test('/api/session rejects a forged or expired session', async () => {
  await withLoginGate(() =>
    withServer(async (port) => {
      const stale = signSession('session-status-test-secret', 'phone', Date.now() - SESSION_TTL_MS - 1000);
      assert.equal((await get(port, 'fo_auth=' + stale)).status, 401);
      const forged = signSession('someone-elses-secret', 'phone');
      assert.equal((await get(port, 'fo_auth=' + forged)).status, 401);
    })
  );
});
