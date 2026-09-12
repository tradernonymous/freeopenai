// Every direct provider used to be unreachable without a Puter account, because
// the send gate checked Puter before it looked at the provider at all. These
// tests cover the decision and the wiring that applies it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsPuterAccount, PUTER_PROVIDER, safeJson } = require('../chatlib.js');
const { HTML, loadFromIndex, sourceOf, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['needsPuterLogin', 'refreshLoginRequirement'];

function harness({ provider = PUTER_PROVIDER, loginRequired = false, health = { loginRequired: true }, failHealth = false } = {}) {
  const deps = {
    needsPuterAccount,
    safeJson,
    selectedProvider: provider,
    loginRequired,
    updateAuthUI: () => {},
    fetch: async () => {
      if (failHealth) throw new Error('offline');
      return { ok: true, status: 200, json: async () => health, text: async () => JSON.stringify(health) };
    },
  };
  const loaded = loadFromIndex(NAMES, deps);
  return { deps, loaded, needs: () => loaded.needsPuterLogin() };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('the page reads the login flag from a public endpoint, at startup', () => {
  // It has to be readable before the user has signed in to anything, so it is
  // /api/health and not an authenticated route.
  assert.match(sourceOf('refreshLoginRequirement'), /fetch\('\/api\/health'\)/);
  // And it must actually run at startup: reading the flag but never asking for
  // it leaves the stricter rule in place, so the deploy's login would buy the
  // user nothing. Checked at the call site rather than anywhere in the file,
  // since the definition would match a looser search.
  const startup = HTML.slice(HTML.indexOf('loadMessagesFromStorage();'));
  assert.match(startup.slice(0, 200), /refreshLoginRequirement\(\);/, 'the startup block must fetch it');
});

test('Puter always needs a Puter account, whoever is asking', () => {
  for (const loginRequired of [true, false]) {
    assert.equal(needsPuterAccount({ provider: PUTER_PROVIDER, loginRequired }), true);
    assert.equal(harness({ provider: PUTER_PROVIDER, loginRequired }).needs(), true);
  }
});

test('a direct provider needs one only when nothing else is checking', () => {
  // With a login of its own, the deployment has established who the visitor is
  // and enforces it on every API route, so their own account is enough.
  assert.equal(needsPuterAccount({ provider: 'antigravity', loginRequired: true }), false);
  assert.equal(harness({ provider: 'antigravity', loginRequired: true }).needs(), false);
  // Wide open: nothing else stands between a visitor and the operator's keys.
  assert.equal(needsPuterAccount({ provider: 'antigravity', loginRequired: false }), true);
  assert.equal(harness({ provider: 'antigravity', loginRequired: false }).needs(), true);
  assert.equal(needsPuterAccount({ provider: 'openrouter', loginRequired: false }), true);
});

test('the page takes the login state from the deploy, and fails strict', async () => {
  // The plumbing: the server's answer is what decides whether a direct provider
  // needs a Puter account, so a typo here would silently keep the old gate.
  const on = harness({ provider: 'antigravity', health: { loginRequired: true } });
  await on.loaded.refreshLoginRequirement();
  assert.equal(on.deps.loginRequired, true);
  assert.equal(on.needs(), false, 'a signed-in deploy frees the direct provider');

  const off = harness({ provider: 'antigravity', health: { loginRequired: false } });
  await off.loaded.refreshLoginRequirement();
  assert.equal(off.deps.loginRequired, false);
  assert.equal(off.needs(), true, 'an open deployment keeps the Puter requirement');

  // Unreadable means unknown, and unknown stays strict rather than opening the
  // operator's provider keys to whoever is looking.
  const broken = harness({ provider: 'antigravity', loginRequired: true, failHealth: true });
  await broken.loaded.refreshLoginRequirement();
  assert.equal(broken.deps.loginRequired, false);
  assert.equal(broken.needs(), true);
});

test('anything unreadable keeps the stricter answer', () => {
  for (const input of [null, undefined, {}, 'nonsense', { provider: null }, { provider: '' }]) {
    assert.equal(needsPuterAccount(input), true, `${JSON.stringify(input)} must not open a provider key`);
  }
  // An unknown login state is passed as false by the page for the same reason.
  assert.equal(harness({ provider: 'antigravity', loginRequired: false }).needs(), true);
});

test('no Puter check in the send gate stands on its own', () => {
  // The gate still has to ask Puter whether they are signed in — but only once
  // it has decided Puter is what this turn uses. An unguarded check is the bug
  // this fixes: it blocked every direct provider behind a Puter account.
  const send = sourceOf('sendMessage');
  const puterChecks = send.split('\n').filter((line) => line.includes('puter.auth.isSignedIn'));
  assert.ok(puterChecks.length > 0, 'the gate still needs to ask Puter for the Puter provider');
  for (const line of puterChecks) {
    assert.match(line.trim(), /^if \(needsPuterLogin\(\)/, `unguarded Puter check: ${line.trim()}`);
  }
  // The one raw check outside it answers a different question — can Puter draw
  // at all — and is the right one there.
  assert.match(sourceOf('puterCanDraw'), /isSignedIn/);
});
