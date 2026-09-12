const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAGE_BACKENDS, imageBackendOrder, imageFailureMessage } = require('../chatlib.js');

test('a signed-in Puter is tried first, and the server route is always behind it', () => {
  assert.deepEqual(imageBackendOrder({ puterSignedIn: true }), ['puter', 'server']);
  // Without Puter the route is the only way to draw, which is the whole point:
  // a chat on a direct provider could not produce an image at all before.
  assert.deepEqual(imageBackendOrder({ puterSignedIn: false }), ['server']);
  assert.deepEqual(imageBackendOrder(), ['server']);
});

test('the order never comes back empty, whatever it is asked', () => {
  for (const input of [{ puterSignedIn: false }, { puterSignedIn: true }, {}, null, undefined]) {
    const order = imageBackendOrder(input);
    assert.ok(order.length >= 1, 'a request with no backend would fail with nothing to say');
    for (const backend of order) assert.ok(IMAGE_BACKENDS.includes(backend));
  }
});

test('a failure names every backend that was tried, not just the last', () => {
  // The behaviour this replaces: a provider-only setup was told "Puter is not
  // signed in", which names something the user was not using.
  const both = imageFailureMessage({ puterError: 'not signed in', serverError: 'no key' });
  assert.match(both, /Puter \(not signed in\)/);
  assert.match(both, /the server image route \(no key\)/);
  assert.match(both, / and /);

  const onlyServer = imageFailureMessage({ serverError: 'Image generation needs a Nara key' });
  assert.match(onlyServer, /server image route \(Image generation needs a Nara key\)/);
  assert.equal(onlyServer.includes('Puter'), false, 'a backend that was never tried is not blamed');

  assert.match(imageFailureMessage({}), /no backend was available/);
  assert.match(imageFailureMessage(), /no backend was available/);
});
