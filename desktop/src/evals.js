// Evals: the same small tasks against several models, scored by code.
//
// Roadmap 6.6 asks for "which of my models actually does this" answered with
// numbers rather than impressions. The built-in set is short tasks with a
// DETERMINISTIC check each -- a number, a JSON shape, an exact list -- so a
// run needs no judge model and two runs agree. The tasks cover what matters
// for this app: following an output format, producing parseable JSON (what
// tool calls are made of), short reasoning and extraction.
//
// A clean reimplementation of the idea only; nothing is taken from evalbuff.
// UMD like the repo's other shared modules.
//
// History and schedule (below): every finished run is kept
// (freeai4u.evals_history, newest last, capped), compared with the model's
// previous run, and a schedule (freeai4u.evals_schedule) re-runs the suite
// while the app is open, so a model that got worse is noticed. The due-time
// rule is recipes.js nextRun -- one scheduling rule, not two.
(function (root, factory) {
  // Real CommonJS only (see files/office.js): in a bundle `module` can exist
  // without `require`, and there recipes.js is read off the global it publishes.
  var isCjs = typeof module === 'object' && module.exports && typeof require === 'function';
  var recipes = isCjs ? require('./recipes.js') : null;
  var api = factory(function () { return recipes || (root && root.FreeAI4URecipes) || null; });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UEvals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (recipesLib) {
  /** The reply without reasoning blocks or a wrapping code fence. */
  function answerOf(reply) {
    var text = String(reply || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
    var fenced = /^```[\w-]*\s*([\s\S]*?)```$/.exec(text);
    return fenced ? fenced[1].trim() : text;
  }

  function jsonOf(reply) {
    var text = answerOf(reply);
    try { return JSON.parse(text); } catch { /* fall through */ }
    var m = /[[{][\s\S]*[\]}]/.exec(text);
    if (!m) return undefined;
    try { return JSON.parse(m[0]); } catch { return undefined; }
  }

  function ok(pass, note) {
    return { pass: !!pass, note: note || '' };
  }

  var TASKS = [
    {
      id: 'arith', title: 'Arithmetic', skill: 'reasoning',
      prompt: 'What is 17 multiplied by 23? Reply with the number only.',
      check: function (r) { var a = answerOf(r); return ok(/^\D*391\D*$/.test(a), a === '391' ? '' : 'expected 391 alone'); },
    },
    {
      id: 'json-object', title: 'JSON object', skill: 'format',
      prompt: 'Reply with only a JSON object with the keys "name" (a string) and "age" (a number) for a person called Ada who is 36. No prose, no code fence.',
      check: function (r) {
        var j = jsonOf(r);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return ok(false, 'not a JSON object');
        return ok(j.name === 'Ada' && j.age === 36, 'expected {"name":"Ada","age":36}');
      },
    },
    {
      id: 'json-array', title: 'JSON array', skill: 'format',
      prompt: 'Return a JSON array of the three primary colours of light, in lowercase English. Only the array.',
      check: function (r) {
        var j = jsonOf(r);
        if (!Array.isArray(j)) return ok(false, 'not a JSON array');
        var got = j.map(function (x) { return String(x).toLowerCase().trim(); }).sort().join(',');
        return ok(got === 'blue,green,red', 'expected red, green, blue');
      },
    },
    {
      id: 'exact-list', title: 'Exact list', skill: 'format',
      prompt: 'List the first five prime numbers separated by commas, and nothing else.',
      check: function (r) {
        var a = answerOf(r).replace(/\.$/, '');
        return ok(/^\s*2\s*,\s*3\s*,\s*5\s*,\s*7\s*,\s*11\s*$/.test(a), 'expected 2, 3, 5, 7, 11');
      },
    },
    {
      id: 'three-words', title: 'Three words', skill: 'instructions',
      prompt: 'Describe the sea in exactly three words, all lowercase, no punctuation.',
      check: function (r) {
        var a = answerOf(r);
        var words = a.split(/\s+/).filter(Boolean);
        if (words.length !== 3) return ok(false, words.length + ' words');
        return ok(a === a.toLowerCase() && !/[.,!?;:]/.test(a), 'must be lowercase without punctuation');
      },
    },
    {
      id: 'extract', title: 'Extraction', skill: 'extraction',
      prompt: 'From this line, reply with only the city: "Order #4471 shipped to Lisbon on 3 May."',
      check: function (r) { return ok(/^\W*lisbon\W*$/i.test(answerOf(r)), 'expected Lisbon alone'); },
    },
    {
      id: 'bat-ball', title: 'Trick question', skill: 'reasoning',
      prompt: 'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How many cents does the ball cost? Reply with the number only.',
      check: function (r) { return ok(/^\D*5\D*$/.test(answerOf(r)), 'expected 5 (the intuitive 10 is wrong)'); },
    },
    {
      id: 'tool-args', title: 'Tool-call arguments', skill: 'tools',
      prompt: 'You would call a tool named search_web with one argument "query" to find the weather in Oslo. Reply with only the JSON arguments object for that call.',
      check: function (r) {
        var j = jsonOf(r);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return ok(false, 'not a JSON object');
        return ok(typeof j.query === 'string' && /oslo/i.test(j.query) && Object.keys(j).length === 1, 'expected {"query": "...Oslo..."}');
      },
    },
  ];

  function byId(id) {
    for (var i = 0; i < TASKS.length; i += 1) if (TASKS[i].id === id) return TASKS[i];
    return null;
  }

  /** Score one reply; a check that throws is a fail, not a crash. */
  function score(task, reply) {
    try {
      return task.check(reply);
    } catch (e) {
      return ok(false, 'check failed: ' + (e && e.message ? e.message : e));
    }
  }

  /**
   * results: [{ target: {label}, taskId, pass, ms, chars, error? }]
   * -> one row per model, best pass rate first, then fastest.
   */
  function summarize(results) {
    var rows = {};
    var order = [];
    (results || []).forEach(function (r) {
      var key = r.target && r.target.label;
      if (!key) return;
      if (!rows[key]) { rows[key] = { target: r.target, passed: 0, total: 0, ms: 0, chars: 0, errors: 0 }; order.push(key); }
      var row = rows[key];
      row.total += 1;
      if (r.pass) row.passed += 1;
      if (r.error) row.errors += 1;
      row.ms += Number(r.ms) || 0;
      row.chars += Number(r.chars) || 0;
    });
    return order.map(function (k) {
      var row = rows[k];
      return {
        target: row.target,
        passed: row.passed,
        total: row.total,
        errors: row.errors,
        rate: row.total ? row.passed / row.total : 0,
        avgMs: row.total ? Math.round(row.ms / row.total) : 0,
        avgChars: row.total ? Math.round(row.chars / row.total) : 0,
      };
    }).sort(function (a, b) { return b.rate - a.rate || a.avgMs - b.avgMs; });
  }

  function toCsv(results) {
    var esc = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = ['model,task,pass,ms,chars,note'];
    (results || []).forEach(function (r) {
      lines.push([r.target && r.target.label, r.taskId, r.pass ? 1 : 0, r.ms, r.chars, r.note || r.error || ''].map(esc).join(','));
    });
    return lines.join('\n') + '\n';
  }

  // ---- history -------------------------------------------------------------------

  var HISTORY_KEY = 'freeai4u.evals_history';
  var SCHEDULE_KEY = 'freeai4u.evals_schedule';
  var HISTORY_CAP = 200;
  var HISTORY_EVENT = 'freeai4u:evals-history-changed';
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function storage(given) {
    if (given) return given;
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : {};
      return scope.localStorage || null;
    } catch {
      return null;
    }
  }

  function announce() {
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : null;
      if (scope && typeof scope.dispatchEvent === 'function' && typeof scope.Event === 'function') {
        scope.dispatchEvent(new scope.Event(HISTORY_EVENT));
      }
    } catch { /* a listener is a convenience */ }
  }

  function readJson(key, fallback, given) {
    var target = storage(given);
    if (!target) return fallback;
    try {
      var parsed = JSON.parse(target.getItem(key) || 'null');
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value, given) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(key, JSON.stringify(value));
      announce();
      return true;
    } catch {
      return false;
    }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** One model's identity across runs: provider::model, or its label when those are missing. */
  function targetKey(target) {
    if (!target) return '';
    if (target.provider && target.model) return String(target.provider) + '::' + String(target.model);
    return String(target.label || '');
  }

  function cleanTarget(t) {
    return { provider: String((t && t.provider) || ''), model: String((t && t.model) || ''), label: String((t && t.label) || targetKey(t)) };
  }

  /** Per-model totals of a run's rows, in the run's target order. */
  function summarizeRows(targets, rows) {
    return (targets || []).map(function (t) {
      var key = targetKey(t);
      var mine = (rows || []).filter(function (r) { return r.targetKey === key; });
      var passed = mine.filter(function (r) { return r.pass; }).length;
      var ms = mine.reduce(function (sum, r) { return sum + (Number(r.ms) || 0); }, 0);
      return {
        key: key,
        label: t.label || key,
        passed: passed,
        total: mine.length,
        errors: mine.filter(function (r) { return r.error; }).length,
        rate: mine.length ? passed / mine.length : 0,
        avgMs: mine.length ? Math.round(ms / mine.length) : 0,
      };
    });
  }

  /**
   * makeRun(results, { at, trigger, targets? }) -> a history run from the
   * screen's EvalResult rows. Targets default to the ones the rows name.
   */
  function makeRun(results, opts) {
    var o = opts || {};
    var at = Number(o.at) || Date.now();
    var targets = [];
    var seen = {};
    (Array.isArray(o.targets) ? o.targets : (results || []).map(function (r) { return r.target; })).forEach(function (t) {
      var key = targetKey(t);
      if (!key || seen[key]) return;
      seen[key] = true;
      targets.push(cleanTarget(t));
    });
    var rows = (results || []).filter(function (r) { return r && r.target && r.taskId; }).map(function (r) {
      var row = {
        taskId: String(r.taskId),
        targetKey: targetKey(r.target),
        pass: !!r.pass,
        ms: Number(r.ms) || 0,
        chars: Number(r.chars) || 0,
        note: String(r.note || r.error || ''),
      };
      if (r.error) row.error = true;
      return row;
    });
    return {
      id: 'run-' + at.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
      at: at,
      trigger: o.trigger === 'schedule' ? 'schedule' : 'manual',
      targets: targets,
      rows: rows,
      summary: summarizeRows(targets, rows),
    };
  }

  function validRun(run) {
    return isPlainObject(run) && typeof run.id === 'string' && Number(run.at) > 0 && Array.isArray(run.targets) && Array.isArray(run.rows);
  }

  /** The stored runs, oldest first; anything malformed is skipped. */
  function readHistory(given) {
    var rows = readJson(HISTORY_KEY, [], given);
    return (Array.isArray(rows) ? rows : []).filter(validRun).map(function (run) {
      return Array.isArray(run.summary) ? run : Object.assign({}, run, { summary: summarizeRows(run.targets, run.rows) });
    });
  }

  /** Add a run and keep the newest `cap` (default 200). Returns the stored list. */
  function appendRun(run, given, cap) {
    var limit = Number(cap) > 0 ? Math.floor(Number(cap)) : HISTORY_CAP;
    var next = readHistory(given).concat(validRun(run) ? [run] : []);
    if (next.length > limit) next = next.slice(next.length - limit);
    writeJson(HISTORY_KEY, next, given);
    return next;
  }

  function clearHistory(given) {
    return writeJson(HISTORY_KEY, [], given);
  }

  function exportHistory(runs) {
    return JSON.stringify({ kind: 'neuraos-evals-history', runs: Array.isArray(runs) ? runs : [] }, null, 2);
  }

  // ---- comparison -----------------------------------------------------------------

  function rowsOf(run, key) {
    var out = {};
    ((run && run.rows) || []).forEach(function (r) { if (r.targetKey === key) out[r.taskId] = r; });
    return out;
  }

  function labelOf(run, key) {
    var t = ((run && run.targets) || []).find(function (x) { return targetKey(x) === key; });
    return (t && t.label) || key;
  }

  function avgMs(rows) {
    var timed = rows.filter(function (r) { return !r.error && Number(r.ms) > 0; });
    if (!timed.length) return 0;
    return timed.reduce(function (s, r) { return s + Number(r.ms); }, 0) / timed.length;
  }

  /**
   * One model, previous run vs current. Rates are over the tasks BOTH runs
   * asked, so unticking a task is not a regression.
   */
  function compareOne(previous, current, key) {
    var now = rowsOf(current, key);
    var nowIds = Object.keys(now);
    var before = previous ? rowsOf(previous, key) : {};
    var common = nowIds.filter(function (id) { return before[id]; });
    var nowRows = nowIds.map(function (id) { return now[id]; });
    var out = {
      key: key,
      label: labelOf(current, key),
      before: null,
      after: null,
      delta: null,
      beforePassed: 0,
      afterPassed: 0,
      total: common.length,
      newlyFailing: [],
      slower: null,
      unreachable: nowRows.length > 0 && nowRows.every(function (r) { return r.error; }),
    };
    if (!common.length) {
      var passedNow = nowRows.filter(function (r) { return r.pass; }).length;
      out.afterPassed = passedNow;
      out.total = nowRows.length;
      out.after = nowRows.length ? passedNow / nowRows.length : null;
      return out;
    }
    out.beforePassed = common.filter(function (id) { return before[id].pass; }).length;
    out.afterPassed = common.filter(function (id) { return now[id].pass; }).length;
    out.before = out.beforePassed / common.length;
    out.after = out.afterPassed / common.length;
    out.delta = out.after - out.before;
    out.newlyFailing = common.filter(function (id) { return before[id].pass && !now[id].pass; });
    var msBefore = avgMs(common.map(function (id) { return before[id]; }));
    var msAfter = avgMs(common.map(function (id) { return now[id]; }));
    out.beforeMs = Math.round(msBefore);
    out.afterMs = Math.round(msAfter);
    out.slower = msBefore > 0 && msAfter > 0 ? msAfter / msBefore : null;
    return out;
  }

  /** compareRuns(previous, current) -> one entry per model in `current`. */
  function compareRuns(previous, current) {
    return ((current && current.targets) || []).map(function (t) {
      var key = targetKey(t);
      var had = previous && (previous.rows || []).some(function (r) { return r.targetKey === key; });
      return compareOne(had ? previous : null, current, key);
    });
  }

  /**
   * Like compareRuns, but each model against ITS latest earlier run in
   * `history` -- the run before may have been of other models.
   */
  function compareToHistory(history, current) {
    var earlier = (Array.isArray(history) ? history : []).filter(function (r) { return r.id !== current.id && r.at <= current.at; });
    return ((current && current.targets) || []).map(function (t) {
      var key = targetKey(t);
      var prev = null;
      for (var i = earlier.length - 1; i >= 0; i -= 1) {
        if ((earlier[i].rows || []).some(function (r) { return r.targetKey === key; })) { prev = earlier[i]; break; }
      }
      return compareOne(prev, current, key);
    });
  }

  /**
   * The comparisons that count as "got worse": the pass rate fell by at least
   * `dropAtLeast` (default one task in eight), or it got `slowerBy` times
   * slower (default 2x, and only once a reply takes `minMs`, default 1 s).
   * A model that errored on every task is unreachable, not worse.
   */
  function regressions(comparison, opts) {
    var o = opts || {};
    var drop = o.dropAtLeast != null ? Number(o.dropAtLeast) : 0.125;
    var slowerBy = o.slowerBy != null ? Number(o.slowerBy) : 2;
    var minMs = o.minMs != null ? Number(o.minMs) : 1000;
    var out = [];
    (comparison || []).forEach(function (c) {
      if (!c || c.unreachable) return;
      var reasons = [];
      if (c.delta != null && -c.delta >= drop - 1e-9) reasons.push('rate');
      if (c.slower != null && c.slower >= slowerBy && (c.afterMs || 0) >= minMs) reasons.push('slower');
      if (reasons.length) out.push(Object.assign({}, c, { reasons: reasons }));
    });
    return out;
  }

  /** "<label>: 7/8 → 5/8 (new failures: arith, json-object)" */
  function regressionMessage(r) {
    var parts = [];
    if (r.reasons && r.reasons.indexOf('rate') >= 0) {
      parts.push(r.beforePassed + '/' + r.total + ' → ' + r.afterPassed + '/' + r.total +
        (r.newlyFailing && r.newlyFailing.length ? ' (new failures: ' + r.newlyFailing.join(', ') + ')' : ''));
    }
    if (r.reasons && r.reasons.indexOf('slower') >= 0) {
      parts.push(r.slower.toFixed(1) + '× slower (' + (r.beforeMs / 1000).toFixed(1) + 's → ' + (r.afterMs / 1000).toFixed(1) + 's)');
    }
    return r.label + ': ' + parts.join('; ');
  }

  /** Pass rate over time for one model: [{ at, rate, passed, total }], oldest first. */
  function series(history, key) {
    var out = [];
    (Array.isArray(history) ? history : []).forEach(function (run) {
      var row = (run.summary || []).find(function (s) { return s.key === key; });
      if (row && row.total) out.push({ at: run.at, rate: row.rate, passed: row.passed, total: row.total });
    });
    return out;
  }

  /** 'up' | 'down' | 'flat': the last point against the mean of the (up to) three before it. */
  function trend(points) {
    var p = Array.isArray(points) ? points : [];
    if (p.length < 2) return 'flat';
    var last = p[p.length - 1].rate;
    var prior = p.slice(Math.max(0, p.length - 4), p.length - 1);
    var mean = prior.reduce(function (s, x) { return s + x.rate; }, 0) / prior.length;
    if (last - mean > 0.01) return 'up';
    if (mean - last > 0.01) return 'down';
    return 'flat';
  }

  // ---- schedule ----------------------------------------------------------------------

  /** { enabled, everyHours (1-168) | dailyAt 'HH:MM', targets, lastRunAt } -- invalid parts dropped. */
  function normalizeSchedule(raw) {
    var s = isPlainObject(raw) ? raw : {};
    var out = { enabled: s.enabled === true, targets: [], lastRunAt: Number(s.lastRunAt) > 0 ? Number(s.lastRunAt) : 0 };
    var every = Number(s.everyHours);
    if (s.everyHours != null && Number.isInteger(every) && every >= 1 && every <= 168) out.everyHours = every;
    if (typeof s.dailyAt === 'string' && TIME_RE.test(s.dailyAt)) out.dailyAt = s.dailyAt;
    var seen = {};
    (Array.isArray(s.targets) ? s.targets : []).forEach(function (t) {
      var key = targetKey(t);
      if (!key || seen[key] || !isPlainObject(t) || !t.provider || !t.model) return;
      seen[key] = true;
      out.targets.push(cleanTarget(t));
    });
    return out;
  }

  function readSchedule(given) {
    return normalizeSchedule(readJson(SCHEDULE_KEY, {}, given));
  }

  function writeSchedule(schedule, given) {
    var clean = normalizeSchedule(schedule);
    return writeJson(SCHEDULE_KEY, clean, given) ? clean : null;
  }

  /**
   * nextEvalRun(schedule, lastRunAt, now) -> epoch ms, or null when off.
   * The rule is recipes.js nextRun (every N hours = every N*60 minutes;
   * a daily slot missed while the app was closed is due once, now).
   */
  function nextEvalRun(schedule, lastRunAt, now) {
    var s = normalizeSchedule(schedule);
    if (!s.enabled || (!s.everyHours && !s.dailyAt)) return null;
    var lib = recipesLib();
    if (!lib) return null;
    var recipeSchedule = { enabled: true };
    if (s.everyHours) recipeSchedule.everyMinutes = s.everyHours * 60;
    if (s.dailyAt) recipeSchedule.dailyAt = s.dailyAt;
    return lib.nextRun({ schedule: recipeSchedule }, lastRunAt, now);
  }

  function scheduleLabel(schedule) {
    var s = normalizeSchedule(schedule);
    var parts = [];
    if (s.everyHours) parts.push('every ' + s.everyHours + ' h');
    if (s.dailyAt) parts.push('daily at ' + s.dailyAt);
    if (!parts.length) return 'not scheduled';
    return parts.join(', ') + (s.enabled ? '' : ' (off)');
  }

  return {
    TASKS: TASKS,
    byId: byId,
    answerOf: answerOf,
    jsonOf: jsonOf,
    score: score,
    summarize: summarize,
    toCsv: toCsv,
    HISTORY_KEY: HISTORY_KEY,
    SCHEDULE_KEY: SCHEDULE_KEY,
    HISTORY_CAP: HISTORY_CAP,
    HISTORY_EVENT: HISTORY_EVENT,
    targetKey: targetKey,
    makeRun: makeRun,
    readHistory: readHistory,
    appendRun: appendRun,
    clearHistory: clearHistory,
    exportHistory: exportHistory,
    compareRuns: compareRuns,
    compareToHistory: compareToHistory,
    regressions: regressions,
    regressionMessage: regressionMessage,
    series: series,
    trend: trend,
    normalizeSchedule: normalizeSchedule,
    readSchedule: readSchedule,
    writeSchedule: writeSchedule,
    nextEvalRun: nextEvalRun,
    scheduleLabel: scheduleLabel,
  };
});
