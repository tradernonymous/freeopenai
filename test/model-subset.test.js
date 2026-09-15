// The declarative model-subset rules let a provider describe its picker as
// rules -- exact ids, newest-in-family, free only -- instead of a long literal
// array. These pin the behaviour that matters: declaration order is kept, a
// repeated id is offered once, "newest" is numeric rather than string order,
// and a rule that matches nothing degrades to the full catalogue instead of an
// empty picker.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { selectAllowedModels, newestInFamily, compareVersions, usableChatModels } = require('../chatlib.js');
const { LLM_PROVIDERS, createRequestHandler, clearModelCache } = require('../server.js');

const CATALOGUE = [{ id: 'alpha-1' }, { id: 'alpha-2' }, { id: 'beta-1' }];
const ids = (models) => models.map((m) => m.id);

test('no rules declared means the whole catalogue', () => {
  assert.deepEqual(ids(selectAllowedModels(CATALOGUE, null)), ['alpha-1', 'alpha-2', 'beta-1']);
  assert.deepEqual(ids(selectAllowedModels(CATALOGUE, {})), ['alpha-1', 'alpha-2', 'beta-1']);
});

test('exact keeps the declared order and drops ids the catalogue lacks', () => {
  assert.deepEqual(ids(selectAllowedModels(CATALOGUE, { exact: ['beta-1', 'alpha-1', 'not-there'] })), ['beta-1', 'alpha-1']);
});

test('a repeated rule only offers the model once', () => {
  const chosen = selectAllowedModels(CATALOGUE, { exact: ['alpha-1', 'alpha-1', 'beta-1', 'alpha-1'] });
  assert.deepEqual(ids(chosen), ['alpha-1', 'beta-1']);
});

test('newestOf picks the newest release in a family', () => {
  const catalogue = [{ id: 'spark-1.2' }, { id: 'spark-1.3' }, { id: 'spark-1.3-pro' }, { id: 'other-9' }];
  assert.deepEqual(ids(selectAllowedModels(catalogue, { newestOf: ['spark'] })), ['spark-1.3']);
  assert.equal(newestInFamily(catalogue, 'nothing-here'), null, 'an empty family is null, not a crash');
});

test('versions compare numerically, not as strings', () => {
  // "1.10" is a later release than "1.9"; a string comparison says the opposite.
  assert.ok(compareVersions('m-1.10', 'm-1.9') > 0);
  // Same version: the plain id beats a longer variant of it.
  assert.ok(compareVersions('spark-1.3', 'spark-1.3-pro') > 0);
  assert.equal(compareVersions('spark-1.3', 'spark-1.3'), 0);
});

test('freeOnly keeps free ids and collapses a named family to its newest free member', () => {
  const catalogue = [
    { id: 'pickle-free' },
    { id: 'mimo-v2.5-free' },
    { id: 'spark-1.2-free' },
    { id: 'spark-1.3-free' },
    { id: 'spark-1.3-contributor-free' },
    { id: 'fable-5' },
  ];
  const chosen = ids(selectAllowedModels(catalogue, { freeOnly: true, newestOf: ['spark'] }));
  assert.deepEqual(chosen, ['pickle-free', 'mimo-v2.5-free', 'spark-1.3-free']);
  assert.ok(!chosen.includes('fable-5'), 'a paid model must never be offered');
});

test('an unmatched rule degrades to the full catalogue, not an empty picker', () => {
  assert.deepEqual(ids(selectAllowedModels(CATALOGUE, { exact: ['gone'] })), ['alpha-1', 'alpha-2', 'beta-1']);
});

test('NVIDIA declares its allowlist as rules', () => {
  assert.ok(LLM_PROVIDERS.nvidia.models, 'NVIDIA should declare a subset');
  assert.ok(Array.isArray(LLM_PROVIDERS.nvidia.models.exact), 'NVIDIA should declare exact rules');
});

test('a repeated id in the NVIDIA allowlist reaches the picker exactly once', async () => {
  clearModelCache();
  // The allowlist listed mistral-medium-3.5-128b twice, which put the same
  // model in the picker twice. Assert on the endpoint response: a unit test on
  // the filter alone cannot see the duplication.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mistralai/mistral-medium-3.5-128b' }, { id: 'z-ai/glm-5.3' }],
    }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.NVIDIA_API_KEY = 'k';
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let app;
  try {
    app = http.createServer(createRequestHandler(__dirname + '/..'));
    await new Promise((r) => app.listen(0, r));
    const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/llm/models?provider=nvidia`)).json();
    const offered = body.map((m) => m.id);
    assert.equal(offered.filter((id) => id === 'mistralai/mistral-medium-3.5-128b').length, 1, 'offered exactly once');
    assert.deepEqual(offered.sort(), ['mistralai/mistral-medium-3.5-128b', 'z-ai/glm-5.3'].sort());
  } finally {
    if (app) app.close();
    upstream.close();
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_BASE_URL;
    clearModelCache();
  }
});

// includeRest turns the rules from a gate into an ordering, for a catalogue
// whose curation already happened somewhere else -- a gateway's own dashboard.
// Without it, connecting a provider there published 48 ids that this app's
// allowlist silently kept out of the picker.
const MIXED = [
  { id: 'auto/best-free' },
  { id: 'mistral/codestral-latest' },
  { id: 'openrouter/qwen3-coder:free' },
  { id: 'openrouter/anthropic/claude-opus-4.5' },
  { id: 'kr/claude-sonnet-5' },
];

test('includeRest leads with the named ids and keeps the rest behind them', () => {
  const chosen = ids(selectAllowedModels(MIXED, { exact: ['kr/claude-sonnet-5', 'auto/best-free'], includeRest: true }));
  assert.deepEqual(chosen.slice(0, 2), ['kr/claude-sonnet-5', 'auto/best-free'], 'named ids lead, in declared order');
  assert.ok(chosen.includes('mistral/codestral-latest'), 'an unnamed model still reaches the picker');
  assert.equal(new Set(chosen).size, chosen.length, 'a named id must not appear twice');
});

test('a named id that no longer exists stops leading rather than shrinking the list', () => {
  // The failure this prevents: a pinned id retired upstream used to remove a
  // model from the picker; now it costs nothing but its place in the order.
  const chosen = ids(selectAllowedModels(MIXED, { exact: ['gone/model', 'kr/claude-sonnet-5'], includeRest: true }));
  assert.equal(chosen[0], 'kr/claude-sonnet-5');
  assert.equal(chosen.length, MIXED.length, 'every live model is still offered');
});

test('freeOnlyPrefixes drops the paid ids of a namespace that marks its free ones', () => {
  const chosen = ids(selectAllowedModels(MIXED, { includeRest: true, freeOnlyPrefixes: ['openrouter/'] }));
  assert.ok(chosen.includes('openrouter/qwen3-coder:free'));
  assert.equal(chosen.includes('openrouter/anthropic/claude-opus-4.5'), false);
  // Only that namespace is judged. Everything else has no price published
  // here, and guessing "paid" would hide models the account can actually use.
  assert.ok(chosen.includes('mistral/codestral-latest'));
  assert.ok(chosen.includes('kr/claude-sonnet-5'));
});

test('restPrefixes lets only the named namespaces follow the list', () => {
  // A gateway prices nothing, so the namespace is the only thing that says
  // whether a model is on a free tier. The rest of the catalogue follows the
  // named ids only from the namespaces the rules vouch for.
  const withPaid = [...MIXED, { id: 'openai/gpt-5.4' }, { id: 'anthropic/claude-opus-5' }];
  const chosen = ids(selectAllowedModels(withPaid, {
    exact: ['auto/best-free'],
    includeRest: true,
    restPrefixes: ['auto/', 'kr/', 'mistral/', 'openrouter/'],
    freeOnlyPrefixes: ['openrouter/'],
  }));
  assert.equal(chosen[0], 'auto/best-free');
  assert.ok(chosen.includes('kr/claude-sonnet-5'));
  assert.ok(chosen.includes('mistral/codestral-latest'));
  assert.ok(chosen.includes('openrouter/qwen3-coder:free'), 'the two rules compose');
  assert.equal(chosen.includes('openai/gpt-5.4'), false, 'a namespace with no free tier never follows on its own');
  assert.equal(chosen.includes('anthropic/claude-opus-5'), false);
  // Naming one is still a decision, the same as it is for a paid OpenRouter id.
  const named = ids(selectAllowedModels(withPaid, { exact: ['openai/gpt-5.4'], includeRest: true, restPrefixes: ['kr/'] }));
  assert.deepEqual(named, ['openai/gpt-5.4', 'kr/claude-sonnet-5']);
});

test('a paid id is still offered when it was named outright', () => {
  // freeOnlyPrefixes filters the tail, not the operator's own choices: naming
  // an id is a decision, and silently dropping it would be the surprise.
  const chosen = ids(selectAllowedModels(MIXED, {
    exact: ['openrouter/anthropic/claude-opus-4.5'],
    includeRest: true,
    freeOnlyPrefixes: ['openrouter/'],
  }));
  assert.equal(chosen[0], 'openrouter/anthropic/claude-opus-4.5');
});

// A gateway catalogue carries more than chat models, and the ones named after
// a voice rather than a job slip past a filter written in job words. This is
// not hypothetical: a failover, refused by one model, picked
// `fish-audio/s2.1-pro-free` and asked a text-to-speech endpoint to carry on
// with a coding task.
test('speech-synthesis models never reach the picker or the router', () => {
  const speech = [
    'fish-audio/s2.1-pro-free',
    'groq/canopylabs/orpheus-v1-english',
    'cf/@cf/deepgram/aura-2-es',
    'elevenlabs/eleven-v3',
    'cf/@cf/myshell-ai/melotts',
    'playai-tts',
    'bark-small',
  ];
  const shown = new Set(usableChatModels(speech.map((id) => ({ id }))).map((m) => m.id));
  for (const id of speech) assert.equal(shown.has(id), false, id + ' would be offered as a chat model');
});

test('models that merely mention audio still count as chat models', () => {
  // The obvious rule -- match "audio" -- is the wrong one: these answer chat
  // completions, and dropping them would cost real models to fix a naming
  // coincidence. "embark" is here because a bare `bark` would swallow it.
  const chat = ['openai/gpt-4o-audio-preview', 'mistral/voxtral-small-latest', 'embark-chat'];
  const shown = new Set(usableChatModels(chat.map((id) => ({ id }))).map((m) => m.id));
  for (const id of chat) assert.ok(shown.has(id), id + ' should still be offered');
});
