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
  DEFAULT_VISION_MODEL,
  PUTER_PROVIDER,
  imageCheckQuestion,
  parseImageCheck,
  isVisionCapable,
  extractMessageText,
} = require('../chatlib.js');
const { acceptsImages, isSendableImageUrl } = require('../attachment-helpers.js');
const routing = require('../provider-routing.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

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
  assert.equal(parseImageCheck('No: the car is blue').missed, 'the car is blue');
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
  // A turn with no separate request (a brush instruction, or the caption's own
  // prompt) is still a question with both halves filled in.
  assert.match(imageCheckQuestion('', 'a red fox'), /The request:\na red fox/);
  // And the prompt the caller's judgement is about is what the system prompt
  // says to judge the *picture* against the request, not the prompt.
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
  // The caller's own named cheap eye wins, which is how Puter's list is read.
  assert.equal(routing.cheapestVisionModel(models, { preferred: 'flagship-vision' }), 'flagship-vision');
  assert.equal(routing.cheapestVisionModel(models, { preferred: 'not-in-the-list' }), 'mini-vision');
});

// ---- the page's two choices ----------------------------------------------

const NAMES = ['imageCheckModel', 'checkDrawingAgainstRequest'];

function harness({ provider = 'openrouter', models = [], answer = 'MATCHES', fails = false } = {}) {
  const calls = { model: [], notes: [] };
  const deps = {
    // The shipped rules, and the shipped routing module.
    FreeOpenAIProviderRouting: routing,
    isVisionCapable,
    acceptsImages,
    DEFAULT_VISION_MODEL,
    PUTER_PROVIDER,
    IMAGE_CHECK_PROMPT,
    imageCheckQuestion,
    parseImageCheck,
    isSendableImageUrl,
    extractMessageText,
    selectedProvider: provider,
    routableModels: () => models,
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
  assertSandboxCoverCalls();
});

// assertSandboxCovers needs the same deps shape the harness builds, so the check
// runs against it rather than against a hand-written list.
function assertSandboxCoverCalls() {
  const { deps } = harness();
  assertSandboxCovers(NAMES, deps);
}

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

test('Puter’s list names its vision models rather than describing them', async () => {
  const h = harness({
    provider: 'puter',
    // No `vision` field at all, which is what Puter's built-in list looks like.
    models: [{ id: 'gpt-6-astra' }, { id: DEFAULT_VISION_MODEL }, { id: 'gpt-4o-mini' }],
  });
  await h.checkDrawingAgainstRequest(ELEMENT, 'data:image/png;base64,AAA', 'a fox', 'a fox');
  assert.deepEqual(h.calls.model, [DEFAULT_VISION_MODEL]);
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
