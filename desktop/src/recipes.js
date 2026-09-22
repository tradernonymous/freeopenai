// Recipes and automations (roadmap 6.8): a saved prompt with parameters, the
// model and MCP servers it needs, and optionally a schedule.
//
//   * `/recipe <id> key=value ...` fills the {{placeholders}} and runs it in the
//     current chat. Words without a key fill the first parameter not given.
//   * EXTENSIONS are MCP servers by name. A local (stdio) one spawns a process
//     on this PC, so the first time a recipe would start one the person is
//     asked, and the answer is remembered per recipe and server
//     (freeai4u.recipes.consent) -- a recipe imported from someone else never
//     starts a program nobody agreed to.
//   * SCHEDULES run while the app is open. The due-time rule is here and pure
//     -- nextRun(recipe, lastRun, now) -- so it is tested without a clock; the
//     app only asks "is anything due" once a minute.
//
// Like agents.js, a recipe is data: a field that would carry code is refused.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4URecipes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var KEY = 'freeai4u.recipes';
  var RUNS_KEY = 'freeai4u.recipes.runs';
  var CONSENT_KEY = 'freeai4u.recipes.consent';
  var CHANGED_EVENT = 'freeai4u:recipes-changed';
  var MINUTE = 60000;
  var FIELDS = ['id', 'name', 'systemPrompt', 'prompt', 'params', 'model', 'extensions', 'responseSchema', 'schedule'];
  // The same refusal agents.js makes: nothing imported may run code.
  var CODE_FIELDS = ['handlesteps', 'handle_steps', 'code', 'script', 'scripts', 'source', 'function', 'functions',
    'fn', 'eval', 'exec', 'handler', 'handlers', 'js', 'javascript', 'onstep', 'hooks'];
  var ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  var PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
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
        scope.dispatchEvent(new scope.Event(CHANGED_EVENT));
      }
    } catch { /* a listener is a convenience */ }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasFunction(value, depth) {
    if (typeof value === 'function') return true;
    if ((depth || 0) > 12 || !value || typeof value !== 'object') return false;
    return Object.keys(value).some(function (k) { return hasFunction(value[k], (depth || 0) + 1); });
  }

  function str(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  // Same rule as tools.js slug(): how a server name is compared.
  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  }

  /** validate(raw) -> { ok, errors, warnings, recipe }. Unknown keys are dropped; code is refused. */
  function validate(raw) {
    var errors = [];
    var warnings = [];
    if (!isPlainObject(raw)) return { ok: false, errors: ['A recipe is a JSON object.'], warnings: warnings, recipe: null };
    var codeKey = Object.keys(raw).find(function (k) { return CODE_FIELDS.indexOf(k.toLowerCase()) >= 0; });
    if (codeKey) {
      return { ok: false, errors: ['"' + codeKey + '" carries code, and recipes never run code. Put the steps in the prompt.'], warnings: warnings, recipe: null };
    }
    if (hasFunction(raw, 0)) return { ok: false, errors: ['A recipe is JSON data only; it contains a function.'], warnings: warnings, recipe: null };
    Object.keys(raw).forEach(function (k) {
      if (FIELDS.indexOf(k) < 0) warnings.push('Unknown field "' + k + '" was dropped.');
    });
    var recipe = {
      id: str(raw.id, 40),
      name: str(raw.name, 60),
      systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt.trim().slice(0, 20000) : '',
      prompt: typeof raw.prompt === 'string' ? raw.prompt.trim().slice(0, 20000) : '',
      params: [],
      extensions: [],
    };
    if (!ID_RE.test(recipe.id)) errors.push('id: lowercase letters, digits, - or _, up to 40 characters.');
    if (!recipe.name) errors.push('name is required.');
    if (!recipe.prompt) errors.push('prompt is required.');
    if (raw.params != null && !Array.isArray(raw.params)) errors.push('params is a list of { name, label, default }.');
    (Array.isArray(raw.params) ? raw.params : []).slice(0, 20).forEach(function (p) {
      var name = isPlainObject(p) ? str(p.name, 40) : '';
      if (!PARAM_RE.test(name)) { errors.push('params: "' + (name || String(p)) + '" is not a parameter name (letters, digits, _).'); return; }
      if (recipe.params.some(function (q) { return q.name === name; })) return;
      recipe.params.push({ name: name, label: str(p.label, 80) || name, default: p.default == null ? '' : String(p.default).slice(0, 2000) });
    });
    if (raw.model != null) {
      if (!isPlainObject(raw.model) || !str(raw.model.provider, 80) || !str(raw.model.model, 200)) {
        errors.push('model is { "provider": "...", "model": "..." }, or leave it out to use the chat\'s model.');
      } else {
        recipe.model = { provider: str(raw.model.provider, 80), model: str(raw.model.model, 200) };
      }
    }
    if (raw.extensions != null && !Array.isArray(raw.extensions)) errors.push('extensions is a list of MCP server names.');
    (Array.isArray(raw.extensions) ? raw.extensions : []).slice(0, 16).forEach(function (e) {
      var name = str(e, 40);
      if (!slug(name)) errors.push('extensions: "' + String(e) + '" is not a server name.');
      else if (recipe.extensions.indexOf(name) < 0) recipe.extensions.push(name);
    });
    if (raw.responseSchema != null) {
      if (!isPlainObject(raw.responseSchema)) errors.push('responseSchema is a JSON schema object.');
      else recipe.responseSchema = JSON.parse(JSON.stringify(raw.responseSchema));
    }
    if (raw.schedule != null) {
      var s = raw.schedule;
      if (!isPlainObject(s)) errors.push('schedule is { "everyMinutes": 60 } or { "dailyAt": "08:30" }.');
      else {
        var schedule = { enabled: s.enabled !== false };
        if (s.everyMinutes != null) {
          var every = Number(s.everyMinutes);
          if (!Number.isInteger(every) || every < 1 || every > 10080) errors.push('schedule.everyMinutes is a whole number from 1 to 10080.');
          else schedule.everyMinutes = every;
        }
        if (s.dailyAt != null) {
          if (typeof s.dailyAt !== 'string' || !TIME_RE.test(s.dailyAt)) errors.push('schedule.dailyAt is "HH:MM", 24-hour.');
          else schedule.dailyAt = s.dailyAt;
        }
        if (s.everyMinutes == null && s.dailyAt == null) errors.push('schedule needs everyMinutes or dailyAt.');
        recipe.schedule = schedule;
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, recipe: errors.length ? null : recipe };
  }

  // ---- storage ----------------------------------------------------------------

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

  function list(given) {
    var rows = readJson(KEY, [], given);
    var out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (raw) {
      var checked = validate(raw);
      if (checked.ok) out.push(checked.recipe);
    });
    return out;
  }

  function get(id, given) {
    var wanted = String(id || '').trim().toLowerCase();
    return list(given).find(function (r) { return r.id === wanted; }) || null;
  }

  function save(raw, given) {
    var checked = validate(raw);
    if (!checked.ok) return checked;
    var rest = list(given).filter(function (r) { return r.id !== checked.recipe.id; });
    rest.push(checked.recipe);
    if (!writeJson(KEY, rest, given)) return { ok: false, errors: ['Storage refused the write.'], warnings: checked.warnings, recipe: null };
    return checked;
  }

  function remove(id, given) {
    var rows = list(given);
    var next = rows.filter(function (r) { return r.id !== id; });
    return next.length !== rows.length && writeJson(KEY, next, given);
  }

  function parseImport(text) {
    var parsed;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch {
      return { recipes: [], errors: ['That is not valid JSON.'] };
    }
    var rows = Array.isArray(parsed) ? parsed : (isPlainObject(parsed) && Array.isArray(parsed.recipes) ? parsed.recipes : [parsed]);
    var recipes = [];
    var errors = [];
    rows.forEach(function (raw, i) {
      var checked = validate(raw);
      if (checked.ok) recipes.push(checked.recipe);
      else errors.push(((raw && raw.id) || '#' + (i + 1)) + ': ' + checked.errors.join(' '));
    });
    return { recipes: recipes, errors: errors };
  }

  function exportJson(recipes) {
    return JSON.stringify({ recipes: Array.isArray(recipes) ? recipes : [] }, null, 2);
  }

  // ---- parameters ---------------------------------------------------------------

  /** The {{names}} a prompt uses, in order, once each. */
  function placeholders(prompt) {
    var out = [];
    String(prompt || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, function (_, name) {
      if (out.indexOf(name) < 0) out.push(name);
      return '';
    });
    return out;
  }

  /**
   * fillTemplate(prompt, params, values) -> { text, missing }
   *
   * A value given wins, then the parameter's default. A placeholder with
   * neither is left empty and named in `missing`, so the caller can ask.
   */
  function fillTemplate(prompt, params, values) {
    var given = values || {};
    var defaults = {};
    (Array.isArray(params) ? params : []).forEach(function (p) { if (p && p.name) defaults[p.name] = p.default == null ? '' : String(p.default); });
    var missing = [];
    var text = String(prompt || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, function (_, name) {
      if (given[name] != null && String(given[name]) !== '') return String(given[name]);
      if (defaults[name]) return defaults[name];
      if (missing.indexOf(name) < 0) missing.push(name);
      return '';
    });
    return { text: text, missing: missing };
  }

  function splitWords(line) {
    var out = [];
    var re = /(\S+?=)?"([^"]*)"|(\S+?=)?'([^']*)'|(\S+)/g;
    var m;
    while ((m = re.exec(String(line || '')))) {
      if (m[2] != null) out.push((m[1] || '') + m[2]);
      else if (m[4] != null) out.push((m[3] || '') + m[4]);
      else out.push(m[5]);
    }
    return out;
  }

  /**
   * '/recipe <id> ...' arguments -> { id, values }. `key=value` (quotes keep
   * spaces) sets a parameter; the remaining words, joined, fill the first
   * parameter nobody set.
   */
  function parseCommand(arg, recipeParams) {
    var words = splitWords(arg);
    var id = (words.shift() || '').toLowerCase();
    var values = {};
    var loose = [];
    words.forEach(function (w) {
      var at = w.indexOf('=');
      if (at > 0 && PARAM_RE.test(w.slice(0, at))) values[w.slice(0, at)] = w.slice(at + 1);
      else loose.push(w);
    });
    if (loose.length) {
      var open = (Array.isArray(recipeParams) ? recipeParams : []).find(function (p) { return values[p.name] == null; });
      if (open) values[open.name] = loose.join(' ');
    }
    return { id: id, values: values };
  }

  // ---- scheduling ------------------------------------------------------------------

  function slotOn(dayOf, hhmm) {
    var m = TIME_RE.exec(hhmm);
    var d = new Date(dayOf);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  }

  /** The next daily slot strictly after `after`, local time. */
  function dailyAfter(hhmm, after) {
    var slot = slotOn(after, hhmm);
    if (slot <= after) {
      var next = new Date(after);
      next.setDate(next.getDate() + 1);
      slot = slotOn(next.getTime(), hhmm);
    }
    return slot;
  }

  /**
   * nextRun(recipe, lastRun, now) -> epoch ms, or null when it is not scheduled.
   *
   *   * everyMinutes: lastRun + interval; never run -> due now.
   *   * dailyAt: the first slot after lastRun -- which may already be past (the
   *     app was closed), and then it is due now, once. Never run -> today's
   *     slot if it is still ahead, else tomorrow's: turning a schedule on at
   *     10:00 for 08:30 does not fire at once.
   *   * both: whichever comes first.
   */
  function nextRun(recipe, lastRun, now) {
    var s = recipe && recipe.schedule;
    if (!s || s.enabled === false) return null;
    var last = Number(lastRun) > 0 ? Number(lastRun) : 0;
    var t = Number(now) || 0;
    var candidates = [];
    if (s.everyMinutes > 0) candidates.push(last ? last + s.everyMinutes * MINUTE : t);
    if (typeof s.dailyAt === 'string' && TIME_RE.test(s.dailyAt)) {
      candidates.push(last ? dailyAfter(s.dailyAt, last) : dailyAfter(s.dailyAt, t - 1));
    }
    if (!candidates.length) return null;
    return Math.min.apply(null, candidates);
  }

  function isDue(recipe, lastRun, now) {
    var next = nextRun(recipe, lastRun, now);
    return next != null && next <= now;
  }

  /** The recipes due now, given the runs map (id -> { at }). */
  function dueRecipes(recipes, runs, now) {
    var map = runs || {};
    return (Array.isArray(recipes) ? recipes : []).filter(function (r) {
      return isDue(r, map[r.id] && map[r.id].at, now);
    });
  }

  function lastRuns(given) {
    var map = readJson(RUNS_KEY, {}, given);
    return isPlainObject(map) ? map : {};
  }

  /** Record a run (or a baseline when a schedule is switched on): { at, ok, error?, chatId? }. */
  function recordRun(id, entry, given) {
    var map = lastRuns(given);
    map[id] = Object.assign({ at: Date.now(), ok: true }, entry || {});
    return writeJson(RUNS_KEY, map, given);
  }

  function scheduleLabel(recipe) {
    var s = recipe && recipe.schedule;
    if (!s) return 'not scheduled';
    var parts = [];
    if (s.everyMinutes) parts.push(s.everyMinutes % 60 === 0 ? 'every ' + (s.everyMinutes / 60) + ' h' : 'every ' + s.everyMinutes + ' min');
    if (s.dailyAt) parts.push('daily at ' + s.dailyAt);
    return parts.join(', ') + (s.enabled === false ? ' (off)' : '');
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** "<recipe> · 2026-09-22 08:30", local time: the title of a scheduled run's chat. */
  function runTitle(recipe, now) {
    var d = new Date(now);
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return ((recipe && recipe.name) || 'Recipe') + ' · ' + stamp;
  }

  // ---- consent for extensions ----------------------------------------------------------

  function consentKey(recipeId, server) {
    return String(recipeId || '') + '::' + slug(server);
  }

  function hasConsent(recipeId, server, given) {
    var map = readJson(CONSENT_KEY, {}, given);
    return !!(isPlainObject(map) && map[consentKey(recipeId, server)]);
  }

  function grantConsent(recipeId, servers, given) {
    var map = readJson(CONSENT_KEY, {}, given);
    var next = isPlainObject(map) ? map : {};
    (Array.isArray(servers) ? servers : [servers]).forEach(function (s) { next[consentKey(recipeId, s)] = Date.now(); });
    return writeJson(CONSENT_KEY, next, given);
  }

  /** The extensions the person has not yet agreed to for this recipe. */
  function needsConsent(recipe, given) {
    return ((recipe && recipe.extensions) || []).filter(function (s) { return !hasConsent(recipe.id, s, given); });
  }

  // ---- background runs ("Run now" and schedules) -----------------------------------
  //
  // Nobody is at the screen for these, so nothing may ask. A background run
  // gets only what runs without asking: the read-only built-ins (tools.js
  // needsApproval says '') and the tools of the recipe's own MCP servers the
  // person set to "always allow". A local server is started only when this
  // recipe already has consent for it. Anything else is refused inside the
  // run with a sentence the model can pass on -- never prompted.

  function mcpServerSlugOf(name) {
    var m = /^mcp__([a-z0-9_]+?)__/.exec(String(name || ''));
    return m ? m[1] : '';
  }

  function recipeServerSlugs(recipe) {
    return ((recipe && recipe.extensions) || []).map(slug);
  }

  /**
   * backgroundServers(recipe, servers, given) -> { start, ready, skipped, missing }
   *
   * servers: [{ name, stdio, running }] -- the registered MCP servers. Of the
   * recipe's extensions: `start` are local ones to start now (consent given,
   * not running), `ready` are usable as they are (remote, or already
   * running), `skipped` are local ones with no consent yet, `missing` are
   * names not registered at all.
   */
  function backgroundServers(recipe, servers, given) {
    var out = { start: [], ready: [], skipped: [], missing: [] };
    var rows = Array.isArray(servers) ? servers : [];
    ((recipe && recipe.extensions) || []).forEach(function (name) {
      var row = rows.find(function (s) { return s && slug(s.name) === slug(name); });
      if (!row) out.missing.push(name);
      else if (!row.stdio || row.running) out.ready.push(row.name);
      else if (hasConsent(recipe.id, name, given)) out.start.push(row.name);
      else out.skipped.push(row.name);
    });
    return out;
  }

  /**
   * backgroundRefusal(recipe, call) -> '' when a background run may make this
   * call, else the tool result handed back instead of running it.
   *
   *   call.name    the tool
   *   call.asks    tools.needsApproval(name): '' when it runs without asking
   *   call.usable  for an mcp__ tool: whether its server is ready (remote, or
   *                a local one already running / started with consent)
   */
  function backgroundRefusal(recipe, call) {
    var c = call || {};
    var name = String(c.name || '');
    var fromChat = recipe && recipe.id ? ' run this recipe from chat (/recipe ' + recipe.id + ')' : ' run this recipe from chat';
    if (name === 'spawn_agent') return 'Error: sub-agents do not run in a background recipe run;' + fromChat + ' to use them.';
    if (c.asks) return 'Error: ' + name + ' ' + c.asks + ', so it needs your approval;' + fromChat + ' to allow it.';
    var server = mcpServerSlugOf(name);
    if (server) {
      if (recipeServerSlugs(recipe).indexOf(server) < 0) {
        return 'Error: ' + name + ' belongs to an MCP server this recipe does not list, so a background run may not use it.';
      }
      if (!c.usable) {
        return 'Error: that MCP server is not running, and this recipe has no consent to start it;' + fromChat + ' once to agree.';
      }
    }
    return '';
  }

  /**
   * backgroundOffer(recipe, defs, asks, usableServers) -> the tool defs a
   * background run is offered: built-ins (never spawn_agent) and the tools of
   * the recipe's ready servers. Tools that ask are offered too (NEURA-036):
   * calling one pauses the run for an approval (backgroundGate) instead of
   * being refused. `asks(name)` is tools.needsApproval; usableServers are
   * server names.
   */
  function backgroundOffer(recipe, defs, asks, usableServers) {
    var usable = (Array.isArray(usableServers) ? usableServers : []).map(slug);
    return (Array.isArray(defs) ? defs : []).filter(function (d) {
      var name = d && d.function && d.function.name;
      if (!name) return false;
      var server = mcpServerSlugOf(name);
      return backgroundGate(recipe, { name: name, asks: asks(name), usable: !server || usable.indexOf(server) >= 0 }).action !== 'refuse';
    });
  }

  // ---- approvals for background runs (NEURA-036) ------------------------------------
  //
  // A call that would ask in chat no longer fails a scheduled run outright: the
  // run pauses, the person gets a notification and an approval card under
  // Library → Recipes (Allow once / Deny / Always for this recipe), and the run
  // resumes with the answer. Nobody answering within APPROVAL_TIMEOUT_MS is a
  // "no", with the same refusal text a background run always gave.

  var ALWAYS_KEY = 'freeai4u.recipes.always';
  var APPROVAL_TIMEOUT_MS = 30 * MINUTE;

  function alwaysKey(recipeId, tool) {
    return String(recipeId || '') + '\n' + String(tool || '');
  }

  /** Whether the person chose "Always for this recipe" for this tool. */
  function recipeAllows(recipeId, tool, given) {
    var map = readJson(ALWAYS_KEY, {}, given);
    return !!(isPlainObject(map) && map[alwaysKey(recipeId, tool)]);
  }

  function allowForRecipe(recipeId, tool, given) {
    if (!recipeId || !tool) return false;
    var map = readJson(ALWAYS_KEY, {}, given);
    var next = isPlainObject(map) ? map : {};
    next[alwaysKey(recipeId, tool)] = Date.now();
    return writeJson(ALWAYS_KEY, next, given);
  }

  /**
   * backgroundGate(recipe, call, given) -> { action, text }
   *
   *   'refuse'  never in a background run (spawn_agent, a server the recipe
   *             does not list or cannot start); `text` is the tool result.
   *   'ask'     would ask in chat and this recipe has no "always" for it:
   *             pause for an approval; `text` is the refusal on a timeout.
   *   'run'     runs as it is.
   */
  function backgroundGate(recipe, call, given) {
    var c = call || {};
    var structural = backgroundRefusal(recipe, { name: c.name, asks: '', usable: c.usable });
    if (structural) return { action: 'refuse', text: structural };
    if (!c.asks) return { action: 'run', text: '' };
    if (recipe && recipeAllows(recipe.id, c.name, given)) return { action: 'run', text: '' };
    return { action: 'ask', text: backgroundRefusal(recipe, c) };
  }

  /** The notification line: "Recipe <name> wants to <summary> — open NeuraOS to allow". */
  function approvalText(recipeName, summary) {
    var what = String(summary || 'use a tool').trim();
    if (what) what = what.charAt(0).toLowerCase() + what.slice(1);
    return 'Recipe ' + String(recipeName || 'untitled') + ' wants to ' + what + ' — open NeuraOS to allow';
  }

  /**
   * approvalQueue(options) -> the pending approvals of paused background runs.
   *
   *   request(item) -> Promise<'once'|'always'|'deny'|'timeout'>
   *       item: { recipeId, recipeName, tool, summary, asks }
   *   answer(id, decision) -> boolean   'always' also remembers the tool for
   *       the recipe (allowForRecipe) and settles its other pending asks.
   *   sweep(at) -> number               expires what is past its deadline
   *   pending() -> entries, oldest first
   *   subscribe(fn) -> unsubscribe      fn(pending()) on every change
   *
   * options: { now, timeoutMs, setTimer, clearTimer, storage } -- all optional,
   * so node:test drives the clock and the timers itself. setTimer: null turns
   * the timers off (sweep only).
   */
  function approvalQueue(options) {
    var o = options || {};
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : APPROVAL_TIMEOUT_MS;
    var setTimer = o.setTimer === null ? null : (o.setTimer || (typeof setTimeout === 'function' ? setTimeout : null));
    var clearTimer = o.clearTimer || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    var entries = [];
    var listeners = [];
    var seq = 0;

    function snapshot() {
      return entries.map(function (e) {
        return { id: e.id, recipeId: e.recipeId, recipeName: e.recipeName, tool: e.tool, summary: e.summary, asks: e.asks, at: e.at, expiresAt: e.expiresAt };
      });
    }

    function emit() {
      var rows = snapshot();
      listeners.slice().forEach(function (fn) {
        try { fn(rows); } catch { /* a broken listener must not stop the others */ }
      });
    }

    function settle(entry, decision) {
      var at = entries.indexOf(entry);
      if (at < 0) return false;
      entries.splice(at, 1);
      if (entry.timer != null) clearTimer(entry.timer);
      entry.resolve(decision);
      return true;
    }

    function sweep(at) {
      var when = at == null ? now() : Number(at);
      var due = entries.filter(function (e) { return e.expiresAt <= when; });
      due.forEach(function (e) { settle(e, 'timeout'); });
      if (due.length) emit();
      return due.length;
    }

    function request(item) {
      var i = item || {};
      var at = now();
      var entry = {
        id: 'ap' + (++seq) + '-' + at.toString(36),
        recipeId: String(i.recipeId || ''),
        recipeName: String(i.recipeName || i.recipeId || ''),
        tool: String(i.tool || ''),
        summary: String(i.summary || i.tool || ''),
        asks: String(i.asks || ''),
        at: at,
        expiresAt: at + timeoutMs,
        timer: null,
        resolve: null,
      };
      var promise = new Promise(function (resolve) { entry.resolve = resolve; });
      entries.push(entry);
      if (setTimer) {
        entry.timer = setTimer(function () { sweep(now()); }, timeoutMs);
        // Never keep node (or a test) alive for a half-hour timer.
        if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
      }
      emit();
      return promise;
    }

    function answer(id, decision) {
      if (decision !== 'once' && decision !== 'always' && decision !== 'deny') return false;
      var entry = entries.find(function (e) { return e.id === id; });
      if (!entry) return false;
      settle(entry, decision);
      if (decision === 'always') {
        allowForRecipe(entry.recipeId, entry.tool, o.storage);
        entries.filter(function (e) { return e.recipeId === entry.recipeId && e.tool === entry.tool; })
          .forEach(function (e) { settle(e, 'always'); });
      }
      emit();
      return true;
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    }

    return { request: request, answer: answer, sweep: sweep, pending: snapshot, subscribe: subscribe, timeoutMs: timeoutMs };
  }

  // The one queue the app uses: RecipesScreen's background runs add to it, the
  // sidebar badge and the Recipes screen's approval cards read it.
  var approvals = approvalQueue();

  /**
   * A recipe as an agent definition (agents.js shape), so chat runs both with
   * one runner: the recipe's servers are its tools, its schema its output.
   */
  function asAgent(recipe) {
    var agent = {
      id: recipe.id,
      name: recipe.name,
      description: '',
      systemPrompt: recipe.systemPrompt || 'Carry out the request.',
      toolNames: (recipe.extensions || []).map(function (s) { return s + '/*'; }),
      outputMode: recipe.responseSchema ? 'structured' : 'last_message',
      includeMessageHistory: false,
    };
    if (recipe.responseSchema) agent.outputSchema = recipe.responseSchema;
    if (recipe.model) agent.model = recipe.model;
    return agent;
  }

  function template() {
    return {
      id: 'daily-brief',
      name: 'Daily brief',
      systemPrompt: 'You write short, factual briefs.',
      prompt: 'Give me a five-line brief on {{topic}} for today.',
      params: [{ name: 'topic', label: 'Topic', default: 'open-source AI models' }],
      extensions: [],
    };
  }

  return {
    KEY: KEY,
    RUNS_KEY: RUNS_KEY,
    CONSENT_KEY: CONSENT_KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    FIELDS: FIELDS,
    validate: validate,
    list: list,
    get: get,
    save: save,
    remove: remove,
    parseImport: parseImport,
    exportJson: exportJson,
    placeholders: placeholders,
    fillTemplate: fillTemplate,
    parseCommand: parseCommand,
    nextRun: nextRun,
    isDue: isDue,
    dueRecipes: dueRecipes,
    lastRuns: lastRuns,
    recordRun: recordRun,
    scheduleLabel: scheduleLabel,
    runTitle: runTitle,
    hasConsent: hasConsent,
    grantConsent: grantConsent,
    needsConsent: needsConsent,
    backgroundServers: backgroundServers,
    backgroundRefusal: backgroundRefusal,
    backgroundOffer: backgroundOffer,
    backgroundGate: backgroundGate,
    ALWAYS_KEY: ALWAYS_KEY,
    APPROVAL_TIMEOUT_MS: APPROVAL_TIMEOUT_MS,
    recipeAllows: recipeAllows,
    allowForRecipe: allowForRecipe,
    approvalText: approvalText,
    approvalQueue: approvalQueue,
    approvals: approvals,
    asAgent: asAgent,
    template: template,
  };
});
