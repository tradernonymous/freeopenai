// Reading a drawing back against the request that asked for it.
//
// The prompt an image model receives is a rewrite of what the user said, and the
// picture is judged -- by the person who asked -- against what they said. Nothing
// compared the two: a drawing that met its prompt but missed the request looked
// exactly like a good one. This is the question that closes that loop, the model
// that answers it, and the one line it is allowed to leave behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IMAGE_CHECK_PROMPT,
  MAX_IMAGE_CHECK_CHARS,
  PUTER_PROVIDER,
  imageCheckQuestion,
  imageCheckFixPrompt,
  parseImageCheck,
  isVisionCapable,
  extractMessageText,
} = require('../chatlib.js');
const { acceptsImages, isSendableImageUrl } = require('../attachment-helpers.js');
const routing = require('../provider-routing.js');
const { loadFromIndex, sourceOf, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

// ---- the verdict ----------------------------------------------------------

test('a verdict is read from the one line that is one', () => {
  assert.deepEqual(parseImageCheck('MATCHES'), { matches: true, missed: '' });
  assert.deepEqual(parseImageCheck('matches.'), { matches: true, missed: '' });
  // A model that introduces itself is still answering, so the verdict line is
  // the one that is read rather than the first line.
  assert.deepEqual(parseImageCheck('Looking at it:\nMISSED: the sign reads HLLO'), {
    matches: false, missed: 'the sign reads HLLO',
  });
  // Several forms of the same answer, because the prompt's exact wording is not
  // a contract any model keeps.
  assert.equal(parseImageCheck('MISSED: no bicycle in the picture').missed, 'no bicycle in the picture');
  assert.equal(parseImageCheck('MISS: only four candles, not six').missed, 'only four candles, not six');
  assert.equal(parseImageCheck('No, the car is blue').missed, 'the car is blue');
  assert.equal(parseImageCheck('MISSED — the text is misspelled').missed, 'the text is misspelled');
});

test('an answer that is not a verdict is no verdict, never a guess', () => {
  // The one failure that matters: a note beside a picture that says something
  // the check did not. Anything unreadable is silence.
  for (const text of [
    '',
    null,
    undefined,
    'The picture shows a red car in a street with a sign.',
    'It is hard to say without more context.',
    'MISSED:',            // a miss with nothing named is not actionable
    'MISSED:   ',
    '{}',
  ]) {
    assert.equal(parseImageCheck(text), null, JSON.stringify(text) + ' is not a verdict');
  }
});

test('the one thing that differs is bounded, because it sits under a picture', () => {
  const long = parseImageCheck('MISSED: ' + 'x'.repeat(400));
  assert.equal(long.missed.length, MAX_IMAGE_CHECK_CHARS);
  // Quoted differences are unwrapped rather than shown with the quotes.
  assert.equal(parseImageCheck('MISSED: "the sign reads HLLO"').missed, 'the sign reads HLLO');
});

test('the question shows both halves, because the two disagreeing is the point', () => {
  const question = imageCheckQuestion('draw a poster that says HELLO', 'A poster reading "HELLO", flat vector style');
  assert.match(question, /The request:\ndraw a poster that says HELLO/);
  assert.match(question, /The prompt the image model was given:\nA poster reading "HELLO", flat vector style/);
  // And the system prompt says to judge the *picture* against the request, not
  // the picture against the prompt it was drawn from.
  assert.match(IMAGE_CHECK_PROMPT, /Judge the picture, not the prompt/);
});

// ---- the model that looks -------------------------------------------------

test('the cheapest model that can see is the one that looks', () => {
  const models = [
    { id: 'flagship-vision', vision: true, pricing: { prompt: '0.01', completion: '0.03' } },
    { id: 'mini-vision', vision: true, pricing: { prompt: '0.0001', completion: '0.0002' } },
    { id: 'text-only', pricing: { prompt: '0.0000001' } },
  ];
  assert.equal(routing.cheapestVisionModel(models), 'mini-vision');
  // A free model wins outright, and a model with no price at all comes last
  // rather than never: an unknown-cost review still beats no review.
  assert.equal(routing.cheapestVisionModel([{ id: 'paid-vision', vision: true, pricing: { prompt: '0.01' } }, { id: 'free-vision', vision: true, pricing: { prompt: '0', completion: '0' } }]), 'free-vision');
  assert.equal(routing.cheapestVisionModel([{ id: 'unknown-cost', vision: true }, { id: 'paid-vision', vision: true, pricing: { prompt: '0.01' } }]), 'paid-vision');
  // A service whose catalogue names nothing that can see leaves no note at all.
  assert.equal(routing.cheapestVisionModel([{ id: 'text-only' }]), '');
  assert.equal(routing.cheapestVisionModel([]), '');
  assert.equal(routing.cheapestVisionModel(null), '');
  // Capability is the caller's to define, because a service may name its vision
  // models in its own list rather than describing them.
  assert.equal(routing.cheapestVisionModel([{ id: 'named-by-the-caller' }], { acceptsImages: () => true }), 'named-by-the-caller');
});

// ---- the page's two choices ----------------------------------------------

const NAMES = ['imageCheckModel', 'checkDrawingAgainstRequest'];

function harness({ provider = 'openrouter', models = [], vision = null, answer = 'MATCHES', fails = false } = {}) {
  const calls = { model: [], notes: [] };
  const deps = {
    // The shipped rules, and the shipped routing module.
    NeuraOSProviderRouting: routing,
    isVisionCapable,
    acceptsImages,
    PUTER_PROVIDER,
    IMAGE_CHECK_PROMPT,
    imageCheckQuestion,
    parseImageCheck,
    isSendableImageUrl,
    extractMessageText,
    selectedProvider: provider,
    routableModels: () => models,
    // The uncapped catalogue, which is the same list unless a test is asking
    // about the picker's sixty-row window.
    providerVision: vision || models,
    callModel: async (convo, extra, signal, model) => {
      calls.model.push(model);
      calls.convo = convo;
      if (fails) throw new Error('the provider said no');
      return { message: { role: 'assistant', content: answer } };
    },
    appendImageCheckNote: (el, check) => calls.notes.push(check),
  };
  return { calls, deps, ...loadFromIndex(NAMES, deps) };
}

const ELEMENT = { parentNode: {} };

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  // Against the deps the harness builds, rather than a hand-written list.
  assertSandboxCovers(NAMES, harness().deps);
});

test('a drawing is read back by a model that can see, and by a cheap one', async () => {
  const h = harness({
    models: [
      { id: 'flagship-vision', vision: true, pricing: { prompt: '0.01' } },
      { id: 'mini-vision', vision: true, pricing: { prompt: '0.0001' } },
    ],
    answer: 'MISSED: the sign reads HLLO, not HELLO',
  });
  await h.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a poster that says HELLO', 'A poster reading "HELLO"');
  assert.deepEqual(h.calls.model, ['mini-vision'], 'the flagship is not asked to review a picture');
  // The picture rides as a content part, and the question carries both the
  // request and the prompt that was sent.
  assert.equal(h.calls.convo[0].content, IMAGE_CHECK_PROMPT);
  const parts = h.calls.convo[1].content;
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,AAA');
  assert.match(parts[0].text, /a poster that says HELLO/);
  assert.deepEqual(h.calls.notes, [{ matches: false, missed: 'the sign reads HLLO, not HELLO' }]);
});

test('the read-back is offered the whole catalogue, not the picker’s sixty rows', async () => {
  // The picker lists the first sixty rows, which is what it should do. The eye
  // that reads a drawing back is chosen from everything the provider publishes:
  // on a gateway whose cheap vision models rank below the cap, the capped list
  // offered none of them and "the cheapest eye" became an alphabetically-first
  // flagship -- a quota-blocked one, in the run that found this.
  const h = harness({
    models: [{ id: 'picker-vision', vision: true, pricing: { prompt: '0.0001' } }],
    vision: [
      { id: 'flagship-vision', vision: true, pricing: { prompt: '0.01' } },
      { id: 'mini-vision', vision: true, pricing: { prompt: '0.0001' } },
    ],
  });
  await h.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a fox', 'a fox');
  assert.deepEqual(h.calls.model, ['mini-vision']);
});

test('the page keeps that catalogue beside the picker list', () => {
  const source = sourceOf('loadProviderModels');
  assert.match(source, /providerVision = usableChatModels\(data, Infinity\)\.filter\(\(m\) => m\.vision === true\)/);
  // And a provider the page could not read leaves no stale list behind, which is
  // how the check would otherwise pick an eye from the provider before last.
  assert.match(source, /providerVision = \[\]/);
});

// ---- the fix ---------------------------------------------------------------

test('the prompt for a corrected drawing carries the difference, verbatim', () => {
  const folded = imageCheckFixPrompt('A poster reading "HELLO"', 'the sign reads HLLO, not HELLO');
  assert.equal(folded, 'A poster reading "HELLO"\n\nCorrect this in the next attempt: the sign reads HLLO, not HELLO');
  // The original prompt survives intact: the retry is the same picture asked for
  // again, not a new one described from the difference alone.
  assert.ok(folded.startsWith('A poster reading "HELLO"'));
});

test('nothing to fix is no prompt at all', () => {
  // Either half missing means the render would repeat the picture it replaces --
  // and an empty prompt is not something an image service should be sent.
  assert.equal(imageCheckFixPrompt('', 'the sign reads HLLO'), '');
  assert.equal(imageCheckFixPrompt('   ', 'the sign reads HLLO'), '');
  assert.equal(imageCheckFixPrompt('a fox', ''), '');
  assert.equal(imageCheckFixPrompt(null, null), '');
  assert.equal(imageCheckFixPrompt('a fox', undefined), '');
});

test('a difference longer than a verdict is cut, not carried whole', () => {
  // The cap the verdict itself is held to, because this text goes into a prompt
  // the user pays for.
  const long = 'x'.repeat(MAX_IMAGE_CHECK_CHARS + 50);
  const folded = imageCheckFixPrompt('a fox', long);
  assert.equal(folded.length, 'a fox'.length + '\n\nCorrect this in the next attempt: '.length + MAX_IMAGE_CHECK_CHARS);
});

test('the brush editor reads its edit back, against the words that were typed', () => {
  // Deliberately kept, so it is pinned here rather than left to the next
  // reader's judgement: an edit is a request like any other, and the brush is
  // the one path where the app can quietly deliver something else -- a service
  // that takes a reference drops the mask and edits the whole picture. The
  // reviewer never sees the mask, so its verdict covers the whole picture; the
  // note only ever speaks and redraws nothing, which is what makes that
  // tolerable on a region the user did not ask about.
  const source = sourceOf('runBrushEdit');
  assert.match(source, /checkDrawingAgainstRequest\(bubble, url, typed, prompt, \(difference\) =>/,
    'an edit typed into the brush box is checked against what was typed, not the rewrite');
  // And its fix repeats the same brush edit -- same source, same mask, difference
  // folded in -- rather than drawing those words as a new picture.
  assert.match(source, /runBrushEdit\(typed, srcData, maskData, imageCheckFixPrompt\(prompt, difference\)\)/);
});

test('Puter’s list names its vision models rather than describing them', async () => {
  const models = [{ id: 'gpt-6-astra' }, { id: 'gpt-5.4-nano' }, { id: 'gpt-4o-mini' }];
  const h = harness({ provider: 'puter', models });
  await h.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a fox', 'a fox');
  // A row with no `vision` field is still a model that can see when its id says
  // so, and one of them is the one asked to look.
  assert.equal(h.calls.model.length, 1);
  assert.equal(isVisionCapable(h.calls.model[0]), true);
  assert.equal(h.calls.notes.length, 1);
});

test('a service with nothing that can see leaves no note, and makes no call', async () => {
  const h = harness({ models: [{ id: 'text-only', pricing: { prompt: '0' } }] });
  await h.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a fox', 'a fox');
  assert.deepEqual(h.calls.model, [], 'nothing can see, so nothing is asked');
  assert.deepEqual(h.calls.notes, []);
});

test('a check that could not be made, or made no sense, says nothing', async () => {
  // A provider refusing is not a failed turn and must not be reported as one.
  const failed = harness({ models: [{ id: 'mini-vision', vision: true, pricing: { prompt: '0.0001' } }], fails: true });
  await failed.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a fox', 'a fox');
  assert.deepEqual(failed.calls.notes, []);
  // And an answer that is not a verdict leaves no note rather than a guess.
  const vague = harness({ models: [{ id: 'mini-vision', vision: true, pricing: { prompt: '0.0001' } }], answer: 'It looks like a picture of a fox.' });
  await vague.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a fox', 'a fox');
  assert.deepEqual(vague.calls.notes, []);
  // A picture that cannot be sent is not checked either.
  const unsendable = harness({ models: [{ id: 'mini-vision', vision: true, pricing: { prompt: '0.0001' } }] });
  await unsendable.checkDrawingAgainstRequest(ELEMENT, 'javascript:alert(1)', 'a fox', 'a fox');
  assert.deepEqual(unsendable.calls.model, []);
});
