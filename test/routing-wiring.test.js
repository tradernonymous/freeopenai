// The routing wiring the loop tests cannot reach.
//
// routing.test.js covers the rules, and the loop tests at the foot of
// tool-parallel.test.js drive routeForStep through the shipped turn. What is
// left is the part inside callModel, which is too tangled with fetch to extract
// whole -- so the invariant that matters is pinned at the source, and the one
// function that can be run is run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceOf, loadFromIndex, assertScannerCanRead, assertSandboxCovers, HTML } = require('./helpers/index-html.js');
const { refusedModelIds } = require('../chatlib.js');

const NAMES = ['forgetRoutedModel'];

function harness() {
  const said = [];
  const deps = {
    selectedProvider: 'test-provider',
    selectedModel: 'big-model',
    providerModels: [
      { id: 'big-model' },
      { id: 'small-model:free' },
      { id: 'other-model' },
    ],
    modelsRefusedBy: new Set(),
    renderModelOptions: () => {},
    updateModelLabel: () => {},
    resummarizeRefusal: () => 'not found',
    addMessage: (role, text) => said.push(text),
    refusedModelIds,
  };
  return { deps, said, ...loadFromIndex(NAMES, deps) };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a routed refusal takes that model out of circulation', () => {
  const h = harness();
  h.forgetRoutedModel('small-model:free', 'model not found');
  assert.ok(h.deps.modelsRefusedBy.has('test-provider:small-model:free'));
  assert.deepEqual(
    h.deps.providerModels.map((m) => m.id),
    ['big-model', 'other-model'],
    'and it leaves the picker, so it cannot be chosen or routed to again'
  );
  assert.equal(h.said.length, 1);
  assert.match(h.said[0], /refused a routed step/);
});

test('a routed refusal never moves the model the user picked', () => {
  // This is the whole reason forgetRoutedModel exists beside forgetRefusedModel.
  // A cheap model refusing a step is not the user's choice failing, and moving
  // their selection there would silently change what they are talking to.
  const body = sourceOf('forgetRoutedModel');
  assert.equal(
    /selectedModel\s*=/.test(body),
    false,
    'forgetRoutedModel must not assign selectedModel -- that is forgetRefusedModel\'s job'
  );
  const h = harness();
  h.forgetRoutedModel('small-model:free', 'model not found');
  assert.equal(h.deps.selectedModel, 'big-model');
});

test('callModel takes a per-call model and only moves the pick for a refusal of it', () => {
  const body = sourceOf('callModel');
  // The routed model is used for this attempt, and the user's model otherwise.
  assert.match(body, /const modelId = askModel \|\| selectedModel;/);
  // A routed refusal is handled by the routed bookkeeping, then thrown marked so
  // the loop escalates that step instead of reporting the turn as failed.
  assert.match(body, /forgetRoutedModel\(modelId,/);
  assert.match(body, /routedErr\.routed = true;/);
  // And the ordinary refusal path -- the one that does move the selection -- is
  // still reached for the model the user actually chose.
  assert.match(body, /forgetRefusedModel\(modelId,/);
});

test('the page wires the switch, the selector and the note together', () => {
  // A setting that nothing reads, or a selector nothing calls, is a feature that
  // looks finished in a diff and does nothing at runtime.
  assert.match(HTML, /id="routingCheck" checked onchange="setRoutingEnabled\(this\.checked\)"/);
  assert.match(HTML, /let routingMode = localStorage\.getItem\(ROUTING_KEY\)/);
  assert.match(HTML, /routeForStep\(stage, tools\.length > 0, needsVision\)/);
  assert.match(HTML, /const askModel = route \? route\.model : null;/);
  assert.match(HTML, /noteRouteOnce\(route\);/);
  assert.match(HTML, /callModel\(convo, \{ tools \}, signal, askModel\)/);
  // The status bar credits the model that answered, not the one that was picked.
  assert.match(HTML, /lastReplyModel \|\| selectedModel/);
});
