const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAGE_BACKENDS, imageBackendOrder, imageFailureMessage } = require('../chatlib.js');

test('a signed-in Puter is not drawn with until it is asked for by name', () => {
  // The cost is the reason. A Puter account gets a fixed monthly allowance that
  // does not roll over and images are the dearest thing on it, so a picture
  // nobody pointed at Puter goes to a free provider key instead. Signed in is
  // not a request to start spending.
  assert.deepEqual(imageBackendOrder({ puterSignedIn: true }), ['server']);
  assert.deepEqual(imageBackendOrder({ puterSignedIn: true, puterChosen: true }), ['puter', 'server']);
  // Without Puter the route is the only way to draw, which is the whole point:
  // a chat on a direct provider could not produce an image at all before.
  assert.deepEqual(imageBackendOrder({ puterSignedIn: false }), ['server']);
  assert.deepEqual(imageBackendOrder({ puterSignedIn: false, puterChosen: true }), ['server']);
  assert.deepEqual(imageBackendOrder(), ['server']);
});

test('the order never comes back empty, whatever it is asked', () => {
  const inputs = [
    { puterSignedIn: false }, { puterSignedIn: true }, { puterSignedIn: true, puterChosen: true },
    { puterChosen: true }, {}, null, undefined,
  ];
  for (const input of inputs) {
    const order = imageBackendOrder(input);
    assert.ok(order.length >= 1, 'a request with no backend would fail with nothing to say');
    for (const backend of order) assert.ok(IMAGE_BACKENDS.includes(backend));
  }
});

test('a painted mask puts the route first even when Puter was asked for', () => {
  // Puter has no mask field at all, so a mask can only be expressed by the
  // route -- but the route is not a reason to stop offering Puter afterwards,
  // which is what keeps a mask edit from producing nothing at all.
  const chosen = { puterSignedIn: true, puterChosen: true };
  assert.deepEqual(imageBackendOrder({ ...chosen, serverFirst: true }), ['server', 'puter']);
  assert.deepEqual(imageBackendOrder({ ...chosen, serverFirst: false }), ['puter', 'server']);
  // With no Puter account, and with one that was not asked for, there is nothing
  // to reverse: the route is the only backend either way.
  assert.deepEqual(imageBackendOrder({ puterSignedIn: false, serverFirst: true }), ['server']);
  assert.deepEqual(imageBackendOrder({ puterSignedIn: true, serverFirst: true }), ['server']);
});

test('a route-only failure offers Puter, and only when Puter is really a way out', () => {
  // The message has to be actionable: a route that failed with an unused Puter
  // account sitting there should say so, because turning one switch on is the
  // fix. Saying it when Puter has *also* just failed would be advice to retry
  // the thing that did not work.
  const offered = imageFailureMessage({ serverError: 'no key', puterAvailable: true });
  assert.match(offered, /Draw with Puter/);
  assert.match(offered, /session panel/);

  const bothFailed = imageFailureMessage({ puterError: 'out of credits', serverError: 'no key', puterAvailable: true });
  assert.equal(bothFailed.includes('Draw with Puter'), false, 'a backend that just failed is not offered as the fix');

  const noAccount = imageFailureMessage({ serverError: 'no key' });
  assert.equal(noAccount.includes('Draw with Puter'), false, 'an account that cannot draw is not offered');
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

test('an edit failure says "edit", not "generate"', () => {
  const msg = imageFailureMessage({ puterError: 'not signed in', serverError: 'no key' }, 'edit');
  assert.match(msg, /Could not edit an image/);
  assert.match(msg, /Puter \(not signed in\)/);
  assert.match(msg, /the server image route \(no key\)/);
  // The default stays 'generate' so the generation path is unchanged.
  assert.match(imageFailureMessage({ serverError: 'x' }), /Could not generate an image/);
});
