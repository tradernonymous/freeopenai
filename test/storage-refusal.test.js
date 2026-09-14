// A browser can refuse to store anything. Safari in private mode throws on
// setItem, and a full quota throws in every browser -- and these setters run
// from inside failure handling, where an escaping throw replaces the real error
// with a storage one and leaves the recovery half done.
//
// So the setters are run against a localStorage that always throws, straight out
// of the shipped file, and are expected to carry on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFromIndex, HTML } = require('./helpers/index-html.js');

function refusingStore() {
  const attempts = [];
  return {
    attempts,
    store: {
      getItem: () => null,
      removeItem: () => {},
      setItem: (key) => {
        attempts.push(key);
        const error = new Error('The quota has been exceeded.');
        error.name = 'QuotaExceededError';
        throw error;
      },
    },
  };
}

test('a refused write is reported, not thrown', () => {
  const { store, attempts } = refusingStore();
  const { rememberPreference } = loadFromIndex(['rememberPreference'], { localStorage: store });
  assert.equal(rememberPreference('k', 'v'), false, 'a caller that checks should be told it failed');
  assert.deepEqual(attempts, ['k'], 'the write was attempted, not skipped');

  const kept = [];
  const { rememberPreference: ok } = loadFromIndex(['rememberPreference'], {
    localStorage: { setItem: (k, v) => kept.push([k, v]) },
  });
  assert.equal(ok('mode', 'plan'), true);
  assert.deepEqual(kept, [['mode', 'plan']]);
  // A value that is not a string still reaches storage as one, the way the
  // browser would coerce it.
  assert.equal(ok('n', 3), true);
});

test('every preference setter survives a browser that refuses storage', () => {
  // These are the ones that reassign page state before persisting. A throw
  // between the two leaves the app showing one thing and remembering another.
  const cases = [
    ['setSkillsEnabled', (fns) => fns.setSkillsEnabled(true)],
    ['cycleMode', (fns) => fns.cycleMode()],
    ['selectEffort', (fns) => fns.selectEffort('high')],
    ['saveUserPreferences', (fns) => fns.saveUserPreferences()],
  ];
  for (const [name, run] of cases) {
    const { store, attempts } = refusingStore();
    const fns = loadFromIndex([name, 'rememberPreference'], {
      localStorage: store,
      MODES: [{ id: 'chat' }, { id: 'plan' }, { id: 'build' }],
      selectedMode: 'chat',
      selectedModel: 'gpt-5.4-nano',
      selectedEffort: '',
      skillsEnabled: false,
      isValidEffort: () => true,
      DEFAULT_EFFORT: '',
      updateSkillsToggle: () => {},
      updateModeChip: () => {},
      renderSkillOptions: () => {},
      showStatus: () => {},
      updateModelLabel: () => {},
      updateEffortChip: () => {},
      persistSkillUseLog: () => {},
      ensureSkillsLoaded: () => Promise.resolve([]),
      refreshSkillRail: () => {},
      routeSkillsForTurn: () => {},
      updateSessionSummary: () => {},
    });
    assert.doesNotThrow(() => run(fns), `${name}() lets a storage refusal escape`);
    assert.ok(attempts.length >= 1, `${name}() never tried to persist anything`);
  }
});

test('preferences go through the guard, and the transcript does not', () => {
  const script = HTML.slice(HTML.indexOf('function rememberPreference'));
  // Only writeConversations may call setItem directly, because losing history is
  // a real loss: it evicts pictures and then old chats rather than shrugging.
  const direct = [...script.matchAll(/localStorage\.setItem\(([^;]*)\)/g)].map((m) => m[1]);
  const offenders = direct.filter((call) => !/^key, value$/.test(call.trim()));
  for (const call of offenders) {
    const at = script.indexOf('localStorage.setItem(' + call);
    const before = script.slice(Math.max(0, at - 700), at);
    assert.match(
      before,
      /try\s*\{/,
      `localStorage.setItem(${call.slice(0, 50)}) is neither guarded nor routed through rememberPreference()`
    );
  }
});
