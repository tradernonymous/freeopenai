const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  parseServiceAccount,
  signAssertion,
  getAccessToken,
  sendPush,
  clearTokenCache,
  base64url,
} = require('../fcm-push.js');

// One real RSA keypair, generated once, so signAssertion's output can be
// verified the same way Google's own token endpoint would: check the
// signature against the public half rather than trust the string shape.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ACCOUNT = { clientEmail: 'fcm@example-project.iam.gserviceaccount.com', privateKey, projectId: 'example-project' };

function decodePart(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

test.afterEach(() => clearTokenCache());

test('parseServiceAccount accepts the three fields this module uses and nothing else', () => {
  const raw = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'PK', project_id: 'proj', extra: 'ignored' });
  assert.deepEqual(parseServiceAccount(raw), { clientEmail: 'a@b.iam.gserviceaccount.com', privateKey: 'PK', projectId: 'proj' });
});

test('parseServiceAccount is null for anything that is not a complete account', () => {
  assert.equal(parseServiceAccount(''), null);
  assert.equal(parseServiceAccount(undefined), null);
  assert.equal(parseServiceAccount('not json'), null);
  assert.equal(parseServiceAccount('null'), null);
  assert.equal(parseServiceAccount('42'), null);
  assert.equal(parseServiceAccount(JSON.stringify({ client_email: 'a@b.com' })), null, 'missing private_key and project_id');
});

test('signAssertion produces a JWT whose signature verifies against the public key', () => {
  const now = 1_700_000_000;
  const jwt = signAssertion(ACCOUNT, now);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  assert.deepEqual(decodePart(parts[0]), { alg: 'RS256', typ: 'JWT' });
  const claims = decodePart(parts[1]);
  assert.equal(claims.iss, ACCOUNT.clientEmail);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, now);
  assert.equal(claims.exp, now + 3600);
  const signature = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const verified = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, signature);
  assert.equal(verified, true, 'the signature must verify against the account\'s own public key');
});

test('base64url never emits +, / or padding', () => {
  const encoded = base64url(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]));
  assert.ok(!/[+/=]/.test(encoded));
});

test('getAccessToken exchanges the assertion once and caches it', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(opts.method, 'POST');
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.ok(body.get('assertion').split('.').length === 3);
    return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
  };
  let now = 1_700_000_000_000;
  const token1 = await getAccessToken(ACCOUNT, fetchImpl, () => now);
  assert.equal(token1, 'tok-1');
  now += 1000; // well within the hour
  const token2 = await getAccessToken(ACCOUNT, fetchImpl, () => now);
  assert.equal(token2, 'tok-1');
  assert.equal(calls, 1, 'a still-valid token must not be re-fetched');
});

test('getAccessToken refreshes once the cached token is within the skew window', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ access_token: 'tok-' + calls, expires_in: 3600 }) };
  };
  let now = 1_700_000_000_000;
  await getAccessToken(ACCOUNT, fetchImpl, () => now);
  now += 3600_000 - 1000; // inside the 60s refresh skew
  const token = await getAccessToken(ACCOUNT, fetchImpl, () => now);
  assert.equal(token, 'tok-2');
  assert.equal(calls, 2);
});

test('getAccessToken throws when the token endpoint refuses', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => getAccessToken(ACCOUNT, fetchImpl, () => Date.now()), /FCM auth failed: HTTP 401/);
});

test('sendPush posts a data-only message -- no top-level notification field', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
    }
    return { ok: true };
  };
  await sendPush(ACCOUNT, 'device-token-abc', { title: 'Build needs you', body: 'Approve a change' }, fetchImpl, () => Date.now());
  const send = calls[1];
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/example-project/messages:send');
  assert.equal(send.opts.headers.Authorization, 'Bearer tok-1');
  const parsed = JSON.parse(send.opts.body);
  assert.deepEqual(parsed.message, {
    token: 'device-token-abc',
    data: { title: 'Build needs you', body: 'Approve a change' },
  });
  assert.equal('notification' in parsed.message, false, 'a notification field would make Android auto-display it and skip this app\'s own handler while backgrounded');
});

test('sendPush stringifies every payload value and drops a null one', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
    }
    return { ok: true };
  };
  await sendPush(ACCOUNT, 'device-token-abc', { title: 'x', buildId: 12345, ignored: null }, fetchImpl, () => Date.now());
  assert.deepEqual(JSON.parse(calls[1].opts.body).message.data, { title: 'x', buildId: '12345' }, 'every value is a string, and a null value is dropped rather than sent as "null"');
});

test('sendPush marks an unregistered device token as stale, and a plain server error as not', async () => {
  const staleFetch = async (url) => {
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: false, status: 404, text: async () => '{"error":{"status":"UNREGISTERED"}}' };
  };
  await assert.rejects(
    () => sendPush(ACCOUNT, 'gone', { title: 'x', body: 'y' }, staleFetch, () => Date.now()),
    (err) => err.staleToken === true,
  );
  clearTokenCache();
  const outageFetch = async (url) => {
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: false, status: 500, text: async () => 'internal error' };
  };
  await assert.rejects(
    () => sendPush(ACCOUNT, 'device', { title: 'x', body: 'y' }, outageFetch, () => Date.now()),
    (err) => !err.staleToken,
  );
});
