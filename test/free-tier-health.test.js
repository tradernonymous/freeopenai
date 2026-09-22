// Free tiers, the provider ledger, and the waiting budget.
//
// Three complaints meet here, and they are one feature. The picker offered a
// keyless free tier's models as though they were paid, because free-ness was
// read off a price; it said nothing about the allowance that is the real
// constraint (OVHcloud meters two requests a minute per IP, shared across its
// whole catalogue); and when a turn did meet a rate limit, the app slept
// through the provider's own Retry-After -- 40-57s, up to six times -- before
// it considered anywhere else to ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createRequestHandler,
  clearModelCache,
  clearProviderLedger,
  LLM_PROVIDERS,
} = require('../server.js');
const {
  usableChatModels,
  describeProviderModel,
  isFreeModel,
  failoverProviderOrder,
  freeRowsOnly,
  providerRouteScore,
} = require('../chatlib.js');

// OVHcloud's catalogue in its own shape: it publishes per-token prices because
// the platform sells tokens. The anonymous tier is an entitlement, not a price.
const OVH_CATALOGUE = {
  object: 'list',
  data: [
    { id: 'Qwen3-Coder-30B-A3B-Instruct', pricing: { prompt: '0.00000007', completion: '0.00000026' }, context_length: 262144 },
    { id: 'gpt-oss-120b', pricing: { prompt: '0.00000009', completion: '0.00000047' }, context_length: 131072 },
    // Not a chat model, and it must not survive the picker's filter.
    { id: 'whisper-large-v3' },
  ],
};

// One stub for everything this file needs from the network: the keyless
// catalogue, and a chat answer whose status and delay the test chooses.
async function withUpstream({ chatStatus = 200, retryAfter, chatDelayMs = 0, json } = {}, run) {
  const realFetch = global.fetch;
  const hits = [];
  global.fetch = async (url, init = {}) => {
    const text = String(url);
    // Only the upstream is stubbed. The test's own calls to this app go to
    // 127.0.0.1 and must reach the real server, which is why anything that is
    // not the keyless tier's address is passed straight through.
    if (!text.startsWith('https://oai.endpoints.kepler.ai.cloud.ovh.net')) return realFetch(url, init);
    hits.push({ url: text, method: (init.method || 'GET').toUpperCase() });
    if (text.includes('/models')) {
      return new globalThis.Response(JSON.stringify(OVH_CATALOGUE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (chatDelayMs) await new Promise((r) => setTimeout(r, chatDelayMs));
    const headers = { 'Content-Type': 'application/json' };
    if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter);
    const body = json !== undefined
      ? json
      : chatStatus === 200
        ? { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
        : { error: { message: 'API rate limit exceeded' } };
    return new globalThis.Response(JSON.stringify(body), { status: chatStatus, headers });
  };

  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  clearModelCache();
  clearProviderLedger();
  try {
    await run({ base, hits });
  } finally {
    app.close();
    global.fetch = realFetch;
    clearModelCache();
    clearProviderLedger();
  }
}

const env = { ...process.env };

test.after(() => {
  for (const name of ['RATE_LIMIT_RETRY_BUDGET_MS', 'RATE_LIMIT_MAX_ATTEMPTS', 'RATE_LIMIT_BASE_DELAY_MS']) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
});

test('a keyless tier that publishes prices is still shown as free, with what it meters', async () => {
  await withUpstream({}, async ({ base }) => {
    const rows = await (await fetch(base + '/api/llm/models?provider=ovhcloud')).json();
    const coder = rows.find((m) => m.id === 'Qwen3-Coder-30B-A3B-Instruct');
    assert.ok(coder, 'the priced model is still listed');
    assert.equal(coder.free, true, 'entitlement wins over price');
    assert.equal(coder.limits, '2/min · per IP · shared', 'and the allowance travels with the row');
    assert.equal(rows.some((m) => m.id === 'whisper-large-v3'), false, 'a non-chat model stays out');

    // The client's own rule reads the same row: this is what decides whether the
    // picker labels it free and whether a free-only filter keeps it.
    const clientRows = usableChatModels(rows);
    const clientCoder = clientRows.find((m) => m.id === 'Qwen3-Coder-30B-A3B-Instruct');
    assert.equal(clientCoder.free, true);
    assert.match(describeProviderModel(clientCoder), /free · 2\/min · per IP · shared/);
  });
});

test('a provider that is not a free tier keeps its priced models out of the free rows', () => {
  const nara = LLM_PROVIDERS.nara;
  assert.equal(nara.freeTier, undefined, 'Nara is a paid router and declares no free tier');
  assert.equal(isFreeModel({ id: 'agnes-2.5-flash', pricing: { prompt: '0.0000005' } }), false);
  // The documented assumption for a catalogue that publishes nothing survives.
  assert.equal(isFreeModel({ id: 'gpt-4o' }), true);
});

test('free models only filters to the free rows, and never down to nothing', () => {
  const rows = [{ id: 'a', free: true }, { id: 'b', free: false }, { id: 'c' }];
  const kept = freeRowsOnly(rows);
  assert.deepEqual(kept.rows.map((m) => m.id), ['a']);
  assert.equal(kept.hidden, 2);
  assert.equal(kept.empty, false);
  // A provider whose whole catalogue reads as paid is a real thing to look at:
  // an empty picker with no reason is worse than showing what was filtered.
  const allPaid = freeRowsOnly([{ id: 'x', free: false }]);
  assert.deepEqual(allPaid.rows.map((m) => m.id), ['x']);
  assert.equal(allPaid.empty, true);
});

test('a provider that asks for a longer wait than the budget is left alone, not slept through', async () => {
  process.env.RATE_LIMIT_RETRY_BUDGET_MS = '200';
  process.env.RATE_LIMIT_MAX_ATTEMPTS = '6';
  process.env.RATE_LIMIT_BASE_DELAY_MS = '1';
  await withUpstream({ chatStatus: 429, retryAfter: 54 }, async ({ base }) => {
    const started = Date.now();
    const res = await fetch(base + '/api/llm/chat?provider=ovhcloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 429, 'the refusal is reported rather than waited out');
    assert.ok(elapsed < 5000, `54s of Retry-After must not be slept through (took ${elapsed}ms)`);

    // And the provider it declined to wait for is marked as cooling, which is
    // what stops the next call from picking it again.
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    const ovh = providers.find((p) => p.id === 'ovhcloud');
    assert.equal(ovh.health.cooling, true);
    assert.equal(ovh.health.lastRetryAfterMs, 54000);
    assert.equal(ovh.health.callsToday >= 1, true, 'the refused call is still counted against the day');
  });
});

test('the ledger reports what it measured, and a slow model is labelled before it is picked', async () => {
  process.env.RATE_LIMIT_RETRY_BUDGET_MS = '20000';
  await withUpstream({ chatDelayMs: 30 }, async ({ base }) => {
    await fetch(base + '/api/llm/chat?provider=ovhcloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const providers = await (await fetch(base + '/api/llm/providers')).json();
    const ovh = providers.find((p) => p.id === 'ovhcloud');
    assert.equal(typeof ovh.health.latencyMs, 'number', 'the provider has a measured latency');
    assert.equal(ovh.health.lastStatus, 200);

    const rows = await (await fetch(base + '/api/llm/models?provider=ovhcloud')).json();
    const chosen = rows.find((m) => m.id === 'gpt-oss-120b');
    assert.equal(typeof chosen.observedMs, 'number', 'and the model that answered carries its own reading');
    assert.equal(rows.find((m) => m.id === 'Qwen3-Coder-30B-A3B-Instruct').observedMs, undefined,
      'a model nothing has called is not given someone else\'s number');

    // The label is the point: a row that has been slow here says so.
    assert.match(describeProviderModel({ id: 'x', free: true, observedMs: 41000 }), /slow here \(41s\)/);
    assert.match(describeProviderModel({ id: 'x', free: true, assumed: true }), /free \(assumed\)/);
  });
});

test('a cooling or nearly spent provider is tried last', () => {
  const providers = [
    { id: 'a', configured: true },
    { id: 'b', configured: true },
    { id: 'c', configured: true },
  ];
  // Nothing measured: exactly the order the picker shows.
  assert.deepEqual(failoverProviderOrder(providers), ['a', 'b', 'c']);
  // A cooldown moves to the back, because a provider that asked to be left alone
  // will either sleep the turn or refuse it.
  assert.deepEqual(
    failoverProviderOrder(providers, { health: { a: { cooling: true, cooldownMs: 40000 } } }),
    ['b', 'c', 'a'],
  );
  // A free tier at its daily edge fails mid-task, so it goes behind a provider
  // with no such problem -- but ahead of one that is cooling.
  assert.deepEqual(
    failoverProviderOrder(
      [providers[0], { id: 'b', configured: true, freeTier: { share: 0.9, cap: 100, callsToday: 90 } }, providers[2]],
      { health: { a: { cooling: true, cooldownMs: 40000 } } },
    ),
    ['c', 'b', 'a'],
  );
  // Latency is the last word, and an unmeasured provider is unknown rather than
  // fast: it sits just behind one that has answered quickly.
  assert.ok(providerRouteScore({}, { latencyMs: 500 }) < providerRouteScore({}, null));
  assert.ok(providerRouteScore({}, null) < providerRouteScore({}, { latencyMs: 30000 }));
});

test('FREE_MODELS_ONLY=1 applies the same rule at the API, and never down to nothing', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'free-model:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'paid-model', pricing: { prompt: '0.000005', completion: '0.000015' } },
      ],
    }));
  });
  await new Promise((r) => upstream.listen(0, r));
  const savedBase = process.env.FREEBUFF_BASE_URL;
  process.env.FREEBUFF_BASE_URL = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const base = 'http://127.0.0.1:' + app.address().port;
  try {
    clearModelCache();
    const all = await (await fetch(base + '/api/llm/models?provider=freebuff')).json();
    assert.deepEqual(all.map((m) => m.id).sort(), ['free-model:free', 'paid-model'], 'both rows by default');

    process.env.FREE_MODELS_ONLY = '1';
    clearModelCache();
    const gated = await (await fetch(base + '/api/llm/models?provider=freebuff')).json();
    assert.deepEqual(gated.map((m) => m.id), ['free-model:free'], 'the paid row is filtered at the source');
    assert.equal(gated[0].free, true);
  } finally {
    delete process.env.FREE_MODELS_ONLY;
    if (savedBase === undefined) delete process.env.FREEBUFF_BASE_URL;
    else process.env.FREEBUFF_BASE_URL = savedBase;
    app.close();
    upstream.close();
    clearModelCache();
  }
});

test('the public health endpoint still says nothing about providers beyond their names', async () => {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  const body = await (await fetch(`http://127.0.0.1:${app.address().port}/api/health`)).json();
  app.close();
  // The ledger and the free-tier table are for a signed-in page, not for an
  // anonymous probe: ids and counters only, never which providers are configured.
  assert.equal('freeTiers' in body, false);
  assert.equal('health' in body, false);
  assert.ok(Array.isArray(body.providers));
});
