// When a model does not answer, the app has to say three different things: what
// it asked, what the provider said, and what to do next.
//
// The complaint this pins is concrete: the error on screen was about a model
// nobody had selected ("Rate limit reached for model meta-llama/llama-4-scout"),
// because the provider's own words were shown as the whole story under a label
// that named something else. So `attribute()` leads with what was ASKED, quotes
// the provider separately, and adds advice of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const failure = require('../desktop/src/failure.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('the name of what was asked is provider and model together', () => {
  assert.equal(
    failure.askedName({ providerLabel: 'Kilo Code', model: 'kilo-auto/free' }),
    'Kilo Code · kilo-auto/free',
  );
  assert.equal(failure.askedName({ provider: 'groq', model: 'llama-3.3-70b' }), 'groq · llama-3.3-70b');
  assert.equal(failure.askedName({ model: 'kilo-auto/free' }), 'kilo-auto/free');
  assert.equal(failure.askedName({ providerLabel: 'Groq' }), 'Groq');
  assert.equal(failure.askedName({}), '');
});

test('a provider error is classified, and the summary names the model that was asked', () => {
  const told = failure.attribute({
    providerLabel: 'Kilo Code',
    model: 'kilo-auto/free',
    message: 'Rate limit reached for model meta-llama/llama-4-scout in organization org_01m3 on tokens per minute (TPM): Limit 30000, Used 23082',
  });
  assert.equal(told.kind, 'rate-limit');
  assert.equal(told.asked, 'Kilo Code · kilo-auto/free');
  assert.equal(told.summary, 'Kilo Code · kilo-auto/free did not answer');
  assert.equal(told.retryable, true);
  // The provider's words are kept -- they are the evidence -- but as detail.
  assert.match(told.upstream, /Rate limit reached for model/);
  assert.match(told.advice, /rate-limited/i);
});

test('each class of failure gets its own advice, and the ones worth retrying say so', () => {
  const cases = [
    ['Rate limit reached for model x', 'rate-limit', true],
    ['Upstream error from Nvidia: Service temporarily overloaded', 'overloaded', true],
    ['402 Insufficient credits. This account never purchased credits.', 'credits', false],
    ['401 Unauthorized: invalid api key', 'auth', false],
    ['404 Not found for account — that model is not available to your key', 'model-missing', false],
    ['This model\'s maximum context length is 128000 tokens', 'context', false],
    ['The model refused this request (content policy)', 'refused', true],
    ['Groq did not finish within 60s', 'timeout', true],
    ['fetch failed: the host name did not resolve', 'network', true],
    ['something nobody has seen before', 'unknown', true],
  ];
  for (const [message, kind, retryable] of cases) {
    const told = failure.attribute({ provider: 'Groq', model: 'x', message });
    assert.equal(told.kind, kind, message);
    assert.equal(told.retryable, retryable, message);
    assert.ok(told.advice.length > 10, `${kind} needs advice a person can act on`);
    assert.ok(told.label.length > 0);
  }
});

test('the classification is specific before it is general', () => {
  // A message that mentions both a rate limit and a 429 is a rate limit, not a
  // "try again later" -- the advice has to be the one that helps.
  assert.equal(failure.classify('429 too many requests: rate limit').kind, 'rate-limit');
  // A 402 that also mentions the model is about the money, not the model.
  assert.equal(failure.classify('402 insufficient credits for that model').kind, 'credits');
});

test('a message that repeats the model name is not printed twice', () => {
  const told = failure.attribute({
    providerLabel: 'Groq',
    model: 'llama-3.3-70b',
    message: 'Groq · llama-3.3-70b did not respond in time',
  });
  assert.equal(told.upstream.indexOf('Groq · llama-3.3-70b'), -1);
});

test('a long provider dump is trimmed rather than printed whole', () => {
  const told = failure.attribute({ model: 'm', message: 'x'.repeat(4000) });
  assert.ok(told.upstream.length <= 401, 'upstream detail is capped');
  assert.match(told.upstream, /…$/);
});

test('try another model moves one step along the picker, and wraps', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(failure.nextModel('a', list), 'b');
  assert.equal(failure.nextModel('c', list), 'a');
  // An id that is not in the list (a model the key lost) starts at the top
  // rather than answering nothing.
  assert.equal(failure.nextModel('gone', list), 'a');
  assert.equal(failure.nextModel('a', []), '');
  assert.equal(failure.nextModel('a', ['a', 'b']), 'b');
});

test('a failed draw reports what was walked, and Puter failures get Puter advice', () => {
  const images = require('../desktop/src/images.js');
  const told = failure.attributeImage({
    error: 'Image generation ran out of time after 60s — a service was slow or unreachable',
    tried: ['Free FLUX', 'OpenRouter'],
    asked: 'Free FLUX',
  });
  assert.match(told.summary, /Free FLUX/);
  assert.match(told.walk, /Tried Free FLUX, OpenRouter\./);
  assert.match(told.advice, /timed out/i);

  assert.equal(images.describePuterError({ errorCode: 'insufficient_funds' }), 'Puter credits used up');
  assert.equal(images.describePuterError({ errorCode: 'too_many_requests' }), 'Puter rate limit');
  assert.equal(images.describePuterError('sign in to Puter first'), 'sign in to Puter first');
  assert.match(images.puterAdvice('Puter credits used up'), /allowance is spent/);
  assert.match(images.puterAdvice('sign in to Puter first'), /Sign in to Puter/);
});

test('the chat screen leads with what was asked, and offers another model', () => {
  const screen = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  // The turn records the provider and its label, so the failure label cannot be
  // about a model that was not chosen.
  assert.match(screen, /providerLabel: providerRows\.find/);
  assert.match(screen, /failure: told/);
  assert.match(screen, /msg\.failure\.summary/);
  assert.match(screen, /msg\.failure\.upstream/);
  assert.match(screen, /failure\.nextModel\(msg\.model \|\| '', models\)/);
  // Retrying with another model re-sends with that model, in one action.
  assert.match(screen, /const retry = async \(modelOverride\?: string\)/);
  assert.match(screen, /patchSession\(active\.id, \{ model \}\)/);
  // The card is the whole report -- there is no second banner repeating it in
  // shorthand at the bottom of the screen.
  assert.ok(!/setStreamError/.test(screen));
  assert.ok(!/className="stream-error"/.test(screen));
});
