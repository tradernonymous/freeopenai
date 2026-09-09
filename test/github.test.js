const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptJson, decryptJson } = require('../github.js');

test('encryptJson + decryptJson round-trips an object', () => {
  const sealed = encryptJson('shh', { token: 'gho_abc123', login: 'octocat' });
  assert.deepEqual(decryptJson('shh', sealed), { token: 'gho_abc123', login: 'octocat' });
});

test('decryptJson rejects a value sealed with a different secret', () => {
  const sealed = encryptJson('shh', { token: 'gho_abc123' });
  assert.equal(decryptJson('other-secret', sealed), null);
});

test('decryptJson rejects a tampered auth tag', () => {
  const sealed = encryptJson('shh', { token: 'gho_abc123' });
  const parts = sealed.split('.');
  parts[1] = parts[1].slice(0, -2) + (parts[1].slice(-2, -1) === 'a' ? 'b' : 'a') + parts[1].slice(-1);
  assert.equal(decryptJson('shh', parts.join('.')), null);
});

test('decryptJson rejects malformed input', () => {
  assert.equal(decryptJson('shh', ''), null);
  assert.equal(decryptJson('shh', undefined), null);
  assert.equal(decryptJson('shh', 'not.enough'), null);
  assert.equal(decryptJson('shh', 'not-a-real-token'), null);
});

const { sessionMatchesUser } = require('../github.js');

test('a GitHub session only matches the account it was sealed for', () => {
  assert.ok(sessionMatchesUser({ appUser: 'alice' }, 'alice'));
  // The leak this closes: alice connects, logs out, bob signs in on the same
  // browser and the surviving cookie hands him her repos.
  assert.ok(!sessionMatchesUser({ appUser: 'alice' }, 'bob'));
  assert.ok(!sessionMatchesUser({ appUser: 'alice' }, null));
});

test('sessions sealed with the gate off match only the gate-off state', () => {
  assert.ok(sessionMatchesUser({ appUser: null }, null));
  // Turning the login gate on must invalidate tokens sealed while it was off.
  assert.ok(!sessionMatchesUser({ appUser: null }, 'alice'));
});

test('a session predating this field is treated as gate-off, not as a wildcard', () => {
  assert.ok(sessionMatchesUser({ token: 'x' }, null));
  assert.ok(!sessionMatchesUser({ token: 'x' }, 'alice'));
});

test('sessionMatchesUser rejects a missing session', () => {
  assert.ok(!sessionMatchesUser(null, 'alice'));
  assert.ok(!sessionMatchesUser(undefined, null));
});

const {
  MAX_GITHUB_ACCOUNTS,
  normalizeGithubSession,
  accountsOf,
  pickAccount,
} = require('../github.js');

const acct = (login) => ({ token: 'gho_' + login, login, avatarUrl: 'https://x/' + login });
const many = (...logins) => ({ appUser: 'alice', accounts: logins.map(acct) });

test('an old single-account cookie is read, not discarded', () => {
  const old = { appUser: 'alice', token: 'gho_1', login: 'octocat', avatarUrl: 'https://x', exp: 5 };
  const migrated = normalizeGithubSession(old);
  assert.equal(migrated.accounts.length, 1);
  assert.equal(migrated.accounts[0].login, 'octocat');
  // Fields the account list doesn't own must survive the move.
  assert.equal(migrated.appUser, 'alice');
  assert.equal(migrated.exp, 5);
});

test('accountsOf drops entries with no token and handles junk', () => {
  assert.equal(accountsOf(many('a', 'b')).length, 2);
  assert.equal(accountsOf({ accounts: [{ login: 'no-token' }] }).length, 0);
  assert.equal(accountsOf(null).length, 0);
  assert.equal(accountsOf({}).length, 0);
});

test('three accounts is the cap', () => {
  assert.equal(MAX_GITHUB_ACCOUNTS, 3);
});

test('a single connected account is used without asking', () => {
  assert.equal(pickAccount(many('alice'), 'someone-else/repo').account.login, 'alice');
});

test('with several accounts the repo owner decides, case-insensitively', () => {
  assert.equal(pickAccount(many('alice', 'bob'), 'bob/thing').account.login, 'bob');
  assert.equal(pickAccount(many('alice', 'bob'), 'BOB/thing').account.login, 'bob');
});

test('an explicitly named account wins over the owner match', () => {
  assert.equal(pickAccount(many('alice', 'bob'), 'bob/thing', 'alice').account.login, 'alice');
});

test('naming an account that is not connected is an error, not a fallback', () => {
  const picked = pickAccount(many('alice', 'bob'), 'bob/thing', 'carol');
  assert.ok(!picked.account);
  assert.match(picked.error, /No connected GitHub account named "carol"/);
});

test('an ambiguous repo refuses to guess and names the choices', () => {
  // The dangerous case: committing under the wrong identity because the code
  // tried each token until one worked.
  const picked = pickAccount(many('alice', 'bob'), 'some-org/shared');
  assert.ok(!picked.account, 'must not pick an account for an org repo');
  assert.match(picked.error, /unclear which to use/);
  assert.match(picked.error, /alice, bob/);
});

test('pickAccount reports a missing connection rather than throwing', () => {
  assert.match(pickAccount(null, 'a/b').error, /not connected/);
  assert.match(pickAccount({ accounts: [] }, 'a/b').error, /not connected/);
});
