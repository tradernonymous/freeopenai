// Image generation was Puter-only, and a chat on a direct provider reported
// that as "Puter is not signed in". These tests run the shipped fallback against
// stubs, so what is exercised is the wiring as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  imageBackendOrder,
  imageFailureMessage,
  IMAGE_BACKENDS,
  isAccountLevelFailure,
  isOutOfCreditsError,
  safeJson,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['puterCanDraw', 'imageUrlFrom', 'generateImageSource'];

function harness({ signedIn = false, puterResult = null, route = null } = {}) {
  const calls = { puter: [], fetch: [] };
  const deps = {
    // The real decisions, so the wiring is tested against the shipped rules.
    imageBackendOrder,
    imageFailureMessage,
    IMAGE_BACKENDS,
    isAccountLevelFailure,
    isOutOfCreditsError,
    safeJson,
    IMAGE_MODELS: ['gpt-image-2', 'gpt-image-1.5'],
    puter: {
      ai: {
        txt2img: async (prompt, opts) => {
          calls.puter.push(opts.model);
          if (typeof puterResult === 'function') return puterResult(opts.model);
          if (puterResult instanceof Error) throw puterResult;
          return puterResult;
        },
      },
      auth: { isSignedIn: () => signedIn },
    },
    fetch: async (url, init) => {
      calls.fetch.push({ url, body: JSON.parse(init.body) });
      const answer = typeof route === 'function' ? route() : route;
      if (!answer) throw new Error('the route was not expected to be called');
      if (answer.throws) throw answer.throws;
      return {
        ok: answer.ok !== false,
        status: answer.status || (answer.ok === false ? 400 : 200),
        json: async () => answer.data,
        text: async () => JSON.stringify(answer.data),
      };
    },
  };
  const loaded = loadFromIndex(NAMES, deps);
  return { deps, calls, generate: (prompt, signal) => loaded.generateImageSource(prompt, signal) };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a signed-in Puter draws first and the server route is not touched', async () => {
  const h = harness({ signedIn: true, puterResult: { src: 'data:image/png;base64,PUTER' } });
  assert.equal(await h.generate('a fox'), 'data:image/png;base64,PUTER');
  assert.deepEqual(h.calls.puter, ['gpt-image-2']);
  assert.equal(h.calls.fetch.length, 0, 'a working Puter is not second-guessed');
});

test('without Puter the server route draws, and Puter is never asked', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ b64_json: 'ROUTE' }] } } });
  assert.equal(await h.generate('a fox'), 'data:image/png;base64,ROUTE');
  // This is the change: a chat on a direct provider now has somewhere to draw.
  assert.deepEqual(h.calls.puter, []);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].url, '/api/llm/images/generations');
  assert.deepEqual(h.calls.fetch[0].body, { prompt: 'a fox' });
});

test('a URL answer is used as-is, the way the edit flow reads one', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ url: 'https://img.example/fox.png' }] } } });
  assert.equal(await h.generate('a fox'), 'https://img.example/fox.png');
});

test('a signed-in Puter that fails falls through to the server route', async () => {
  const h = harness({ signedIn: true, puterResult: new Error('drawing is unavailable'), route: { data: { data: [{ url: 'u' }] } } });
  assert.equal(await h.generate('a fox'), 'u');
  // A failure that might be this one model's fault tries the next model first.
  assert.deepEqual(h.calls.puter, ['gpt-image-2', 'gpt-image-1.5']);
  assert.equal(h.calls.fetch.length, 1);
});

test('a spent Puter account is not asked once per model before moving on', async () => {
  const h = harness({ signedIn: true, puterResult: new Error('out of credits'), route: { data: { data: [{ url: 'u' }] } } });
  assert.equal(await h.generate('a fox'), 'u');
  // The account being out of credits is the same answer for every model, so the
  // second call could only buy the same refusal.
  assert.deepEqual(h.calls.puter, ['gpt-image-2']);
  assert.equal(h.calls.fetch.length, 1, 'and the other backend is still given its chance');
});

test('a route that refuses is reported with its own message, and names what was tried', async () => {
  const h = harness({ signedIn: false, route: { ok: false, data: { error: 'Image generation needs a Nara key (NARA_API_KEY).' } } });
  await assert.rejects(
    () => h.generate('a fox'),
    (err) => {
      assert.match(err.message, /Could not generate an image/);
      assert.match(err.message, /server image route \(Image generation needs a Nara key/);
      return true;
    },
  );
});

test('an image-less success is a failure, not an empty picture', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [] } } });
  await assert.rejects(() => h.generate('a fox'), /the route returned no image/);
});

test('when everything fails the message names every backend, not just the last', async () => {
  const h = harness({ signedIn: true, puterResult: new Error('not signed in'), route: { ok: false, data: { error: 'no key' } } });
  await assert.rejects(
    () => h.generate('a fox'),
    (err) => {
      // The old behaviour named only Puter, which was not even in use.
      assert.match(err.message, /Puter \(not signed in\)/);
      assert.match(err.message, /server image route \(no key\)/);
      return true;
    },
  );
});

test('stopping a generation does not quietly start a second one', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const h = harness({ signedIn: true, puterResult: abort, route: { data: { data: [{ url: 'u' }] } } });
  await assert.rejects(() => h.generate('a fox'), /aborted/);
  // Falling through on an abort would spend the route's quota on a request the
  // user just cancelled.
  assert.equal(h.calls.fetch.length, 0);
});
