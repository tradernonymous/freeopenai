// The eval harness: the app's deterministic layer, scored on every push.
//
// NEURA-057 asks for "the eval suite runs on every push and reports a score".
// CI has no model and no API key, so nothing here talks to one. The model is
// SCRIPTED: every reply is a fixture checked in under evals/, and what gets
// scored is the code that surrounds a reply -- prompt assembly, slash-command
// routing, tool-call parsing, the fallback ladder, citation numbering and
// template filling. A drop in the score means the app changed, never that a
// model got worse. docs/evals.md says the same thing at more length.
//
// It imports the real modules (desktop/src/*.js are UMD and load in node), so a
// case cannot pass against a reimplementation of the rule it is checking.
//
// Usage:
//   node scripts/run-evals.js                     score every case
//   node scripts/run-evals.js --json              the same run as one JSON object
//   node scripts/run-evals.js --probe=tool-calls  only that probe
// Determinism, first thing: some of the code under test formats dates in local
// time (research.js formatDate), so the same commit would otherwise score
// differently in Auckland and in CI. Pinned before anything reads a date.
process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const ROOT = path.join(__dirname, '..');
const CASES_DIR = path.join(ROOT, 'evals');
const THRESHOLD_FILE = path.join(CASES_DIR, 'threshold.json');

const evals = require('../desktop/src/evals.js');
const tools = require('../desktop/src/tools.js');
const composer = require('../desktop/src/composer.js');
const fallback = require('../desktop/src/fallback.js');
const research = require('../desktop/src/research.js');
const recipes = require('../desktop/src/recipes.js');

/** tools.needsApproval wants a Storage; an empty one keeps the answer the default. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

/** Phrases the case demanded, and phrases it forbade, checked against one text. */
function phrases(text, input) {
  const s = String(text);
  return {
    missingPhrases: (input.mustInclude || []).filter((p) => !s.includes(p)),
    forbiddenPhrases: (input.mustNotInclude || []).filter((p) => s.includes(p)),
  };
}

// ---- probes ----------------------------------------------------------------
//
// A probe turns one case's `input` into an `actual` object. The case's `expect`
// is compared key by key, so a case asserts only the fields it cares about.
// Nothing here may read `expect` -- a probe that did could never fail.

const PROBES = {
  // A scripted model reply, scored by the app's own EvalTask check. This is the
  // Evals feature's scoring rule, not a second copy of it.
  'answer-scoring'(input) {
    const task = evals.byId(input.taskId);
    if (!task) return { pass: null, note: 'no such task: ' + input.taskId };
    const scored = evals.score(task, input.reply);
    return { pass: scored.pass, note: scored.note, skill: task.skill };
  },

  // A scripted tool-calling stream, folded the way a real turn folds it.
  // Ids are deliberately not scored: tools.finish invents a random one when the
  // provider sent none, which would make the score depend on the run.
  'tool-calls'(input) {
    let state = null;
    (input.chunks || []).forEach((deltas) => { state = tools.collect(state, deltas); });
    const calls = tools.finish(state);
    const storage = memoryStorage();
    return {
      calls: calls.map((c) => ({ name: c.name, args: tools.parseArgs(c.arguments) })),
      summaries: calls.map((c) => tools.summarise(c.name, tools.parseArgs(c.arguments))),
      needsApproval: calls.map((c) => tools.needsApproval(c.name, storage)),
    };
  },

  // What the composer does with a line the user typed.
  'slash-routing'(input) {
    const hit = composer.parseSlash(input.text);
    if (!hit) return { command: null, arg: '', mode: null };
    return {
      command: hit.command.id,
      arg: hit.arg,
      mode: hit.command.mode || null,
      insertsText: !!hit.command.insertText,
      next: hit.command.next || null,
    };
  },

  // Which model the app would try next after a failed turn, and whether it may
  // do so without asking.
  fallback(input) {
    const plan = fallback.plan(input.plan);
    return {
      attempts: plan.attempts.map((a) => ({ provider: a.provider, model: a.model })),
      automatic: plan.automatic,
      ...phrases(plan.note, input),
    };
  },

  // A scripted plan reply, turned into the queries research would actually run.
  'plan-queries'(input) {
    return { queries: research.parseQueries(input.reply, input.question) };
  },

  // Citation numbering: search output -> numbered sources -> a scripted answer
  // checked and linked against them.
  citations(input) {
    const rows = typeof input.searchOutput === 'string'
      ? research.parseSearchResults(input.searchOutput)
      : [];
    let sources = Array.isArray(input.sources) ? input.sources : [];
    if (rows.length) sources = research.addSources(sources, rows, input.query || 0);
    const actual = {
      numbers: sources.map((s) => s.n),
      urls: sources.map((s) => s.url),
    };
    if (typeof input.answer === 'string') {
      const checked = research.checkCitations(input.answer, sources.length);
      actual.cited = checked.cited;
      actual.unknown = checked.unknown;
      actual.uncitedCount = checked.uncited.length;
      actual.cleaned = checked.text;
      actual.linked = research.linkCitations(input.answer, sources);
    }
    return actual;
  },

  // The messages the app sends, before any model sees them.
  'prompt-assembly'(input) {
    let messages;
    if (input.kind === 'plan') messages = research.planMessages(input.question, input.date);
    else if (input.kind === 'no-sources') messages = research.noSourcesMessages(input.question, input.date);
    else if (input.kind === 'synthesis') messages = research.synthesisMessages(input.question, input.sources || [], input.pages || {}, input.date);
    else return { roles: ['unknown kind: ' + input.kind] };
    const joined = messages.map((m) => m.role + '\n' + m.content).join('\n\n');
    return {
      roles: messages.map((m) => m.role),
      ...phrases(joined, input),
    };
  },

  // Recipe selection and template filling: what a `/recipe ...` line means and
  // what prompt it produces.
  template(input) {
    const actual = {};
    const values = typeof input.command === 'string'
      ? recipes.parseCommand(input.command, input.params || []).values
      : (input.values || {});
    if (typeof input.command === 'string') {
      actual.id = recipes.parseCommand(input.command, input.params || []).id;
      actual.values = values;
    }
    if (typeof input.prompt === 'string') {
      const filled = recipes.fillTemplate(input.prompt, input.params || [], values);
      actual.text = filled.text;
      actual.missing = filled.missing;
      actual.placeholders = recipes.placeholders(input.prompt);
    }
    return actual;
  },
};

// ---- running ---------------------------------------------------------------

/** Every checked-in case, in file then line order, so a run is reproducible. */
function loadCases(dir) {
  const from = dir || CASES_DIR;
  const files = fs.readdirSync(from).filter((f) => f.endsWith('.jsonl')).sort();
  const cases = [];
  files.forEach((file) => {
    const text = fs.readFileSync(path.join(from, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        throw new Error(file + ':' + (i + 1) + ' is not JSON: ' + e.message);
      }
      cases.push({ ...parsed, file });
    });
  });
  return cases;
}

/**
 * One case: { id, probe, pass, reason }. A case fails when the probe is
 * unknown, when it throws, or when any key of `expect` differs from `actual`.
 */
function runCase(row) {
  const probe = PROBES[row.probe];
  if (!probe) return { id: row.id, probe: row.probe, pass: false, reason: 'unknown probe' };
  let actual;
  try {
    actual = probe(row.input || {});
  } catch (e) {
    return { id: row.id, probe: row.probe, pass: false, reason: 'threw: ' + (e && e.message ? e.message : String(e)) };
  }
  const bad = [];
  Object.keys(row.expect || {}).forEach((key) => {
    if (!isDeepStrictEqual(actual[key], row.expect[key])) {
      bad.push(key + ': expected ' + show(row.expect[key]) + ', got ' + show(actual[key]));
    }
  });
  return { id: row.id, probe: row.probe, pass: !bad.length, reason: bad.join('; ') };
}

function show(value) {
  const s = JSON.stringify(value === undefined ? null : value);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

/** Every case, plus the score. `percent` is rounded down, so 29/30 is 96 not 97. */
function runAll(cases) {
  const results = (cases || []).map(runCase);
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  return {
    results,
    failures: results.filter((r) => !r.pass),
    passed,
    total,
    percent: total ? Math.floor((passed / total) * 100) : 0,
  };
}

/** The checked-in bar. Raising it is a deliberate one-line commit. */
function readThreshold(file) {
  const raw = JSON.parse(fs.readFileSync(file || THRESHOLD_FILE, 'utf8'));
  const min = Number(raw.minPercent);
  if (!Number.isFinite(min) || min < 0 || min > 100) throw new Error('threshold.json: minPercent must be a number 0..100');
  return min;
}

/** One line per probe, so a drop says which part of the app moved. */
function byProbe(results) {
  const rows = new Map();
  (results || []).forEach((r) => {
    const row = rows.get(r.probe) || { probe: r.probe, passed: 0, total: 0 };
    row.total += 1;
    if (r.pass) row.passed += 1;
    rows.set(r.probe, row);
  });
  return [...rows.values()].sort((a, b) => a.probe.localeCompare(b.probe));
}

function main(argv) {
  const only = (argv.find((a) => a.startsWith('--probe=')) || '').slice('--probe='.length);
  const asJson = argv.includes('--json');
  let cases = loadCases();
  if (only) cases = cases.filter((c) => c.probe === only);
  const run = runAll(cases);
  const threshold = readThreshold();
  const ok = run.percent >= threshold;

  if (asJson) {
    console.log(JSON.stringify({ passed: run.passed, total: run.total, percent: run.percent, threshold, ok, failures: run.failures }, null, 2));
  } else {
    byProbe(run.results).forEach((row) => {
      console.log('  ' + row.probe.padEnd(16) + ' ' + row.passed + '/' + row.total);
    });
    run.failures.forEach((f) => console.log('  FAIL ' + f.id + ' (' + f.probe + '): ' + f.reason));
    console.log('evals: ' + run.passed + '/' + run.total + ' (' + run.percent + '%), threshold ' + threshold + '%');
  }

  // Cheap: one append when the runner offers the file, nothing otherwise.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const lines = [
      '### Evals: ' + run.passed + '/' + run.total + ' (' + run.percent + '%)', '',
      'Threshold ' + threshold + '% — ' + (ok ? 'pass' : 'FAIL') + '. Scripted model, no network: this scores the app, not a model.', '',
      '| Probe | Score |', '| --- | --- |',
    ];
    byProbe(run.results).forEach((row) => lines.push('| ' + row.probe + ' | ' + row.passed + '/' + row.total + ' |'));
    if (run.failures.length) {
      lines.push('', '**Failing cases**', '');
      run.failures.forEach((f) => lines.push('- `' + f.id + '` (' + f.probe + '): ' + f.reason));
    }
    try {
      fs.appendFileSync(summaryFile, lines.join('\n') + '\n');
    } catch { /* a summary is a nicety; the log line above is the result */ }
  }

  return ok ? 0 : 1;
}

module.exports = { PROBES, loadCases, runCase, runAll, readThreshold, byProbe, CASES_DIR, THRESHOLD_FILE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
