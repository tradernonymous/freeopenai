// Evals history and schedule: runs are kept and capped, each model is compared
// with its previous run, a drop of one task in eight (or twice as slow) is a
// regression, and the schedule reuses the recipes due-time rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const evals = require('../desktop/src/evals.js');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

const A = { provider: 'groq', model: 'llama-3.3', label: 'Groq · llama-3.3' };
const B = { provider: 'ollama-local', model: 'qwen3:4b', label: 'Ollama Local · qwen3:4b' };
const IDS = evals.TASKS.map((t) => t.id);

/** A run where `target` passes every task except `failing`, each taking `ms`. */
function results(target, failing = [], ms = 1000) {
  return IDS.map((taskId) => ({ target, taskId, pass: !failing.includes(taskId), ms, chars: 10, note: failing.includes(taskId) ? 'wrong' : '' }));
}

// ---- history ---------------------------------------------------------------------

test('targetKey is provider::model, or the label when those are missing', () => {
  assert.equal(evals.targetKey(A), 'groq::llama-3.3');
  assert.equal(evals.targetKey({ label: 'Just a label' }), 'Just a label');
  assert.equal(evals.targetKey(null), '');
});

test('a run records targets, rows keyed by model, and a per-model summary', () => {
  const run = evals.makeRun([...results(A, ['arith']), ...results(B, [], 500)], { at: 1000, trigger: 'schedule' });
  assert.equal(run.at, 1000);
  assert.equal(run.trigger, 'schedule');
  assert.deepEqual(run.targets.map((t) => t.label), [A.label, B.label]);
  assert.equal(run.rows.length, IDS.length * 2);
  assert.equal(run.rows[0].targetKey, 'groq::llama-3.3');
  const [a, b] = run.summary;
  assert.equal(a.passed, IDS.length - 1);
  assert.equal(a.total, IDS.length);
  assert.equal(b.rate, 1);
  assert.equal(b.avgMs, 500);
  const errored = evals.makeRun([{ target: A, taskId: 'arith', pass: false, error: 'timed out or stopped', ms: 0, chars: 0 }]);
  assert.equal(errored.rows[0].error, true);
  assert.equal(errored.rows[0].note, 'timed out or stopped');
});

test('history is read back oldest first and capped at the newest runs', () => {
  const store = memoryStorage();
  assert.deepEqual(evals.readHistory(store), []);
  for (let i = 1; i <= 7; i += 1) evals.appendRun(evals.makeRun(results(A), { at: i * 1000 }), store, 5);
  const kept = evals.readHistory(store);
  assert.equal(kept.length, 5);
  assert.deepEqual(kept.map((r) => r.at), [3000, 4000, 5000, 6000, 7000]);
  assert.equal(evals.HISTORY_CAP, 200);
  assert.equal(evals.HISTORY_KEY, 'freeai4u.evals_history');
  // The default cap is 200.
  const big = memoryStorage();
  big.setItem(evals.HISTORY_KEY, JSON.stringify(Array.from({ length: 200 }, (_, i) => evals.makeRun(results(A), { at: i + 1 }))));
  assert.equal(evals.appendRun(evals.makeRun(results(A), { at: 999 }), big).length, 200);
  assert.equal(evals.readHistory(big)[199].at, 999);
  // Junk in storage is skipped, not a crash.
  const junk = memoryStorage();
  junk.setItem(evals.HISTORY_KEY, '[1, null, {"id": 3}]');
  assert.deepEqual(evals.readHistory(junk), []);
  junk.setItem(evals.HISTORY_KEY, 'not json');
  assert.deepEqual(evals.readHistory(junk), []);
  assert.equal(evals.clearHistory(store), true);
  assert.deepEqual(evals.readHistory(store), []);
  assert.match(evals.exportHistory(kept), /"kind": "neuraos-evals-history"/);
});

// ---- comparison ------------------------------------------------------------------

test('compareRuns gives before/after rates, the delta and the newly failing tasks', () => {
  const before = evals.makeRun([...results(A, ['bat-ball']), ...results(B)], { at: 1 });
  const after = evals.makeRun([...results(A, ['bat-ball', 'arith', 'json-object']), ...results(B, [], 3000)], { at: 2 });
  const [a, b] = evals.compareRuns(before, after);
  assert.equal(a.key, 'groq::llama-3.3');
  assert.equal(a.beforePassed, 7);
  assert.equal(a.afterPassed, 5);
  assert.equal(a.total, 8);
  assert.equal(a.before, 7 / 8);
  assert.equal(a.after, 5 / 8);
  assert.equal(a.delta, -2 / 8);
  assert.deepEqual(a.newlyFailing, ['arith', 'json-object']);
  assert.equal(a.slower, 1);
  assert.equal(b.delta, 0);
  assert.equal(b.slower, 3, 'three times the average time');
  // A model the previous run did not have has nothing to compare with.
  const [only] = evals.compareRuns(evals.makeRun(results(B)), evals.makeRun(results(A)));
  assert.equal(only.before, null);
  assert.equal(only.delta, null);
  assert.equal(only.after, 1);
});

test('rates compare only the tasks both runs asked', () => {
  const before = evals.makeRun(results(A), { at: 1 });
  const after = evals.makeRun(results(A).filter((r) => r.taskId === 'arith'), { at: 2 });
  const [a] = evals.compareRuns(before, after);
  assert.equal(a.total, 1);
  assert.equal(a.delta, 0);
});

test('compareToHistory compares each model with its own latest earlier run', () => {
  const r1 = evals.makeRun(results(A), { at: 1 });
  const r2 = evals.makeRun(results(B), { at: 2 });
  const r3 = evals.makeRun([...results(A, ['arith']), ...results(B)], { at: 3 });
  const [a, b] = evals.compareToHistory([r1, r2, r3], r3);
  assert.deepEqual(a.newlyFailing, ['arith']);
  assert.equal(a.delta, -1 / 8);
  assert.equal(b.delta, 0);
});

test('regressions: one task in eight lost, or twice as slow, is worse; unreachable is not', () => {
  const base = evals.makeRun(results(A), { at: 1 });
  const oneLost = evals.compareRuns(base, evals.makeRun(results(A, ['arith']), { at: 2 }));
  const found = evals.regressions(oneLost);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].reasons, ['rate']);
  assert.equal(evals.regressionMessage(found[0]), 'Groq · llama-3.3: 8/8 → 7/8 (new failures: arith)');
  assert.equal(evals.regressions(oneLost, { dropAtLeast: 0.25 }).length, 0, 'a stricter threshold ignores one task');

  const slow = evals.compareRuns(base, evals.makeRun(results(A, [], 2500), { at: 2 }));
  assert.deepEqual(evals.regressions(slow)[0].reasons, ['slower']);
  assert.equal(evals.regressions(slow, { slowerBy: 3 }).length, 0);
  assert.match(evals.regressionMessage(evals.regressions(slow)[0]), /2\.5× slower \(1\.0s → 2\.5s\)/);
  const fastAnyway = evals.compareRuns(evals.makeRun(results(A, [], 100)), evals.makeRun(results(A, [], 300)));
  assert.equal(evals.regressions(fastAnyway).length, 0, 'milliseconds apart is noise, not a regression');

  const better = evals.compareRuns(evals.makeRun(results(A, ['arith'])), evals.makeRun(results(A)));
  assert.equal(evals.regressions(better).length, 0);

  const offline = evals.makeRun(IDS.map((taskId) => ({ target: A, taskId, pass: false, error: 'fetch failed', ms: 0, chars: 0 })));
  const cmp = evals.compareRuns(base, offline);
  assert.equal(cmp[0].unreachable, true);
  assert.equal(evals.regressions(cmp).length, 0);
});

test('series and trend follow one model over time', () => {
  const runs = [
    evals.makeRun(results(A), { at: 1 }),
    evals.makeRun(results(A), { at: 2 }),
    evals.makeRun(results(A, ['arith', 'extract']), { at: 3 }),
  ];
  const s = evals.series(runs, evals.targetKey(A));
  assert.deepEqual(s.map((p) => p.at), [1, 2, 3]);
  assert.equal(evals.trend(s), 'down');
  assert.equal(evals.trend(s.slice(0, 2)), 'flat');
  assert.equal(evals.trend([{ rate: 0.5 }, { rate: 1 }]), 'up');
  assert.equal(evals.trend([]), 'flat');
});

// ---- schedule ----------------------------------------------------------------------

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const HOUR = 3600000;

test('schedule is stored normalized; bad parts are dropped', () => {
  const store = memoryStorage();
  assert.equal(evals.SCHEDULE_KEY, 'freeai4u.evals_schedule');
  assert.deepEqual(evals.readSchedule(store), { enabled: false, targets: [], lastRunAt: 0 });
  const saved = evals.writeSchedule({ enabled: true, everyHours: 6, dailyAt: '25:00', targets: [A, A, { label: 'no provider' }] }, store);
  assert.equal(saved.everyHours, 6);
  assert.equal(saved.dailyAt, undefined);
  assert.deepEqual(saved.targets, [A]);
  assert.deepEqual(evals.readSchedule(store), saved);
  assert.equal(evals.normalizeSchedule({ everyHours: 0 }).everyHours, undefined);
  assert.equal(evals.normalizeSchedule({ everyHours: 1.5 }).everyHours, undefined);
  assert.equal(evals.scheduleLabel(saved), 'every 6 h');
});

test('nextEvalRun: every N hours counts from the last run', () => {
  const now = at(2026, 9, 22, 12, 0);
  assert.equal(evals.nextEvalRun({ enabled: true, everyHours: 6 }, now - HOUR, now), now + 5 * HOUR);
  assert.equal(evals.nextEvalRun({ enabled: true, everyHours: 6 }, 0, now), now, 'never run: due now');
  assert.equal(evals.nextEvalRun({ enabled: false, everyHours: 6 }, 0, now), null, 'off');
  assert.equal(evals.nextEvalRun({ enabled: true }, 0, now), null, 'no timing');
  assert.equal(evals.nextEvalRun(null, 0, now), null);
});

test('nextEvalRun: daily at HH:MM, and a slot missed while closed is caught up once', () => {
  const s = { enabled: true, dailyAt: '08:30' };
  // Never run, turned on at 10:00: tomorrow's slot, not at once.
  assert.equal(evals.nextEvalRun(s, 0, at(2026, 9, 22, 10, 0)), at(2026, 9, 23, 8, 30));
  // Never run, turned on at 07:00: today's slot.
  assert.equal(evals.nextEvalRun(s, 0, at(2026, 9, 22, 7, 0)), at(2026, 9, 22, 8, 30));
  // Ran yesterday at 08:30, the app was closed through today's slot: due now (the past slot).
  const next = evals.nextEvalRun(s, at(2026, 9, 21, 8, 30), at(2026, 9, 22, 14, 0));
  assert.equal(next, at(2026, 9, 22, 8, 30));
  assert.ok(next <= at(2026, 9, 22, 14, 0));
  // Caught up at 14:00: the next one is tomorrow, so it does not repeat.
  assert.equal(evals.nextEvalRun(s, at(2026, 9, 22, 14, 0), at(2026, 9, 22, 14, 1)), at(2026, 9, 23, 8, 30));
  // Several days closed: still just one run due.
  assert.equal(evals.nextEvalRun(s, at(2026, 9, 18, 8, 30), at(2026, 9, 22, 9, 0)), at(2026, 9, 19, 8, 30));
});

test('nextEvalRun shares the recipes rule rather than copying it', () => {
  const src = read('desktop', 'src', 'evals.js');
  assert.match(src, /require\('\.\/recipes\.js'\)/);
  assert.match(src, /lib\.nextRun\(/);
  assert.ok(!/function dailyAfter/.test(src), 'no second copy of the daily-slot rule');
});

// ---- wiring --------------------------------------------------------------------------

test('App runs the eval scheduler next to the recipe scheduler', () => {
  const app = read('desktop', 'src', 'App.tsx');
  // The hooks live in schedulers.ts (eager) so the Evals screen can be lazy.
  assert.match(app, /import \{ useRecipeScheduler, useEvalScheduler \} from '\.\/schedulers'/);
  assert.match(app, /useRecipeScheduler\(\);\n\s*useEvalScheduler\(\);/);
});

test('the Evals screen saves every run, and the scheduler notifies on a regression', () => {
  const screen = read('desktop', 'src', 'screens', 'EvalsScreen.tsx');
  const schedulers = read('desktop', 'src', 'schedulers.ts');
  assert.match(screen, /evals\.appendRun\(/);
  assert.match(schedulers, /export function useEvalScheduler\(\)/);
  assert.match(schedulers, /evals\.nextEvalRun\(/);
  assert.match(schedulers, /suiteRunning\(\)/, 'a suite already running is not started twice');
  assert.match(screen, /export async function runScheduledEvals\(/);
  assert.match(screen, /evals\.regressions\(/);
  assert.match(screen, /notifyUser\('A model got worse'/);
  assert.match(screen, /pushToast\('warn'/);
  assert.match(screen, /hasShell\(\)/, 'local models are skipped without the desktop shell');
  assert.match(schedulers, /setInterval\(tick, 60000\)/);
  assert.ok(!/<select/.test(screen), 'no native select');
  const css = read('desktop', 'src', 'index.css');
  assert.match(css, /\/\* ---- Evals history ---- \*\//);
});
