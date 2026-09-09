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
