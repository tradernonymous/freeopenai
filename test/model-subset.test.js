// The declarative model-subset rules let a provider describe its picker as
// rules -- exact ids, newest-in-family, free only -- instead of a long literal
// array. These pin the behaviour that matters: declaration order is kept, a
// repeated id is offered once, "newest" is numeric rather than string order,
// and a rule that matches nothing degrades to the full catalogue instead of an
// empty picker.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { selectAllowedModels, newestInFamily, compareVersions } = require('../chatlib.js');
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
