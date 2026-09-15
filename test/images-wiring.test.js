// Image generation was Puter-only, and a chat on a direct provider reported
// that as "Puter is not signed in". These tests run the shipped fallback against
// stubs, so what is exercised is the wiring as written.
//
// The chain has since grown a second job beyond picking a backend: what the
// request *is*. A generation asks for a model and a quality; an edit asks for the
// source picture through input_images, which is the field Puter documents as the
// one that routes through the image edit endpoint. A brush mask reverses the
// order, because Puter cannot take a mask at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  imageBackendOrder,
  imageFailureMessage,
  imageModelsFor,
  IMAGE_QUALITY,
  IMAGE_REFUSAL_ADVICE,
  isAccountLevelFailure,
  isModerationRefusal,
  isOutOfCreditsError,
  safeJson,
  PUTER_PROVIDER,
  imageSizeFromPrompt,
  imageSizeBody,
  imageRatioBody,
  describeDrawnSize,
  imageRatioLabel,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = [
  'puterCanDraw',
  'imageUrlsFrom',
  'generateImageSource',
  'generateImageSources',
  'editImageSource',
  'imageSourceFrom',
  'puterImageArgs',
  'imageBackendsForTurn',
  'noteDrawnSize',
];

// The conversation the request is riding on: the service answering the chat and
// the model it is using. There is no second picker to configure -- that is the
// change these tests are here for.
function harness({
  signedIn = false,
  puterResult = null,
  route = null,
  provider = PUTER_PROVIDER,
  // Whether this chat has asked for Puter to draw. Off is the shipped default,
  // so a test that wants Puter in the chain has to say so -- the same thing the
  // user has to do.
  puterImages = false,
  model = 'gpt-5.4-nano',
  dims = { width: 0, height: 0 },
} = {}) {
  const calls = { puter: [], puterOpts: [], puterPrompts: [], fetch: [] };
  const deps = {
    // The real decisions, so the wiring is tested against the shipped rules.
    imageBackendOrder,
    imageFailureMessage,
    imageModelsFor,
    IMAGE_QUALITY,
    IMAGE_REFUSAL_ADVICE,
    isModerationRefusal,
    isAccountLevelFailure,
    isOutOfCreditsError,
    safeJson,
    PUTER_PROVIDER,
    imageSizeFromPrompt,
    imageSizeBody,
    imageRatioBody,
    describeDrawnSize,
    selectedProvider: provider,
    drawWithPuter: puterImages,
    selectedModel: model,
    // Measuring a picture is a decode, which this test has no DOM for: the
    // dimensions it would have read are the input instead.
    imageDimensionsOf: async () => dims,
    imageRatioLabel,
    // The browser's Image constructor is used to measure a source picture's
    // dimensions before an edit request: the stub simulates it with the dims
    // the test already provides.
    Image: class {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
      set src(v) {
        this.naturalWidth = dims.width;
        this.naturalHeight = dims.height;
        if (this.onload) this.onload();
      }
    },
    puter: {
      ai: {
        txt2img: async (prompt, opts) => {
          calls.puter.push(opts.model);
          calls.puterOpts.push(opts || {});
          calls.puterPrompts.push(prompt);
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
  return {
    deps,
    calls,
    generate: (prompt, signal, outcome) => loaded.generateImageSource(prompt, signal, outcome),
    generateMany: (prompt, count, signal, outcome) => loaded.generateImageSources(prompt, count, signal, outcome),
    edit: (prompt, source, signal, options) => loaded.editImageSource(prompt, source, signal, options),
  };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('Puter draws once asked for, with the image model its own list names', async () => {
  // The conversation is on a chat model here, which is the ordinary case -- and
  // that is the point: Puter's images endpoint takes an image model, so the model
  // this chat is on is not something it can be asked for.
  const h = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,PUTER' }, model: 'gpt-5.4-nano' });
  assert.equal(await h.generate('a fox'), 'data:image/png;base64,PUTER');
  assert.deepEqual(h.calls.puter, [imageModelsFor('generate')[0]]);
  assert.deepEqual(h.deps.imageModelsFor('generate'), imageModelsFor('generate'));
  assert.equal(h.calls.fetch.length, 0, 'a working Puter is not second-guessed');
});

test('a chat on a server provider draws on that provider, even with Puter signed in', async () => {
  // The complaint this covers: a picture asked for while chatting on OpenRouter
  // was drawn by Puter, because the browser's own backend was consulted first
  // regardless of who was answering the conversation.
  const h = harness({
    signedIn: true,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash-image',
    route: { data: { data: [{ url: 'https://img.test/or.png' }], providerLabel: 'OpenRouter' } },
  });
  assert.equal(await h.generate('a fox'), 'https://img.test/or.png');
  assert.deepEqual(h.calls.puter, [], 'Puter is not asked first for a chat it is not answering');
  assert.equal(h.calls.fetch[0].body.preferProvider, 'openrouter');
  assert.equal(h.calls.fetch[0].body.model, 'google/gemini-2.5-flash-image');
});

test('the size a prompt asks for rides along, in the shape each backend reads', async () => {
  // Two readings of one choice: Puter's txt2img wants the ratio as {w, h}, the
  // OpenAI-shaped route wants "1536x864". Neither is derived from the other.
  const puter = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,P' } });
  await puter.generate('a 16:9 banner for the shop front');
  assert.deepEqual(puter.calls.puterOpts[0].ratio, { w: 16, h: 9 });
  assert.equal(puter.calls.puterOpts[0].model, imageModelsFor('generate')[0]);

  const route = harness({ signedIn: true, route: { data: { data: [{ url: 'u' }] } } });
  await route.generate('a 16:9 banner for the shop front');
  assert.equal(route.calls.fetch[0].body.size, '1536x864');

  // And a prompt that asks for no size sends none: a service's own default
  // beats a size this app invented.
  const plain = harness({ signedIn: true, route: { data: { data: [{ url: 'u' }] } } });
  await plain.generate('a fox');
  assert.equal(plain.calls.fetch[0].body.size, undefined);
  assert.equal(plain.calls.fetch[0].body.preferProvider, undefined, 'a chat on Puter has no server provider to prefer');
});

test('a picture drawn the wrong shape says so, and one drawn right stays quiet', async () => {
  const h = harness({
    signedIn: true, puterImages: true,
    puterResult: { src: 'data:image/png;base64,P' },
    dims: { width: 1024, height: 1024 },
  });
  const outcome = { notes: [] };
  await h.generate('a 16:9 banner with no text', null, outcome);
  assert.equal(outcome.notes.length, 1);
  assert.match(outcome.notes[0], /asked for 16:9 \(1536x864\), drawn 1:1/);

  const right = harness({
    signedIn: true, puterImages: true,
    puterResult: { src: 'data:image/png;base64,P' },
    dims: { width: 1536, height: 866 },
  });
  const clean = { notes: [] };
  await right.generate('a 16:9 banner with no text', null, clean);
  assert.deepEqual(clean.notes, [], 'a provider rounding onto its grid is not a complaint');
});

test('a chat on Puter still draws on the route while the switch is off', async () => {
  // The leak this closes: Puter signed in, the conversation on Puter, and a
  // picture asked for in passing -- which used to spend Puter credits without
  // anyone choosing to. Chat on Puter is cheap; drawing on it is not, and a
  // monthly allowance that does not roll over should not go on pictures the
  // user never picked it for.
  const h = harness({
    signedIn: true,
    provider: PUTER_PROVIDER,
    puterResult: { src: 'data:image/png;base64,SHOULD_NOT_BE_USED' },
    route: { data: { data: [{ url: 'from-the-route' }] } },
  });
  assert.equal(await h.generate('a fox in the snow'), 'from-the-route');
  assert.deepEqual(h.calls.puter, [], 'Puter was asked to draw without being chosen');
  assert.equal(h.calls.fetch.length, 1);
});

test('a route failure reports it rather than falling back onto Puter credits', async () => {
  // A silent fallback is the same leak wearing a different hat: every failing
  // route request would become a Puter charge. The message names the switch
  // instead, so spending stays a decision.
  const h = harness({
    signedIn: true,
    puterResult: { src: 'data:image/png;base64,SHOULD_NOT_BE_USED' },
    route: { ok: false, data: { error: 'no key' } },
  });
  await assert.rejects(() => h.generate('a fox'), /Draw with Puter/);
  assert.deepEqual(h.calls.puter, [], 'a failed route quietly billed Puter');
});

test('without Puter the server route draws, and Puter is never asked', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ b64_json: 'ROUTE' }] } } });
  assert.equal(await h.generate('a fox'), 'data:image/png;base64,ROUTE');
  // This is the change: a chat on a direct provider now has somewhere to draw.
  assert.deepEqual(h.calls.puter, []);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].url, '/api/llm/images/generations');
  assert.deepEqual(h.calls.fetch[0].body, { prompt: 'a fox', quality: IMAGE_QUALITY });
});

test('a URL answer is used as-is, the way the edit flow reads one', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ url: 'https://img.example/fox.png' }] } } });
  assert.equal(await h.generate('a fox'), 'https://img.example/fox.png');
});

test('every picture in a multi-image answer is read, not just the first', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ url: 'u1' }, { url: 'u2' }] } } });
  assert.deepEqual(await h.generateMany('a fox', 2), ['u1', 'u2']);
  // One request, so one bill -- the reason the count is passed at all.
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].body.n, 2);
});

test('a count the backend will not honour is topped up rather than lost', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ url: 'only-one' }] } } });
  assert.deepEqual(await h.generateMany('a fox', 2), ['only-one', 'only-one']);
  assert.equal(h.calls.fetch.length, 2, 'the missing picture is drawn by asking again');
});

test('a signed-in Puter that fails falls through to the server route', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: new Error('drawing is unavailable'), route: { data: { data: [{ url: 'u' }] } } });
  assert.equal(await h.generate('a fox'), 'u');
  // A failure that might be this one model's fault tries the next one first: the
  // rest of the list Puter publishes for the job in hand.
  assert.deepEqual(h.calls.puter, imageModelsFor('generate'));
  assert.equal(h.calls.fetch.length, 1);
});

test('a spent Puter account is not asked once per model before moving on', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: new Error('out of credits'), route: { data: { data: [{ url: 'u' }] } } });
  assert.equal(await h.generate('a fox'), 'u');
  // The account being out of credits is the same answer for every model, so the
  // second call could only buy the same refusal.
  assert.deepEqual(h.calls.puter, [imageModelsFor('generate')[0]]);
  assert.equal(h.calls.fetch.length, 1, 'and the other backend is still given its chance');
});

test('a refused prompt is reported as a refusal, not retried into a hang', async () => {
  const refused = new Error('moderation_flagged');
  refused.errorCode = 'moderation_flagged';
  const h = harness({ signedIn: true, puterImages: true, puterResult: refused, route: { data: { data: [{ url: 'u' }] } } });
  await assert.rejects(
    () => h.generate('a gory poster'),
    (err) => {
      assert.equal(err.message, IMAGE_REFUSAL_ADVICE);
      // Fewer words would be wrong twice: the other models cannot change the
      // answer either, and the other backend should not be billed to prove it.
      assert.deepEqual(h.calls.puter, [imageModelsFor('generate')[0]]);
      assert.equal(h.calls.fetch.length, 0);
      return true;
    },
  );
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
  await assert.rejects(() => h.generate('a fox'), /the image route returned no image/);
});

test('when everything fails the message names every backend, not just the last', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: new Error('not signed in'), route: { ok: false, data: { error: 'no key' } } });
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
  const h = harness({ signedIn: true, puterImages: true, puterResult: abort, route: { data: { data: [{ url: 'u' }] } } });
  await assert.rejects(() => h.generate('a fox'), /aborted/);
  // Falling through on an abort would spend the route's quota on a request the
  // user just cancelled.
  assert.equal(h.calls.fetch.length, 0);
});

// ---- what the image model is asked for -----------------------------------

test('generation asks Puter for a quality, because low is the silent default', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,PUTER' } });
  await h.generate('a fox');
  assert.equal(h.calls.puterOpts[0].quality, IMAGE_QUALITY);
  assert.equal(h.calls.puterOpts[0].input_images, undefined, 'a generation carries no source picture');
});

test('an edit is asked of the editing model, a generation of the drawing one', async () => {
  const drawn = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,P' } });
  assert.equal(await drawn.generate('a fox'), 'data:image/png;base64,P');
  assert.equal(drawn.calls.puterOpts[0].model, imageModelsFor('generate')[0]);

  const edited = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,E' } });
  assert.equal(await edited.edit('make it red', 'src'), 'data:image/png;base64,E');
  assert.equal(edited.calls.puterOpts[0].model, imageModelsFor('edit')[0]);
  assert.notEqual(imageModelsFor('edit')[0], imageModelsFor('generate')[0]);
});

test('the chat model is never handed to Puter, whichever service the chat is on', async () => {
  // An id from another catalogue is not an image model, so neither of these can
  // be asked of Puter: the first because the chat is on Puter, the second
  // because the chat is elsewhere. Both used to travel.
  for (const options of [{ model: 'gpt-5.4-nano' }, { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' }]) {
    const h = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,P' }, ...options });
    await h.generate('a fox');
    assert.deepEqual(h.calls.puter, [imageModelsFor('generate')[0]], JSON.stringify(options));
  }
});

// ---- edits --------------------------------------------------------------

test('a signed-in Puter edits first, and the server route is not touched', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: { src: 'data:image/png;base64,EDITED' } });
  const out = await h.edit('make it red', 'data:image/png;base64,CAR');
  assert.equal(out, 'data:image/png;base64,EDITED');
  assert.deepEqual(h.calls.puter, [imageModelsFor('edit')[0]]);
  // The source image reaches Puter in the field its docs name as the one that
  // routes through the image edit endpoint.
  assert.deepEqual(h.calls.puterOpts[0].input_images, ['data:image/png;base64,CAR']);
  assert.equal(h.calls.puterOpts[0].input_image, undefined, 'the shorthand is not what routes an edit');
  assert.equal(h.calls.fetch.length, 0, 'a working Puter is not second-guessed');
});

test('without Puter the server edit route runs, and Puter is never asked', async () => {
  const h = harness({ signedIn: false, route: { data: { data: [{ url: 'u' }] } } });
  const out = await h.edit('make it red', 'data:image/png;base64,CAR');
  assert.equal(out, 'u');
  assert.deepEqual(h.calls.puter, []);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].url, '/api/llm/images/edits');
  assert.deepEqual(h.calls.fetch[0].body, {
    prompt: 'make it red',
    image: 'data:image/png;base64,CAR',
    quality: IMAGE_QUALITY,
  });
});

test('a painted mask goes to the route first, because Puter has no mask field', async () => {
  const h = harness({ signedIn: true, puterImages: true, route: { data: { data: [{ url: 'masked' }] } } });
  const notes = [];
  const out = await h.edit('add horns', 'data:image/png;base64,CAR', null, { mask: 'data:image/png;base64,MASK', notes });
  assert.equal(out, 'masked');
  assert.deepEqual(h.calls.puter, [], 'the region the user painted is not silently ignored');
  assert.equal(h.calls.fetch[0].body.mask, 'data:image/png;base64,MASK');
  assert.deepEqual(notes, []);
});

test('a route that cannot take the mask still edits, and says the mask was dropped', async () => {
  // The bug this covers: a signed-in Puter user with no Nara key painted a
  // region, the route refused for want of a model alias, and the brush editor
  // produced nothing at all.
  const h = harness({
    signedIn: true, puterImages: true,
    puterResult: { src: 'data:image/png;base64,EDITED' },
    route: { ok: false, data: { error: 'Image editing needs NARA_IMAGE_MODEL set to an image-capable alias.' } },
  });
  const notes = [];
  const out = await h.edit('add horns', 'data:image/png;base64,CAR', null, { mask: 'data:image/png;base64,MASK', notes });
  assert.equal(out, 'data:image/png;base64,EDITED');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /mask was dropped/);
  // And without the mask, since Puter cannot take one.
  assert.equal(h.calls.puterOpts[0].input_images.length, 1);
});

test('a Puter edit failure falls through to the server route', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: new Error('drawing is unavailable'), route: { data: { data: [{ url: 'u' }] } } });
  assert.equal(await h.edit('make it red', 'src'), 'u');
  assert.deepEqual(h.calls.puter, imageModelsFor('edit'));
  assert.equal(h.calls.fetch.length, 1);
});

test('an edit failure says what was edited with and names every backend', async () => {
  const h = harness({ signedIn: false, route: { ok: false, data: { error: 'Image editing needs NARA_IMAGE_MODEL set to an image-capable alias.' } } });
  await assert.rejects(
    () => h.edit('make it red', 'src'),
    (err) => {
      assert.match(err.message, /Could not edit an image/);
      assert.match(err.message, /server image route \(Image editing needs NARA_IMAGE_MODEL/);
      return true;
    },
  );
});

test('a spent Puter account on an edit moves on to the route after one ask', async () => {
  const h = harness({ signedIn: true, puterImages: true, puterResult: new Error('out of credits'), route: { data: { data: [{ url: 'u' }] } } });
  assert.equal(await h.edit('make it red', 'src'), 'u');
  assert.deepEqual(h.calls.puter, [imageModelsFor('edit')[0]]);
  assert.equal(h.calls.fetch.length, 1);
});

test('stopping an edit does not quietly start a second one', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const h = harness({ signedIn: true, puterImages: true, puterResult: abort, route: { data: { data: [{ url: 'u' }] } } });
  await assert.rejects(() => h.edit('make it red', 'src'), /aborted/);
  assert.equal(h.calls.fetch.length, 0);
});
