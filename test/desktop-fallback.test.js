// Smart provider fallback: the rules that decide what a failed turn tries
// next, and -- the part that matters most -- which switch the app is allowed to
// take without asking. Getting that wrong is not a cosmetic bug: it silently
// answers with a different model than the one the user chose.
const test = require('node:test');
const assert = require('node:assert/strict');

const fallback = require('../desktop/src/fallback.js');

const LOCAL = { baseUrl: 'http://127.0.0.1:8080', model: 'qwen2.5-coder-1.5b-q4_k_m', ready: true };

test('a failure a different model cannot fix is not a reason to switch models', () => {
  // Context overflow follows the request wherever it goes, and a refusal is a
  // refusal. Offering another model here would just be a second failure.
  for (const kind of ['context', 'credits', 'auth', 'refused', 'model-missing']) {
    const plan = fallback.plan({ failure: { kind }, provider: 'groq', model: 'a', next: 'b', local: LOCAL });
    assert.deepEqual(plan.attempts, [], `${kind} should not switch models`);
    assert.equal(plan.automatic, false, `${kind} must not switch on its own`);
  }
});

test('a rate-limited remote turn falls to the local model, and may do it unasked', () => {
  const plan = fallback.plan({
    failure: { kind: 'rate-limit' },
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    next: 'kilo-auto/free',
    local: LOCAL,
  });
  assert.equal(plan.attempts[0].provider, 'local', 'the local server is the first attempt');
  assert.equal(plan.attempts[0].model, LOCAL.model);
  assert.equal(plan.automatic, true, 'it is the same request to a private server, so it needs no consent');
  assert.match(plan.note, /rate-limited/, 'and the user is told what happened');
  assert.match(plan.note, /local model/, 'by name of the kind of thing that answered');
});

test('with no local model the switch is offered, never taken', () => {
  const plan = fallback.plan({
    failure: { kind: 'rate-limit' },
    provider: 'groq',
    model: 'a',
    next: 'b',
    local: null,
  });
  assert.equal(plan.attempts.length, 1);
  assert.equal(plan.attempts[0].model, 'b');
  assert.equal(plan.automatic, false, 'a different remote model is the user’s call, not the app’s');
});

test('nothing is ever attempted twice, and nothing is attempted forever', () => {
  const same = fallback.plan({
    failure: { kind: 'overloaded' },
    provider: 'groq',
    model: 'a',
    next: 'a',
    local: null,
  });
  assert.deepEqual(same.attempts, [], 'the next model is only a next model if it is a different one');

  const many = fallback.plan({
    failure: { kind: 'timeout' },
    provider: 'groq',
    model: 'a',
    next: 'b',
    local: LOCAL,
  });
  assert.ok(many.attempts.length <= fallback.MAX_ATTEMPTS, 'the ladder is bounded');
});

test('a local turn that fails does not fall back to the local model', () => {
  const plan = fallback.plan({
    failure: { kind: 'timeout' },
    provider: 'local',
    model: 'qwen',
    next: 'llama-3.1-8b',
    local: LOCAL,
  });
  // The local server is already the first rung, so there is no "fall back to
  // local" left to take -- only the next model on the local provider, offered.
  assert.deepEqual(plan.attempts.map((a) => a.model), ['llama-3.1-8b']);
  assert.equal(plan.attempts[0].provider, 'local');
  assert.equal(plan.automatic, false, 'and it is offered like any other');
});

test('a local server that is configured but not running is not an attempt', () => {
  const plan = fallback.plan({
    failure: { kind: 'rate-limit' },
    provider: 'groq',
    model: 'a',
    next: '',
    local: { baseUrl: 'http://127.0.0.1:8080', model: 'qwen', ready: false },
  });
  assert.deepEqual(plan.attempts, [], 'a stopped server is not a fallback');
  assert.equal(plan.automatic, false);
});

test('every attempt says why it is worth trying', () => {
  const plan = fallback.plan({
    failure: { kind: 'network' },
    provider: 'groq',
    model: 'a',
    next: 'b',
    local: LOCAL,
  });
  for (const attempt of plan.attempts) {
    assert.ok(attempt.label, `${attempt.model} needs a human name`);
    assert.ok(attempt.why, `${attempt.model} needs a reason`);
  }
});
