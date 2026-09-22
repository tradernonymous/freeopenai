// The eval harness itself (NEURA-057): the checked-in cases pass, the score is
// the same every run, and -- the point of the whole thing -- a case whose
// expectation no longer matches the app FAILS. A harness that can only report
// 100% is a green light wired to nothing, so most of this file is about making
// it go red on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const harness = require('../scripts/run-evals.js');

const ROOT = path.join(__dirname, '..');
const CASES = harness.loadCases();

// ---- the checked-in suite --------------------------------------------------

test('every checked-in case has an id, a known probe and an expectation', () => {
  assert.ok(CASES.length >= 30, 'expected a real suite, got ' + CASES.length + ' cases');
  const ids = new Set();
  for (const row of CASES) {
    assert.ok(row.id, 'a case in ' + row.file + ' has no id');
    assert.ok(!ids.has(row.id), 'duplicate case id: ' + row.id);
    ids.add(row.id);
    assert.ok(harness.PROBES[row.probe], row.id + ' uses an unknown probe: ' + row.probe);
    assert.ok(row.expect && Object.keys(row.expect).length, row.id + ' asserts nothing');
  }
});

test('the suite passes at or above the checked-in threshold', () => {
  const run = harness.runAll(CASES);
  const threshold = harness.readThreshold();
  assert.ok(
    run.percent >= threshold,
    'evals ' + run.passed + '/' + run.total + ' (' + run.percent + '%) is below the ' + threshold + '% threshold:\n' +
      run.failures.map((f) => '  ' + f.id + ': ' + f.reason).join('\n'),
  );
});

test('the same cases score the same twice -- no clock, no randomness, no network', () => {
  const first = harness.runAll(CASES);
  const second = harness.runAll(CASES);
  assert.equal(first.passed, second.passed);
  assert.deepEqual(first.results.map((r) => r.id + ':' + r.pass), second.results.map((r) => r.id + ':' + r.pass));
});

test('every probe is exercised by at least one case', () => {
  const used = new Set(CASES.map((c) => c.probe));
  for (const name of Object.keys(harness.PROBES)) {
    assert.ok(used.has(name), 'probe ' + name + ' has no cases');
  }
});

// ---- it can go red ---------------------------------------------------------

test('a deliberately wrong fixture fails, and says which key and what it got', () => {
  // The real tool-call case, with one character changed in what it expects the
  // parsed arguments to be. Nothing about the app changed; the harness must
  // still call it a failure.
  const real = CASES.find((c) => c.id === 'arguments-split-across-chunks');
  assert.ok(real, 'the tool-call case this test builds on is gone');
  assert.ok(harness.runCase(real).pass, 'the unmodified case should pass');

  const wrong = JSON.parse(JSON.stringify(real));
  wrong.expect.calls[0].args.query = 'weather in Bergen';
  const result = harness.runCase(wrong);
  assert.equal(result.pass, false);
  assert.match(result.reason, /^calls: expected /);
  assert.match(result.reason, /Bergen/);
  assert.match(result.reason, /Oslo/);
});

test('a wrong expectation on every case drives the score to 0%', () => {
  const broken = CASES.map((row) => ({
    ...row,
    expect: { ...row.expect, __nothing_produces_this__: 'x' },
  }));
  const run = harness.runAll(broken);
  assert.equal(run.passed, 0);
  assert.equal(run.percent, 0);
  assert.equal(run.failures.length, CASES.length);
});

test('one wrong case in the real suite drops the score below the threshold', () => {
  const threshold = harness.readThreshold();
  const broken = CASES.slice();
  broken[0] = { ...broken[0], expect: { ...broken[0].expect, __nothing_produces_this__: 'x' } };
  const run = harness.runAll(broken);
  assert.equal(run.passed, CASES.length - 1);
  assert.ok(run.percent < threshold, 'a single regression (' + run.percent + '%) must not clear the ' + threshold + '% bar');
  assert.equal(run.failures[0].id, CASES[0].id);
});

test('a probe that throws is a failure, not a crashed run', () => {
  const result = harness.runCase({ id: 'thrower', probe: 'answer-scoring', input: null, expect: { pass: true } });
  assert.equal(result.pass, false);
  // A missing task is reported, not thrown past the runner.
  assert.ok(result.reason.length > 0);
});

test('an unknown probe is a failure, so a typo cannot quietly skip a case', () => {
  const result = harness.runCase({ id: 'typo', probe: 'tool-call', input: {}, expect: { calls: [] } });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'unknown probe');
});

// ---- the probes read the real modules --------------------------------------

test('the harness scores the app, not a copy of it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'run-evals.js'), 'utf8');
  for (const mod of ['evals.js', 'tools.js', 'composer.js', 'fallback.js', 'research.js', 'recipes.js']) {
    assert.ok(source.includes("require('../desktop/src/" + mod + "')"), 'run-evals.js does not import ' + mod);
  }
  // A probe that consulted `expect` could never fail; the comparison is the
  // runner's job alone.
  const probesBlock = source.slice(source.indexOf('const PROBES = {'), source.indexOf('// ---- running'));
  assert.ok(!/\bexpect\b/.test(probesBlock), 'a probe reads the expectation it is meant to be judged against');
});

test('a probe failure names the module rule it broke, by using it', () => {
  // fallback.plan is imported, so flipping the input flips the verdict without
  // the harness knowing anything about the rule.
  const ready = harness.PROBES.fallback({ plan: { failure: { kind: 'rate-limit' }, provider: 'groq', model: 'a', next: 'b', local: { baseUrl: 'http://127.0.0.1:11434', model: 'q', ready: true } } });
  const notReady = harness.PROBES.fallback({ plan: { failure: { kind: 'rate-limit' }, provider: 'groq', model: 'a', next: 'b', local: { baseUrl: 'http://127.0.0.1:11434', model: 'q', ready: false } } });
  assert.equal(ready.automatic, true);
  assert.equal(notReady.automatic, false);
});

// ---- the threshold ---------------------------------------------------------

test('the threshold is a checked-in number between 0 and 100', () => {
  const raw = JSON.parse(fs.readFileSync(harness.THRESHOLD_FILE, 'utf8'));
  assert.equal(typeof raw.minPercent, 'number');
  assert.ok(raw.minPercent >= 0 && raw.minPercent <= 100);
  assert.equal(harness.readThreshold(), raw.minPercent);
});

test('a malformed threshold is refused rather than treated as zero', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-')), 'threshold.json');
  fs.writeFileSync(file, JSON.stringify({ minPercent: 'lots' }));
  assert.throws(() => harness.readThreshold(file), /0\.\.100/);
  fs.writeFileSync(file, JSON.stringify({ minPercent: 140 }));
  assert.throws(() => harness.readThreshold(file), /0\.\.100/);
});

// ---- loading ---------------------------------------------------------------

test('a case file with a broken line names the file and the line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  fs.writeFileSync(path.join(dir, 'bad.jsonl'), '// a comment\n\n{"id":"ok","probe":"fallback","input":{},"expect":{}}\n{nope\n');
  assert.throws(() => harness.loadCases(dir), /bad\.jsonl:4 is not JSON/);
});

test('comments and blank lines are not cases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '// header\n\n{"id":"one","probe":"fallback","input":{},"expect":{"automatic":false}}\n');
  const loaded = harness.loadCases(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'one');
  assert.equal(loaded[0].file, 'a.jsonl');
});

// ---- the score line --------------------------------------------------------

test('the run prints a score line and exits 0 at the threshold', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-evals.js')], { encoding: 'utf8' });
  assert.match(out, /^evals: \d+\/\d+ \(\d+%\), threshold \d+%$/m);
});

test('--json reports the same numbers as the library', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-evals.js'), '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  const run = harness.runAll(CASES);
  assert.equal(parsed.total, run.total);
  assert.equal(parsed.passed, run.passed);
  assert.equal(parsed.threshold, harness.readThreshold());
  assert.equal(parsed.ok, run.percent >= parsed.threshold);
});

test('a GitHub step summary is written when the runner offers one', () => {
  const { execFileSync } = require('node:child_process');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-')), 'summary.md');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-evals.js')], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: file },
  });
  const summary = fs.readFileSync(file, 'utf8');
  assert.match(summary, /### Evals: \d+\/\d+/);
  assert.match(summary, /\| Probe \| Score \|/);
  // It must not be mistaken for a model benchmark.
  assert.match(summary, /Scripted model/);
});

test('byProbe adds up to the whole run', () => {
  const run = harness.runAll(CASES);
  const rows = harness.byProbe(run.results);
  assert.equal(rows.reduce((n, r) => n + r.total, 0), run.total);
  assert.equal(rows.reduce((n, r) => n + r.passed, 0), run.passed);
  assert.deepEqual(rows.map((r) => r.probe), rows.map((r) => r.probe).slice().sort());
});
