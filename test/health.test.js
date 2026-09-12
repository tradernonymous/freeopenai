const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { createRequestHandler, LLM_PROVIDERS } = require('../server.js');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');

// The subject here is routing and the login gate, not a function called
// directly, so every assertion goes through a real listener.
async function withServer(run) {
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

// A server with no AUTH_USER_1 has the login gate OFF (isAuthenticated returns
// true when no accounts are configured), so a test that cares about the gate
// has to switch it on — otherwise it would pass against a wide-open server and
// prove nothing about whether /api/health is the only public API path.
async function withLoginGate(run) {
  const saved = { AUTH_USER_1: process.env.AUTH_USER_1, AUTH_PASS_1: process.env.AUTH_PASS_1 };
  process.env.AUTH_USER_1 = 'health-tester';
  process.env.AUTH_PASS_1 = 'health-tester-password';
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: urlPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('/api/health answers through the login gate while the rest of the API stays closed', async () => {
  await withLoginGate(() => withServer(async (port) => {
    const health = await request(port, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);

    // The reason this test exists: adding one public path must not open any
    // other one, and a future edit to PUBLIC_PATHS would fail here.
    assert.equal((await request(port, '/api/llm/providers')).status, 401);
    assert.equal((await request(port, '/api/skills')).status, 401);
    assert.equal((await request(port, '/api/llm/models')).status, 401);
  }));
});

test('/api/health reports the version, provider ids and uptime, and is never cached', async () => {
  await withServer(async (port) => {
    const { status, headers, body } = await request(port, '/api/health');
    assert.equal(status, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.version, pkg.version);
    assert.deepEqual(parsed.providers, Object.keys(LLM_PROVIDERS));
    assert.ok(parsed.providers.includes('openrouter'));
    assert.ok(Number.isInteger(parsed.uptimeSeconds) && parsed.uptimeSeconds >= 0);
    // A cached health answer is worse than none: it would vouch for the deploy
    // that used to be live.
    assert.equal(headers['cache-control'], 'no-store');
  });
});

test('/api/health says whether this deployment asks for a login of its own', async () => {
  // The page uses this to decide whether a direct provider needs a Puter
  // account. It is not a secret: an unauthenticated visitor already learns it
  // from the redirect to /login.html.
  await withEnv({ AUTH_USER_1: undefined, AUTH_PASS_1: undefined }, () => withServer(async (port) => {
    assert.equal(JSON.parse((await request(port, '/api/health')).body).loginRequired, false);
  }));
  await withLoginGate(() => withServer(async (port) => {
    // Still public with the gate on — that is the point of the endpoint.
    const res = await request(port, '/api/health');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).loginRequired, true);
  }));
});

test('/api/health reports the Railway commit when there is one, and null when there is not', async () => {
  await withEnv({ RAILWAY_GIT_COMMIT_SHA: undefined, RAILWAY_GIT_BRANCH: undefined }, () => withServer(async (port) => {
    const local = JSON.parse((await request(port, '/api/health')).body);
    assert.equal(local.commit, null);
    assert.equal(local.branch, null);
  }));

  await withEnv({ RAILWAY_GIT_COMMIT_SHA: '4b9779037ff3e1c5aa3b9b1683b180d0c6f737c7', RAILWAY_GIT_BRANCH: 'main' }, () => withServer(async (port) => {
    const deployed = JSON.parse((await request(port, '/api/health')).body);
    assert.equal(deployed.commit, '4b9779037ff3e1c5aa3b9b1683b180d0c6f737c7');
    assert.equal(deployed.branch, 'main');
  }));
});

test('/api/health never echoes key material or provider configuration', async () => {
  const sentinel = 'sk-live-DO-NOT-LEAK-0123456789';
  await withEnv({
    OPENROUTER_API_KEY: sentinel,
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9/v1',
  }, () => withServer(async (port) => {
    const { body } = await request(port, '/api/health');
    assert.ok(!body.includes(sentinel), 'health response leaked an API key');
    assert.ok(!body.includes('127.0.0.1:9'), 'health response leaked a base URL');
    const parsed = JSON.parse(body);
    assert.ok(
      parsed.providers.every((id) => typeof id === 'string'),
      'providers must be ids only, never config objects'
    );
    assert.ok(!body.includes('configured'), 'health response leaked provider configuration state');
  }));
});

test('/api/health rejects writes and answers HEAD without handing back the app', async () => {
  await withServer(async (port) => {
    assert.equal((await request(port, '/api/health', 'POST')).status, 405);
    const head = await request(port, '/api/health', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['cache-control'], 'no-store');
  });
});
