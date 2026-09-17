// The free-only picker, as shipped, plus the two wirings that keep a turn alive.
//
// The rules are unit-tested in chatlib and in free-tier-health.test.js; this file
// is about the page actually using them. A filter nothing calls, a health map
// nothing passes to the failover order, or a rescue loop that only exists in the
// agent path are all features that look finished in a diff and are not there at
// runtime -- which is exactly how the image path came to be the one turn that
// died on a spent free tier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describeProviderModel, freeRowsOnly } = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const NAMES = ['activeModels', 'hiddenModelRowsNote', 'providerHealthMap'];

function harness(deps = {}) {
  const base = {
    PUTER_PROVIDER: 'puter',
    MODELS: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', desc: 'Puter' }],
    selectedProvider: 'ovhcloud',
    freeModelsOnly: true,
    providerModels: [
      { id: 'gpt-oss-120b', free: true, limits: '2/min · per IP · shared', observedMs: null },
      { id: 'some-paid-model', free: false },
    ],
    providerInfo: {
      ovhcloud: { id: 'ovhcloud', health: { cooling: true, cooldownMs: 4000, latencyMs: 900 } },
      kilocode: { id: 'kilocode', health: { cooling: false, latencyMs: 400 } },
      custom: { id: 'custom' },
    },
    freeRowsOnly,
    describeProviderModel,
    ...deps,
  };
  return { deps: base, loaded: loadFromIndex(NAMES, base) };
}

test('the extracted functions are readable and their sandbox is complete', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('the picker shows free rows only, and says what it hid', () => {
  const h = harness();
  const shown = h.loaded.activeModels().map((m) => m.id);
  assert.deepEqual(shown, ['gpt-oss-120b'], 'the metered row is not offered');
  assert.equal(h.loaded.hiddenModelRowsNote(), '1 model hidden by "Free models only"');

  // Off: everything is back, and there is nothing to explain.
  const off = harness({ freeModelsOnly: false });
  assert.deepEqual(off.loaded.activeModels().map((m) => m.id), ['gpt-oss-120b', 'some-paid-model']);
  assert.equal(off.loaded.hiddenModelRowsNote(), '');
});

test('a provider whose whole catalogue reads as paid is shown anyway, with the reason', () => {
  const h = harness({ providerModels: [{ id: 'only-paid', free: false }] });
  assert.deepEqual(h.loaded.activeModels().map((m) => m.id), ['only-paid'],
    'an empty picker with no reason is worse than the rows it would have hidden');
  assert.match(h.loaded.hiddenModelRowsNote(), /No model here reads as free/);
});

test('Puter is never filtered: its list is the account the turn is billed to', () => {
  const h = harness({ selectedProvider: 'puter' });
  assert.deepEqual(h.loaded.activeModels().map((m) => m.id), ['claude-sonnet-5']);
  assert.equal(h.loaded.hiddenModelRowsNote(), '');
});

test('health is handed to the failover order, and only for providers that have it', () => {
  const map = harness().loaded.providerHealthMap();
  assert.deepEqual(Object.keys(map).sort(), ['kilocode', 'ovhcloud']);
  assert.equal(map.ovhcloud.cooling, true);
});

test('the free-only switch is in Settings, wired to the setter and restored on load', () => {
  assert.match(HTML, /id="freeOnlyCheck"[^>]*onchange="setFreeModelsOnly\(this\.checked\)"/,
    'the checkbox is wired to the setter');
  assert.match(HTML, /function setFreeModelsOnly\(on\) \{/, 'and the setter exists');
  assert.match(HTML, /localStorage\.getItem\('freeai4uFreeModelsOnly'\)/, 'the choice survives a reload');
});

test('an image turn is carried to another provider, like every other turn', () => {
  // The streaming branch is reached exactly when a picture is attached, and it
  // used to throw straight out. Both halves are asserted, because either one
  // alone leaves the same hole open.
  const start = HTML.indexOf('// Direct providers stream via SSE');
  const end = HTML.indexOf('// Puter streaming path.');
  assert.ok(start !== -1 && end > start, 'the streaming branch is where this test thinks it is');
  const branch = HTML.slice(start, end);
  assert.match(branch, /for \(let hop = 0; hop <= MAX_PROVIDER_FAILOVERS; hop\+\+\)/, 'it hops');
  assert.match(branch, /isFailoverWorthyFailure\(error\.message, error\.statusCode, error\.modelId\)/,
    'on the same failures the tool loop treats as another provider\'s to answer');
  assert.match(branch, /moveTurnToNextProvider\(blockedProviders, error\)/, 'and it uses the same move');
});
