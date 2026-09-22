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
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UEvals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  return { TASKS: TASKS, byId: byId, answerOf: answerOf, jsonOf: jsonOf, score: score, summarize: summarize, toCsv: toCsv };
});
