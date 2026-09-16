// The image planner is a classifier: one message in, a few fields out. It used to
// run on whatever model the conversation was on, so a flagship was paid the
// conversation's per-token price to make a routing decision -- and on Puter that
// price is credits from a fixed monthly allowance that does not roll over.
//
// Two things are checked here: the rule that picks the cheap model, and the
// wiring, because callModel used to drop the routed model on the Puter branch and
// that is the branch where it mattered most.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  routeClassifier,
  isLiteModelId,
  MODELS,
  DEFAULT_MODEL,
} = require('../chatlib.js');
const { HTML, sourceOf } = require('./helpers/index-html.js');

// Priced models, the way a server provider lists them.
const PRICED = [
  { id: 'big/flagship', pricing: { prompt: 0.000015, completion: 0.00006 } },
  { id: 'mid/standard', pricing: { prompt: 0.000003, completion: 0.000009 } },
  { id: 'tiny/cheap', pricing: { prompt: 0.0000001, completion: 0.0000004 } },
  { id: 'gift/model:free', pricing: { prompt: 0, completion: 0 } },
];

test('a classifier goes to the cheapest thing the provider lists', () => {
  const route = routeClassifier({ model: 'big/flagship', models: PRICED });
  assert.equal(route.model, 'gift/model:free', 'free beats priced');
  assert.equal(route.free, true);
  assert.equal(route.from, 'big/flagship');

  // With nothing free, the cheapest price wins -- not merely a smaller name.
  const priced = routeClassifier({ model: 'big/flagship', models: PRICED.filter((m) => !/free/.test(m.id)) });
  assert.equal(priced.model, 'tiny/cheap');
  assert.equal(priced.why, 'the cheapest price');
});

test('a model already as cheap as anything stays where it is', () => {
  // Moving it would swap the user's model for nothing and report a saving that
  // does not exist.
  assert.equal(routeClassifier({ model: 'gift/model:free', models: PRICED }), null);
  assert.equal(routeClassifier({ model: 'tiny/cheap', models: PRICED.filter((m) => !/free/.test(m.id)) }), null);
});

test('the routing switch governs it, and an empty list leaves it alone', () => {
  // It is the same trade the switch already describes, so it answers to it.
  assert.equal(routeClassifier({ mode: 'off', model: 'big/flagship', models: PRICED }), null);
  assert.equal(routeClassifier({ model: 'big/flagship', models: [] }), null);
  assert.equal(routeClassifier({ model: '', models: PRICED }), null);
  assert.equal(routeClassifier(), null);
  // A model that just refused is not the place to send anything.
  const dodged = routeClassifier({ model: 'big/flagship', models: PRICED, refused: ['gift/model:free'] });
  assert.equal(dodged.model, 'tiny/cheap');
});

test('on Puter the app default breaks the tie, not whichever id sorts first', () => {
  // Puter publishes no prices, so every small model ties at "the small one in
  // the family" and an alphabetical winner would be an older id.
  const lite = MODELS.filter((m) => isLiteModelId(m.id)).map((m) => m.id);
  assert.ok(lite.length > 1, 'this test only means something with a tie to break');
  assert.ok(lite.includes(DEFAULT_MODEL), 'the app default has to be one of the cheap ones');

  const preferred = routeClassifier({ model: 'gpt-6-astra', models: MODELS, preferred: DEFAULT_MODEL });
  assert.equal(preferred.model, DEFAULT_MODEL);

  // Without the preference it picks a tied model, and that is the behaviour the
  // preference exists to override rather than something broken.
  const alphabetical = routeClassifier({ model: 'gpt-6-astra', models: MODELS });
  assert.ok(lite.includes(alphabetical.model));

  // A preference that is not actually cheap does not win.
  const ignored = routeClassifier({ model: 'gpt-6-astra', models: PRICED, preferred: 'big/flagship' });
  assert.equal(ignored.model, 'gift/model:free');
});

test('a classifier is not held to the work stage, unlike a tool step', () => {
  // routeStep only moves a 'work' step because the plan and the answer are the
  // user's. A classifier is neither, so it has no stage to be held to -- and the
  // rule takes no stage at all, which is the point.
  const route = routeClassifier({ model: 'big/flagship', models: PRICED });
  assert.ok(route, 'a classifier with no stage still routes');
  // It is also handed no tools, so a model that cannot take them is still fine.
  const noTools = routeClassifier({
    model: 'big/flagship',
    models: [{ id: 'tiny/cheap', tools: false, pricing: { prompt: 0, completion: 0 } }],
  });
  assert.equal(noTools.model, 'tiny/cheap');
});

test('the planner asks for the routed model, and Puter honours it', () => {
  // The planner passes it -- without this the rule above is dead code.
  assert.match(sourceOf('planImageTurn'), /routeForPlanner\(\)/);
  assert.match(sourceOf('planImageTurn'), /callModel\(convo, \{\}, context\.signal \|\| null, route \? route\.model : null\)/);

  // And the Puter branch uses it. It used to read selectedModel here, which made
  // every routed step on Puter run on the model the user chose.
  assert.match(sourceOf('callModel'), /chatWithEffortFallback\(askModel \|\| selectedModel,/);
  assert.doesNotMatch(
    sourceOf('callModel'),
    /chatWithEffortFallback\(selectedModel,/,
    'the Puter branch is ignoring the routed model again',
  );

  // Puter's catalogue never loads over the network, so providerModels is empty
  // there and ranking has to read MODELS.
  assert.match(sourceOf('routableModels'), /selectedProvider === PUTER_PROVIDER \? MODELS : providerModels/);
  assert.match(sourceOf('routeForPlanner'), /mode: routingMode/);
  assert.match(sourceOf('routeForPlanner'), /preferred: selectedProvider === PUTER_PROVIDER \? DEFAULT_MODEL : ''/);
  assert.ok(HTML.includes('function routeForPlanner()'), 'expected the wiring to live in the page');
});
