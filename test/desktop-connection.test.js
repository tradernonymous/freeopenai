// What the engine said, in the words the user sees. Before this module the
// same decision was made three times (api.ts built the ApiError text, App.tsx
// built the banner, Terminal.tsx prefixed whatever it was handed), so a 401 and
// a dead network could not be told apart anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const connection = require('../desktop/src/connection.js');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const read = (...parts) => fs.readFileSync(path.join(DESKTOP, ...parts), 'utf8');

test('an outcome classifies by status, not by guesswork', () => {
  // A 2xx is a kind too: the shell classifies its healthy probe as well, and a
  // success that fell through to "rejected" made the app hide behind connect.
  assert.equal(connection.classify({ status: 200 }).kind, 'ok');
  assert.equal(connection.classify({ status: 204 }).kind, 'ok');
  assert.equal(connection.classify({ status: 401 }).kind, 'signed-out');
  assert.equal(connection.classify({ status: 403 }).kind, 'refused');
  assert.equal(connection.classify({ status: 404 }).kind, 'rejected');
  assert.equal(connection.classify({ status: 422 }).kind, 'rejected');
  assert.equal(connection.classify({ status: 500 }).kind, 'engine-error');
  assert.equal(connection.classify({ status: 503 }).kind, 'engine-error');
  // No status at all means the request never got an answer.
  assert.equal(connection.classify({}).kind, 'unreachable');
  assert.equal(connection.classify({ status: 0 }).kind, 'unreachable');
  // An ApiError carries its own status; classify can read it directly.
  assert.equal(connection.classify({ error: { status: 401 } }).kind, 'signed-out');
});

test('the engine keeps its own words when it has any', () => {
  const refusal = connection.classify({ status: 403, message: 'WORKSPACE_RUN is not enabled.' });
  assert.equal(refusal.message, 'WORKSPACE_RUN is not enabled.');
  const rejected = connection.classify({ status: 422 });
  assert.equal(rejected.message, 'HTTP 422', 'no message means the status line');
});

test('"could not reach" names the origin, and "sign-in required" says only that', () => {
  const offline = connection.classify({ origin: 'https://engine.test' });
  assert.match(offline.message, /Could not reach https:\/\/engine\.test/);
  assert.match(offline.message, /Settings/, 'the message says where to fix the address');
  assert.equal(connection.classify({ status: 401 }).message, 'Sign-in required');
  assert.equal(connection.messageFor('no-reply'), 'The provider sent no readable reply.');
});

test('the banner is only for the states that need one', () => {
  assert.match(connection.bannerFor('unreachable'), /Cannot reach the engine/);
  assert.match(connection.bannerFor('signed-out'), /sign in/i);
  // The engine answered but is broken: the app stays up, so it says so in a
  // banner instead of hiding behind the connect surface.
  assert.match(connection.bannerFor('engine-error'), /having trouble/);
  // A refusal and a rejected request are not banner states: the screen that
  // made the call reports them, and a shell-wide banner would blame the link.
  assert.equal(connection.bannerFor('refused'), null);
  assert.equal(connection.bannerFor('rejected'), null);
  assert.equal(connection.bannerFor('no-reply'), null);
  assert.equal(connection.bannerFor('ok'), null, 'a healthy engine says nothing');
});

test('every kind is classified and described', () => {
  for (const kind of connection.KINDS) {
    const message = connection.messageFor(kind, { status: 400, origin: 'https://e.test' });
    assert.equal(typeof message, 'string');
    assert.ok(message.length, `${kind} has copy`);
  }
});

// ---- one owner for the copy ---------------------------------------------

test('api.ts asks the module instead of writing the copy itself', () => {
  const api = read('src', 'api.ts');
  assert.match(api, /connection\.classify\(/);
  assert.match(api, /connection\.messageFor\('no-reply'\)/);
  assert.doesNotMatch(api, /Could not reach \$/, 'the sentence is not built here any more');
  assert.match(api, /Sign-in required|classify\(\{ status: 401 \}\)/, 'the 401 text comes from the module');
});

test('the shell banner comes from the module too', () => {
  const app = read('src', 'App.tsx');
  assert.match(app, /connection\.bannerFor\(/);
  assert.doesNotMatch(app, /Cannot reach the engine right now/,
    'the banner sentence has one owner, and it is not App.tsx');
});
