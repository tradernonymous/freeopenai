// A provider dying half-way through a tool loop used to end the turn and take
// everything already paid for with it. These are the rules that decide when a
// request is worth carrying to another provider, which one, and what the
// conversation has to look like when the model that answers cannot call tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PUTER_PROVIDER,
  MAX_PROVIDER_FAILOVERS,
  failoverProviderOrder,
  nextFailoverProvider,
  isFailoverWorthyFailure,
  flattenToolTurn,
} = require('../chatlib.js');

const providers = [
  { id: 'nara', label: 'Nara', configured: false, kind: 'chat' },
  { id: 'openrouter', label: 'OpenRouter', configured: true, kind: 'chat' },
  { id: 'deepgram', label: 'Deepgram', configured: true, kind: 'speech' },
  { id: 'nvidia', label: 'NVIDIA', configured: true, kind: 'chat' },
  { id: 'duckduckgo', label: 'DuckDuckGo', configured: true, kind: 'search' },
];

test('only configured chat services are worth moving a request to', () => {
  assert.deepEqual(failoverProviderOrder(providers), ['openrouter', 'nvidia']);
  // Junk and missing ids are dropped rather than becoming candidates.
  assert.deepEqual(failoverProviderOrder([null, {}, { id: '' }, { id: 'x', configured: true }]), ['x']);
  assert.deepEqual(failoverProviderOrder(null), []);
  // A provider with no key can only fail, so it is not a candidate at all.
  assert.deepEqual(failoverProviderOrder([{ id: 'nara', label: 'Nara', configured: false }]), []);
});

test('Puter is a last resort, and only when it is actually usable', () => {
  // Last: it needs an account rather than a key, so a turn that moved there
  // because a keyed provider failed would often fail on the sign-in instead.
  assert.deepEqual(failoverProviderOrder(providers, { puterUsable: true }), ['openrouter', 'nvidia', PUTER_PROVIDER]);
  assert.deepEqual(failoverProviderOrder(providers, { puterUsable: false }), ['openrouter', 'nvidia']);
  // And with nothing else configured it is still worth reaching.
  assert.deepEqual(failoverProviderOrder([], { puterUsable: true }), [PUTER_PROVIDER]);
  // Never twice, however it got there.
  assert.deepEqual(failoverProviderOrder([{ id: PUTER_PROVIDER, configured: true }], { puterUsable: true }), [PUTER_PROVIDER]);
});

test('a provider already tried this turn is never asked again', () => {
  const order = ['openrouter', 'nvidia', 'mistral'];
  assert.equal(nextFailoverProvider(order), 'openrouter');
  assert.equal(nextFailoverProvider(order, ['openrouter']), 'nvidia');
  assert.equal(nextFailoverProvider(order, [], new Set(['openrouter', 'nvidia'])), 'mistral');
  assert.equal(nextFailoverProvider(order, ['openrouter', 'nvidia'], new Set(['mistral'])), null);
  // Nowhere left is null rather than a guess.
  assert.equal(nextFailoverProvider([], []), null);
  assert.equal(nextFailoverProvider(null), null);
  // Junk in the order is skipped, not returned.
  assert.equal(nextFailoverProvider([null, '', 'nvidia']), 'nvidia');
});

test('an outage, a spent allowance or a bad account is worth moving provider for', () => {
  // A spent allowance belongs to that account; another provider has its own.
  assert.equal(isFailoverWorthyFailure('quota exhausted: all accounts failed or are exhausted for this model', 429), true);
  assert.equal(isFailoverWorthyFailure('you have reached your monthly usage limit', 429), true);
  assert.equal(isFailoverWorthyFailure('Your Puter account is out of credits', 402), true);
  assert.equal(isFailoverWorthyFailure('Payment Required: add funds to your billing account', 402), true);
  // Upstream outage, rate limit, dead socket.
  assert.equal(isFailoverWorthyFailure('upstream is unavailable', 503), true);
  assert.equal(isFailoverWorthyFailure('rate limited', 429), true);
  assert.equal(isFailoverWorthyFailure('Could not reach Antigravity: fetch failed', 502), true);
  assert.equal(isFailoverWorthyFailure('Antigravity did not respond within 55s', 504), true);
  assert.equal(isFailoverWorthyFailure('fetch failed', 0), true);
});

test('a model that refused the request is not a reason to move provider', () => {
  // The model walker inside callModel has already tried that model's siblings,
  // so moving provider would multiply the attempts for a request that is going
  // to fail everywhere.
  assert.equal(
    isFailoverWorthyFailure('403: thinkingmachines/inkling:free is only available on agentic harnesses', 403, 'thinkingmachines/inkling:free'),
    false,
  );
  assert.equal(isFailoverWorthyFailure('404: that model said not found for account', 404, 'llama-3.3-70b'), false);
  // A per-model paywall names the model, so it is that model's price rather
  // than the account that is spent.
  assert.equal(isFailoverWorthyFailure('this model requires a subscription or usage credits', 402), false);
  // A request the app itself got wrong fails the same way everywhere.
  assert.equal(isFailoverWorthyFailure('model and messages are required', 400), false);
  assert.equal(isFailoverWorthyFailure('', 0), false);
});

const withTools = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: 'read my readme' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'github_read_file', arguments: '{"repo":"o/r","path":"README.md"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'the readme text' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c2', type: 'function', function: { name: 'web_search', arguments: '{"query":"typos"}' } }],
  },
  { role: 'tool', tool_call_id: 'c2', content: 'search results' },
  { role: 'user', content: 'now fix it' },
];

test('a turn moved to a model without tools has its work folded into text', () => {
  const flat = flattenToolTurn(withTools);
  assert.equal(flat.some((m) => Array.isArray(m.tool_calls)), false);
  assert.equal(flat.some((m) => m.role === 'tool'), false);
  // The system prompt and the user's own words survive as themselves.
  assert.equal(flat[0].role, 'system');
  assert.equal(flat[0].content, 'be helpful');
  assert.equal(flat[flat.length - 1].role, 'user');
  assert.match(flat[flat.length - 1].content, /now fix it/);
  // The results are still there, named by the call that produced them, so the
  // model can tell a file read from a search.
  const text = flat.map((m) => m.content).join('\n');
  assert.match(text, /the readme text/);
  assert.match(text, /search results/);
  assert.match(text, /README\.md/);
  // Runs of the same role are merged: some providers reject two user turns in
  // a row outright.
  for (let i = 1; i < flat.length; i++) assert.notEqual(flat[i].role, flat[i - 1].role);
});

test('folding is a no-op on a conversation that never called a tool', () => {
  const plain = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  assert.deepEqual(flattenToolTurn(plain), plain);
});

test('folding junk yields an empty conversation rather than a crash', () => {
  assert.deepEqual(flattenToolTurn(null), []);
  assert.deepEqual(flattenToolTurn('nope'), []);
  // A result with no call to name it still reaches the model.
  const orphan = flattenToolTurn([{ role: 'tool', tool_call_id: 'ghost', content: 'orphan text' }]);
  assert.equal(orphan.length, 1);
  assert.match(orphan[0].content, /orphan text/);
});

test('one turn may only move provider a bounded number of times', () => {
  // The point is to survive one provider going down, not to crawl every service
  // the operator ever configured while the user watches.
  assert.ok(MAX_PROVIDER_FAILOVERS >= 1 && MAX_PROVIDER_FAILOVERS <= 3);
});
