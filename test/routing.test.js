// Per-step routing: which model answers which call of a turn.
//
// The rules are small and the failure mode is quiet -- a turn silently served by
// a model nobody chose, at a cost nobody measured -- so these tests pin the
// decisions that cost money or quality rather than the happy path.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  callStage,
  routeCost,
  routeRank,
  routeStep,
  routedStepFailure,
  toolArgsUnusable,
  describeRoute,
  ROUTING_MODES,
} = require('../chatlib.js');

// Shapes follow what /api/llm/models actually returns: pricing is published by
// OpenRouter (per token, usually tiny) and absent for the allowance-backed
// providers, supportedParameters decides tool use, outputModalities decides
// whether it is a chat model at all.
const model = (id, extra = {}) => ({ id, ...extra });

const OPUS = model('anthropic/claude-opus-4.8', {
  pricing: { prompt: 0.000015, completion: 0.000075 },
  supportedParameters: ['tools'],
});
const FREE = model('z-ai/glm-5.2:free', {
  pricing: { prompt: 0, completion: 0 },
  supportedParameters: ['tools'],
});
const CHEAP = model('nvidia/nemotron-mini', {
  pricing: { prompt: 0.0000002, completion: 0.0000006 },
  supportedParameters: ['tools'],
});

// The screen a work step sorts through. Every call in this file that expects a
// route goes through it, so a broken filter shows up as every test failing
// rather than one.
const route = (opts) => routeStep({ models: [OPUS, FREE, CHEAP], mode: 'auto', stage: 'work', ...opts });

test('a call is classified by what it has to do, not by how many have run', () => {
  // The first call of a turn: nothing read yet, so it decides the whole turn.
  assert.equal(callStage({ round: 0, toolsOffered: true, toolResults: 0 }), 'plan');
  // A later call with tool output in hand: read it, choose the next move.
  assert.equal(callStage({ round: 1, toolsOffered: true, toolResults: 2 }), 'work');
  // Tools withheld: this call has to produce the reply, whatever the round is.
  assert.equal(callStage({ round: 3, toolsOffered: false, toolResults: 5 }), 'answer');
  // Tools on offer but nothing new to read -- the retry after an empty reply.
  // It must answer, and it stays on the model already in the middle of the work.
  assert.equal(callStage({ round: 1, toolsOffered: true, toolResults: 0 }), 'answer');
});

test('only a work step moves: the plan and the answer stay on the chosen model', () => {
  assert.equal(route({ stage: 'plan', model: OPUS.id }), null);
  assert.equal(route({ stage: 'answer', model: OPUS.id }), null);
  assert.ok(route({ stage: 'work', model: OPUS.id }), 'a work step is the one that should move');
});

test('routing is off when it is switched off', () => {
  assert.deepEqual(ROUTING_MODES, ['off', 'auto']);
  assert.equal(route({ mode: 'off' }), null);
});

test('the cheapest eligible model is picked, free before cheap', () => {
  const picked = route({ model: OPUS.id });
  assert.equal(picked.model, FREE.id, 'a free model outranks a merely cheap one');
  assert.equal(picked.from, OPUS.id);
  assert.equal(picked.free, true);

  // With the free one out of the way, the cheapest published price wins.
  const paid = route({ model: OPUS.id, models: [OPUS, CHEAP] });
  assert.equal(paid.model, CHEAP.id);
  assert.equal(paid.free, false);
});

test('an id the provider marks free counts as free without a price', () => {
  const freeBySuffix = model('some/family:free', { supportedParameters: ['tools'] });
  const picked = route({ model: OPUS.id, models: [OPUS, freeBySuffix, CHEAP] });
  assert.equal(picked.model, freeBySuffix.id);
});

test('input is weighted over output, because a work round mostly is input', () => {
  // These two are chosen so the weighting is what decides: added up plainly,
  // cheapOutput is the cheaper model, and weighted 3:1 towards input, it is not.
  // That flip is the whole point -- a work round sends the conversation and gets
  // back a tool call -- so a test that only checked the cheaper number would
  // pass with the weighting removed.
  const cheapInput = model('a/cheap-input', { pricing: { prompt: 0.000001, completion: 0.000009 } });
  const cheapOutput = model('b/cheap-output', { pricing: { prompt: 0.0000039, completion: 0.000001 } });
  const plainly = (m) => m.pricing.prompt + m.pricing.completion;
  assert.ok(plainly(cheapOutput) < plainly(cheapInput), 'the trap: unweighted, the other one wins');
  assert.ok(routeCost(cheapInput) < routeCost(cheapOutput), 'weighted, this one does');
  const picked = route({ model: OPUS.id, models: [OPUS, cheapOutput, cheapInput] });
  assert.equal(picked.model, cheapInput.id);
});

test('an unknown price is not a free model', () => {
  // isFreeModel gives an unpriced model the benefit of the doubt so it stays
  // visible in the picker. Doing that here would hand every step to whichever
  // premium model happens to publish nothing, so the router refuses to guess.
  const unpriced = model('mystery/premium-model', { supportedParameters: ['tools'] });
  assert.equal(routeRank(unpriced), null);
  assert.ok(routeCost(unpriced) === null, 'no published price means unknown, not zero');

  // It is not chosen even when it is the only candidate: no route, no guessing.
  assert.equal(route({ model: OPUS.id, models: [OPUS, unpriced] }), null);

  // And it does not outrank a model with a real, published price.
  const picked = route({ model: OPUS.id, models: [OPUS, unpriced, CHEAP] });
  assert.equal(picked.model, CHEAP.id);
});

test('a small model by name is used only when there are no prices to rank on', () => {
  // The Antigravity shape: one shared quota, no published prices at all, and
  // both Opus and a flash model in the list. The name is the only signal there.
  const opus = model('antigravity-claude-opus-4-6-thinking-high', { supportedParameters: ['tools'] });
  const sonnet = model('antigravity-claude-sonnet-4-6', { supportedParameters: ['tools'] });
  const flash = model('antigravity-gemini-3-flash', { supportedParameters: ['tools'] });
  const picked = route({ model: opus.id, models: [opus, sonnet, flash] });
  assert.equal(picked.model, flash.id);
  assert.equal(picked.why, 'the small model in this family');

  // A published price outranks the name, even the other way round.
  const paidLite = model('some/flash-old', { pricing: { prompt: 0.001, completion: 0.001 } });
  const freeUnlite = model('some/enormous:free', { supportedParameters: ['tools'] });
  const ranked = route({ model: opus.id, models: [opus, paidLite, freeUnlite] });
  assert.equal(ranked.model, freeUnlite.id, 'a free model beats a flash-named paid one');

  // Nothing ranked and nothing named: no route, rather than a coin toss.
  assert.equal(route({ model: opus.id, models: [opus, sonnet] }), null);
});

test('a tool step never routes to a model that cannot take tools', () => {
  const freeNoTools = model('some/free-no-tools:free', { supportedParameters: ['temperature'] });
  const picked = route({ model: OPUS.id, models: [OPUS, freeNoTools, CHEAP], needsTools: true });
  assert.equal(picked.model, CHEAP.id, 'the free model is skipped, not the whole route');

  // The same model is fine for a step that sends no tools.
  const textOnly = route({ model: OPUS.id, models: [OPUS, freeNoTools, CHEAP], needsTools: false });
  assert.equal(textOnly.model, freeNoTools.id);
});

test('a model that already refused a step is not routed to it again', () => {
  const picked = route({ model: OPUS.id, refused: [FREE.id] });
  assert.equal(picked.model, CHEAP.id);
  // With both cheap options out, there is no route left rather than a repeat of
  // the call that just failed.
  assert.equal(route({ model: OPUS.id, refused: [FREE.id, CHEAP.id] }), null);
});

test('the router and the picker agree about what a chat model is', () => {
  const embed = model('openai/text-embedding-3-small:free');
  const picked = route({ model: OPUS.id, models: [OPUS, embed, CHEAP] });
  assert.equal(picked.model, CHEAP.id, 'an embedding model is not a candidate');
  const onlyJunk = route({ model: OPUS.id, models: [OPUS, embed] });
  assert.equal(onlyJunk, null);
  // An image-output model would burn a step answering with a picture.
  const paints = model('some/flux-image:free', { outputModalities: ['image'] });
  assert.equal(route({ model: OPUS.id, models: [OPUS, paints] }), null);
});

test('the same catalogue in a different order picks the same model', () => {
  const first = route({ model: OPUS.id });
  const shuffled = route({ model: OPUS.id, models: [CHEAP, FREE, OPUS] });
  assert.equal(shuffled.model, first.model);
  // Catalogue order is not a signal: the pick has to survive it.
  const tied = [
    model('x/aaa', { pricing: { prompt: 0.000001, completion: 0 } }),
    model('x/bbb', { pricing: { prompt: 0.000001, completion: 0 } }),
  ];
  const a = route({ model: OPUS.id, models: [OPUS, ...tied] });
  const b = route({ model: OPUS.id, models: [OPUS, ...tied.slice().reverse()] });
  assert.equal(a.model, b.model);
});

test('a step already on the cheapest model is left where it is', () => {
  // Otherwise the app would announce a saving for re-sending the same call to
  // the same model.
  assert.equal(route({ model: FREE.id }), null);
  assert.equal(route({ model: CHEAP.id, models: [OPUS, CHEAP] }), null);
});

test('a routed step that cannot do the job is escalated, on an observed signal', () => {
  // A step that is fine produces no phrase, which is what the wiring tests for.
  assert.equal(routedStepFailure(), '');
  assert.equal(routedStepFailure({}), '');
  assert.equal(routedStepFailure({ errored: true }), 'refused the step');
  assert.equal(routedStepFailure({ empty: true }), 'came back with nothing');
  assert.equal(
    routedStepFailure({ badArguments: true }),
    'sent tool arguments that could not be used'
  );
  assert.equal(routedStepFailure({ repeatedCall: true }), 'asked again for something it already had');
  // Precedence, so a step that failed two ways reports the actionable one.
  assert.equal(routedStepFailure({ empty: true, repeatedCall: true }), 'came back with nothing');
  assert.equal(routedStepFailure({ errored: true, empty: true }), 'refused the step');
});

test('tool arguments are judged as usable JSON, and no arguments is not a failure', () => {
  assert.equal(toolArgsUnusable('{"path":"notes.md"}'), false);
  // A no-parameter tool such as task_list legitimately sends nothing.
  assert.equal(toolArgsUnusable(''), false);
  assert.equal(toolArgsUnusable(null), false);
  assert.equal(toolArgsUnusable(undefined), false);
  assert.equal(toolArgsUnusable({ path: 'notes.md' }), false, 'already parsed by the provider shim');
  // The failure parseToolArgs has to swallow, and which was invisible until now.
  assert.equal(toolArgsUnusable('{"path": notes.md}'), true, 'not valid JSON');
  assert.equal(toolArgsUnusable('reading notes.md'), true);
  assert.equal(toolArgsUnusable('"notes.md"'), true, 'a bare string is not an argument object');
  assert.equal(toolArgsUnusable('null'), true);
  assert.equal(toolArgsUnusable('[1,2]'), true, 'an array is not an argument object');
});

test('the transcript line names both models, so a switch is not a secret', () => {
  const picked = route({ model: OPUS.id });
  const line = describeRoute(picked);
  assert.ok(line.includes(FREE.id));
  assert.ok(line.includes(OPUS.id), 'the model that plans the turn is named too');
  // And it must not claim the chosen model writes the reply: a work step can be
  // the one that answers, and a note promising otherwise would be the app
  // describing a turn it did not run.
  assert.doesNotMatch(line, /for planning and the answer/);
  assert.equal(describeRoute(null), '');
});
