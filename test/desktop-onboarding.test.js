// Which surface the shell shows, and why. The bug this locks down was the
// worst one found in this app: `loginRequired && !signedIn` hid every screen,
// Settings included -- the only screen that could sign you in -- so a fresh
// install against a login-gated engine was a locked door, and the banner
// blamed the network for an authentication state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const onboarding = require('../desktop/src/onboarding.js');
const connection = require('../desktop/src/connection.js');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const read = (...parts) => fs.readFileSync(path.join(DESKTOP, ...parts), 'utf8');

const outcome = (status) => connection.classify({ status, origin: 'https://engine.test' });

test('an engine that never answered asks the user to fix the address', () => {
  const state = onboarding.shellState({ outcome: outcome(0), health: null, signedIn: false, serverSaved: true });
  assert.equal(state.surface, 'connect');
  assert.equal(state.reason, 'unreachable');
});

test('an engine that wants a login asks for a sign-in, not for a network check', () => {
  const state = onboarding.shellState({
    outcome: outcome(200),
    health: { ok: true, loginRequired: true },
    signedIn: false,
    serverSaved: true,
  });
  assert.equal(state.surface, 'connect');
  assert.equal(state.reason, 'signed-out');
  assert.equal(onboarding.connectTitle(state.reason), 'Sign in to this engine');
});

test('a signed-in session on a gated engine shows the app', () => {
  const state = onboarding.shellState({
    outcome: outcome(200),
    health: { ok: true, loginRequired: true },
    signedIn: true,
    serverSaved: true,
  });
  assert.equal(state.surface, 'app');
  assert.equal(state.reason, 'ready');
  assert.equal(state.bannerKind, null);
});

test('an open engine shows the app without a sign-in', () => {
  const state = onboarding.shellState({
    outcome: outcome(200),
    health: { ok: true, loginRequired: false },
    signedIn: false,
    serverSaved: true,
  });
  assert.equal(state.surface, 'app');
  assert.equal(state.reason, 'ready');
});

test('the first probe does not flash a connect screen at a working install', () => {
  const state = onboarding.shellState({ outcome: null, health: null, signedIn: false, serverSaved: true });
  assert.equal(state.surface, 'app');
  assert.equal(state.reason, 'checking');
  assert.equal(state.bannerKind, null, 'and it says nothing while it is still asking');
});

test('an engine failing on its side keeps the app, with a banner', () => {
  const state = onboarding.shellState({ outcome: outcome(503), health: null, signedIn: false, serverSaved: true });
  assert.equal(state.surface, 'app', 'the app is still the right surface: each screen reports its own error');
  assert.equal(state.reason, 'degraded');
  assert.equal(state.bannerKind, 'engine-error');
  assert.match(connection.bannerFor(state.bannerKind), /engine/i);
});

test('a refusal is treated as an address/credentials problem, not as death', () => {
  assert.equal(onboarding.shellState({ outcome: outcome(403), health: null, signedIn: false, serverSaved: true }).surface,
    'connect');
});

test('a first run is named as one', () => {
  const state = onboarding.shellState({
    outcome: outcome(200),
    health: { ok: true, loginRequired: true },
    signedIn: false,
    serverSaved: false,
  });
  assert.equal(state.firstRun, true, 'nothing has been chosen yet');
  assert.equal(state.reason, 'signed-out', 'but the cause is still the reason');
  assert.match(onboarding.connectTitle('first-run'), /Welcome/);
});

test('every reason has a headline and a next step', () => {
  for (const reason of onboarding.REASONS) {
    assert.ok(onboarding.connectTitle(reason).length, `${reason} has a title`);
    assert.ok(onboarding.connectAdvice(reason).length, `${reason} says what to do`);
  }
});

// ---- wiring: the gate is gone -------------------------------------------

test('the shell decides from the policy, and can always reach the way in', () => {
  const app = read('src', 'App.tsx');
  assert.match(app, /onboarding\.shellState\(/, 'one decision, taken in the tested module');
  assert.match(app, /<ConnectScreen/, 'the connect surface is rendered');
  assert.match(app, /shell\.surface === 'connect' && view !== 'settings'/,
    'and Settings stays reachable while it is up');
  assert.doesNotMatch(app, /loginRequired === true && !signedIn/, 'the boolean gate is gone');
  assert.doesNotMatch(app, /Open Settings to sign in/, 'the dead-end button is gone');
  assert.doesNotMatch(app, /serverOk/, 'and so is the flag that collapsed every failure to "cannot reach"');
});

test('the engine card has one owner, shared by the connect screen and Settings', () => {
  const card = read('src', 'components', 'ConnectionCard.tsx');
  assert.match(card, /normalizeServer/, 'the address rule lives with the form');
  assert.match(card, /connection\.classify/, 'and outcomes are classified, not collapsed');
  for (const screen of ['ConnectScreen.tsx', 'SettingsScreen.tsx']) {
    assert.match(read('src', 'screens', screen), /ConnectionCard/, `${screen} uses the shared card`);
  }
  assert.doesNotMatch(read('src', 'screens', 'SettingsScreen.tsx'), /testConnection/,
    'Settings no longer owns a second copy of the probe');
});

test('changing the engine anywhere re-probes the shell', () => {
  // The card can be used from the connect screen or from Settings; in both
  // places the shell has to hear about it, or fixing a wrong address leaves the
  // app on the surface it was already showing.
  assert.match(read('src', 'screens', 'SettingsScreen.tsx'), /onConnectionChanged/, 'Settings forwards it');
  assert.match(read('src', 'App.tsx'), /onConnectionChanged=\{checkAuth\}/, 'the shell re-probes on it');
  assert.match(read('src', 'screens', 'ConnectScreen.tsx'), /onConnected=\{onConnected\}/, 'so does the connect screen');
});

test('the card reports the real cause for each outcome', () => {
  assert.match(read('src', 'components', 'ConnectionCard.tsx'), /not a FreeAI4U engine/,
    'an unrelated server is named as one, not reported as unreachable');
});
