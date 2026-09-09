const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getConfiguredAccounts,
  verifyCredentials,
  signSession,
  verifySession,
  parseCookieHeader,
  checkRateLimit,
} = require('../auth.js');

test('getConfiguredAccounts reads only complete AUTH_USER_N/AUTH_PASS_N pairs', () => {
  const env = { AUTH_USER_1: 'alice', AUTH_PASS_1: 'p1', AUTH_USER_2: 'bob', AUTH_USER_3: '', AUTH_PASS_3: 'orphan' };
  assert.deepEqual(getConfiguredAccounts(env), [{ username: 'alice', password: 'p1' }]);
});

test('getConfiguredAccounts returns empty array (auth disabled) when nothing is set', () => {
  assert.deepEqual(getConfiguredAccounts({}), []);
});

test('verifyCredentials accepts a matching pair and rejects everything else', () => {
  const accounts = [{ username: 'alice', password: 'secret1' }, { username: 'bob', password: 'secret2' }];
  assert.equal(verifyCredentials(accounts, 'bob', 'secret2'), true);
  assert.equal(verifyCredentials(accounts, 'bob', 'wrong'), false);
  assert.equal(verifyCredentials(accounts, 'eve', 'secret1'), false);
  assert.equal(verifyCredentials(accounts, '', ''), false);
});

test('signSession + verifySession round-trips the username', () => {
  const token = signSession('shh', 'alice', 1000);
  assert.equal(verifySession('shh', token, 1500), 'alice');
});

test('verifySession rejects an expired session', () => {
  const token = signSession('shh', 'alice', 1000, 500);
  assert.equal(verifySession('shh', token, 2000), null);
});

test('verifySession rejects a tampered signature', () => {
  const token = signSession('shh', 'alice', 1000);
  const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
  assert.equal(verifySession('shh', tampered, 1500), null);
});

test('verifySession rejects a token signed with a different secret', () => {
  const token = signSession('shh', 'alice', 1000);
  assert.equal(verifySession('other-secret', token, 1500), null);
});

test('verifySession rejects garbage input', () => {
  assert.equal(verifySession('shh', '', 1000), null);
  assert.equal(verifySession('shh', undefined, 1000), null);
  assert.equal(verifySession('shh', 'not-a-real-token', 1000), null);
});

test('parseCookieHeader parses multiple cookies', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=hello%20world'), { a: '1', b: 'hello world' });
  assert.deepEqual(parseCookieHeader(undefined), {});
});

test('checkRateLimit allows up to the limit then blocks within the window', () => {
  const store = new Map();
  for (let i = 0; i < 3; i++) assert.equal(checkRateLimit(store, 'ip', 1000, 3, 60000), true);
  assert.equal(checkRateLimit(store, 'ip', 1000, 3, 60000), false);
});

test('checkRateLimit resets after the window elapses', () => {
  const store = new Map();
  checkRateLimit(store, 'ip', 1000, 1, 1000);
  assert.equal(checkRateLimit(store, 'ip', 1500, 1, 1000), false);
  assert.equal(checkRateLimit(store, 'ip', 2001, 1, 1000), true);
});
