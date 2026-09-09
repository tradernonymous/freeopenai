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
