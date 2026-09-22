// Agents (roadmap 6.7): declarative sub-agents a chat can run or delegate to.
//
// An agent is DATA, never code: a name, a system prompt, the tools it may be
// offered, an optional model, and how its answer comes back. That is the whole
// point of the format -- a definition can be imported from anyone, so nothing
// in it may run. A field that would carry code (`handleSteps`, `code`, a
// function value) is refused with a reason rather than silently dropped, so a
// publisher who expected it to run hears why it will not.
//
//   * toolNames are built-in tool names (`read_file`, `web_search`) or MCP
//     tools as `server/tool` -- `server/*` for all of a server's tools -- which
//     map to the `mcp__<server>__<tool>` names tools.js offers;
//   * outputMode 'last_message' hands back the agent's final reply as text;
//     'structured' asks for JSON and checks it against outputSchema's required
//     keys and basic types;
//   * the stored list lives under freeai4u.agents; three built-ins ship with
//     the app and a stored agent with the same id replaces one.
//
// Pure (node-tested). ChatScreen runs agents, AgentsScreen edits them.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UAgents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var KEY = 'freeai4u.agents';
  var CHANGED_EVENT = 'freeai4u:agents-changed';
  /** A spawned agent may spawn once more; deeper than that is refused. */
  var MAX_DEPTH = 2;
  var OUTPUT_MODES = ['last_message', 'structured'];
  var FIELDS = ['id', 'name', 'description', 'model', 'systemPrompt', 'toolNames', 'spawnableAgents',
    'outputMode', 'outputSchema', 'includeMessageHistory', 'spawnerPrompt'];
  // Names other agent formats use for steps written in code. Refused outright:
  // a definition from an untrusted publisher must never run anything.
  var CODE_FIELDS = ['handlesteps', 'handle_steps', 'code', 'script', 'scripts', 'source', 'function', 'functions',
    'fn', 'eval', 'exec', 'handler', 'handlers', 'js', 'javascript', 'onstep', 'hooks'];

  var CREDENTIALS_RULE = 'Never ask for, type, read aloud or repeat passwords, card numbers, one-time codes or other '
    + 'credentials. When a page needs one, stop and tell the user to type it into the browser themselves; it must never '
    + 'be sent to you or appear in a tool call.';

  var BUILTINS = [
    {
      id: 'file-picker',
      name: 'File picker',
      description: 'Finds the files in the open folder that matter for a task and returns their paths. Cheap and local models do this well.',
      systemPrompt: 'You find files. Use list_files to walk the open folder and read_file to confirm a candidate when its name '
        + 'is not enough. Look at no more than about fifteen files. Do not change anything. Reply with JSON only: '
        + '{"paths": ["relative/path", ...], "reason": "one sentence"} -- the most relevant first, at most ten.',
      toolNames: ['list_files', 'read_file'],
      outputMode: 'structured',
      outputSchema: {
        type: 'object',
        required: ['paths'],
        properties: { paths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
      },
      includeMessageHistory: false,
      spawnerPrompt: 'Give it a task description; it returns the relevant file paths in the open folder.',
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Reads a diff or files and returns findings: bugs first, then risks, then nits.',
      systemPrompt: 'You review code. Read what the task points at (a file path, a pasted diff, or files you list), and '
        + 'change nothing. Reply with a short Markdown list of findings, most serious first. Each finding: severity '
        + '(bug, risk or nit), the file and line when known, what is wrong, and the fix in one sentence. If nothing is '
        + 'wrong, say so in one line.',
      toolNames: ['list_files', 'read_file', 'github_read_file'],
      outputMode: 'last_message',
      includeMessageHistory: true,
      spawnerPrompt: 'Give it a path, a diff or a description of the change; it returns review findings.',
    },
    {
      id: 'browser',
      name: 'Browser',
      description: 'Drives a real Chrome through the Chrome DevTools MCP server: open pages, click, read, screenshot. Add the "browser" preset in Settings -> Connectors first.',
      systemPrompt: 'You operate a Chrome browser through the browser tools (Chrome DevTools MCP). Open the page the task '
        + 'names, take a snapshot before you act, act in small steps, and re-read the page after each step. Report what '
        + 'you found or did, with the final URL. ' + CREDENTIALS_RULE + ' Do not submit forms, buy anything or post '
        + 'anything unless the task says so explicitly.',
      toolNames: ['browser/*'],
      outputMode: 'last_message',
      includeMessageHistory: false,
      spawnerPrompt: 'Give it a URL and what to find or do there. It will not handle passwords.',
    },
  ];

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

  /** The first function value anywhere inside, as a dotted path, or ''. */
  function functionPath(value, at, depth) {
    if (typeof value === 'function') return at || '(root)';
    if ((depth || 0) > 12 || !value || typeof value !== 'object') return '';
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i += 1) {
      var hit = functionPath(value[keys[i]], at ? at + '.' + keys[i] : keys[i], (depth || 0) + 1);
      if (hit) return hit;
    }
    return '';
  }

  /** Why a raw definition carries code, or ''. Shared with recipes.js by copy. */
  function codeReason(raw) {
    if (!isPlainObject(raw)) return '';
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i += 1) {
      if (CODE_FIELDS.indexOf(keys[i].toLowerCase()) >= 0) {
        return '"' + keys[i] + '" carries code, and definitions never run code -- they may come from anyone. Remove it; '
          + 'describe the steps in systemPrompt instead.';
      }
    }
    var fnAt = functionPath(raw, '', 0);
    if (fnAt) return '"' + fnAt + '" is a function. Definitions are JSON data only.';
    return '';
  }

  // Same rule as tools.js slug(): the part of an mcp__ name a server becomes.
  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  }

  /** `server/tool` -> `mcp__server__tool` (tools.js mcpToolName); a built-in name is returned as is. */
  function toolName(entry) {
    var s = String(entry || '').trim();
    var at = s.indexOf('/');
    if (at < 0) return s;
    var tool = s.slice(at + 1);
    return 'mcp__' + slug(s.slice(0, at)) + '__' + (tool === '*' ? '*' : tool.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40));
  }

  /** Whether a tool the app offers (by its def name) is one of an agent's toolNames. */
  function allowsTool(toolNames, defName) {
    var name = String(defName || '');
    return (Array.isArray(toolNames) ? toolNames : []).some(function (entry) {
      var mapped = toolName(entry);
      if (mapped.slice(-3) === '__*') return name.indexOf(mapped.slice(0, -1)) === 0;
      return mapped === name;
    });
  }

  /** The defs an agent is offered: only its own toolNames, never spawn_agent (added by the runner). */
  function pickTools(agent, defs) {
    var names = agent && agent.toolNames;
    return (Array.isArray(defs) ? defs : []).filter(function (d) {
      var n = d && d.function && d.function.name;
      return n && n !== 'spawn_agent' && allowsTool(names, n);
    });
  }

  var ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  var BUILTIN_TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
  var MCP_TOOL_RE = /^[^\s/]{1,40}\/(\*|[^\s/]{1,64})$/;

  function str(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  /**
   * validate(raw) -> { ok, errors, warnings, agent }
   *
   * Strict: required fields must be right, unknown keys are dropped (and named
   * in warnings), and a code-carrying field fails the whole definition.
   */
  function validate(raw) {
    var errors = [];
    var warnings = [];
    if (!isPlainObject(raw)) return { ok: false, errors: ['An agent is a JSON object.'], warnings: warnings, agent: null };
    var code = codeReason(raw);
    if (code) return { ok: false, errors: [code], warnings: warnings, agent: null };
    Object.keys(raw).forEach(function (k) {
      if (FIELDS.indexOf(k) < 0) warnings.push('Unknown field "' + k + '" was dropped.');
    });
    var agent = {
      id: str(raw.id, 40),
      name: str(raw.name, 60),
      description: str(raw.description, 400),
      systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt.trim().slice(0, 20000) : '',
      toolNames: [],
      outputMode: raw.outputMode == null ? 'last_message' : raw.outputMode,
      includeMessageHistory: raw.includeMessageHistory === true,
    };
    if (!ID_RE.test(agent.id)) errors.push('id: lowercase letters, digits, - or _, up to 40 characters.');
    if (!agent.name) errors.push('name is required.');
    if (!agent.systemPrompt) errors.push('systemPrompt is required.');
    if (raw.includeMessageHistory != null && typeof raw.includeMessageHistory !== 'boolean') errors.push('includeMessageHistory is true or false.');
    if (raw.model != null) {
      if (!isPlainObject(raw.model) || !str(raw.model.provider, 80) || !str(raw.model.model, 200)) {
        errors.push('model is { "provider": "...", "model": "..." }, or leave it out to use the chat\'s model.');
      } else {
        agent.model = { provider: str(raw.model.provider, 80), model: str(raw.model.model, 200) };
      }
    }
    if (raw.toolNames != null && !Array.isArray(raw.toolNames)) errors.push('toolNames is a list of tool names.');
    (Array.isArray(raw.toolNames) ? raw.toolNames : []).slice(0, 64).forEach(function (t) {
      var name = typeof t === 'string' ? t.trim() : '';
      if (BUILTIN_TOOL_RE.test(name) || MCP_TOOL_RE.test(name)) {
        if (agent.toolNames.indexOf(name) < 0) agent.toolNames.push(name);
      } else {
        errors.push('toolNames: "' + String(t) + '" is neither a built-in tool name nor server/tool.');
      }
    });
    if (raw.spawnableAgents != null) {
      if (!Array.isArray(raw.spawnableAgents)) errors.push('spawnableAgents is a list of agent ids.');
      else {
        agent.spawnableAgents = [];
        raw.spawnableAgents.slice(0, 32).forEach(function (id) {
          if (typeof id === 'string' && ID_RE.test(id.trim())) agent.spawnableAgents.push(id.trim());
          else errors.push('spawnableAgents: "' + String(id) + '" is not an agent id.');
        });
      }
    }
    if (OUTPUT_MODES.indexOf(agent.outputMode) < 0) {
      errors.push('outputMode is "last_message" or "structured".');
    }
    if (raw.outputSchema != null) {
      if (!isPlainObject(raw.outputSchema)) errors.push('outputSchema is a JSON schema object.');
      else agent.outputSchema = JSON.parse(JSON.stringify(raw.outputSchema));
    }
    if (agent.outputMode === 'structured' && !agent.outputSchema) errors.push('structured output needs an outputSchema.');
    var spawner = str(raw.spawnerPrompt, 1000);
    if (spawner) agent.spawnerPrompt = spawner;
    return { ok: errors.length === 0, errors: errors, warnings: warnings, agent: errors.length ? null : agent };
  }

  // ---- storage ----------------------------------------------------------------

  function stored(given) {
    var target = storage(given);
    if (!target) return [];
    try {
      var parsed = JSON.parse(target.getItem(KEY) || '[]');
      var out = [];
      (Array.isArray(parsed) ? parsed : []).forEach(function (raw) {
        var checked = validate(raw);
        if (checked.ok) out.push(checked.agent);
      });
      return out;
    } catch {
      return [];
    }
  }

  function writeStored(list, given) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(KEY, JSON.stringify(list));
      announce();
      return true;
    } catch {
      return false;
    }
  }

  function isBuiltin(id) {
    return BUILTINS.some(function (b) { return b.id === id; });
  }

  /** Every agent: the built-ins (or a stored replacement), then the person's own. */
  function list(given) {
    var mine = stored(given);
    var out = BUILTINS.map(function (b) {
      var own = mine.find(function (a) { return a.id === b.id; });
      return own || validate(b).agent;
    });
    mine.forEach(function (a) { if (!isBuiltin(a.id)) out.push(a); });
    return out;
  }

  function get(id, given) {
    var wanted = String(id || '').trim().toLowerCase();
    return list(given).find(function (a) { return a.id === wanted; }) || null;
  }

  /** Save (add or replace by id) after validation: { ok, errors, warnings, agent }. */
  function save(raw, given) {
    var checked = validate(raw);
    if (!checked.ok) return checked;
    var rest = stored(given).filter(function (a) { return a.id !== checked.agent.id; });
    rest.push(checked.agent);
    if (!writeStored(rest, given)) return { ok: false, errors: ['Storage refused the write.'], warnings: checked.warnings, agent: null };
    return checked;
  }

  /** Delete one of the person's agents; for a built-in this restores the shipped one. */
  function remove(id, given) {
    var rows = stored(given);
    var next = rows.filter(function (a) { return a.id !== id; });
    return next.length !== rows.length && writeStored(next, given);
  }

  /** Whether a built-in has been replaced by a stored copy. */
  function isOverridden(id, given) {
    return isBuiltin(id) && stored(given).some(function (a) { return a.id === id; });
  }

  // ---- import / export --------------------------------------------------------

  /** A pasted or loaded file: one agent, a list, or { agents: [...] }. Nothing is saved. */
  function parseImport(text) {
    var parsed;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch {
      return { agents: [], errors: ['That is not valid JSON.'] };
    }
    var rows = Array.isArray(parsed) ? parsed : (isPlainObject(parsed) && Array.isArray(parsed.agents) ? parsed.agents : [parsed]);
    var agents = [];
    var errors = [];
    rows.forEach(function (raw, i) {
      var checked = validate(raw);
      var label = (raw && typeof raw.id === 'string' && raw.id) || '#' + (i + 1);
      if (checked.ok) agents.push(checked.agent);
      else errors.push(label + ': ' + checked.errors.join(' '));
    });
    return { agents: agents, errors: errors };
  }

  function exportJson(agents) {
    return JSON.stringify({ agents: Array.isArray(agents) ? agents : [] }, null, 2);
  }

  // ---- running ------------------------------------------------------------------

  /** '/agent file-picker find the router' arg -> { id, task }. */
  function parseCommand(arg) {
    var m = /^\s*(\S+)\s*([\s\S]*)$/.exec(String(arg || ''));
    if (!m) return { id: '', task: '' };
    return { id: m[1].toLowerCase(), task: m[2].trim() };
  }

  function schemaHint(schema) {
    return 'Reply with ONE JSON object and nothing else -- no prose, no code fence. It must match this JSON schema:\n'
      + JSON.stringify(schema, null, 2);
  }

  /** The messages a sub-turn starts from. `history` is the chat's turns, used only when the agent asks for them. */
  function messagesFor(agent, task, history) {
    var system = agent.systemPrompt;
    if (agent.outputMode === 'structured' && agent.outputSchema) system += '\n\n' + schemaHint(agent.outputSchema);
    var out = [{ role: 'system', content: system }];
    if (agent.includeMessageHistory && Array.isArray(history)) {
      history.forEach(function (m) {
        if (m && (m.role === 'user' || m.role === 'assistant') && m.content) out.push({ role: m.role, content: m.content });
      });
    }
    out.push({ role: 'user', content: String(task || '').trim() || 'Do your job on what is in front of you.' });
    return out;
  }

  /** The agents a spawner may start: its spawnableAgents, or every agent when there is no spawner. */
  function spawnTargets(spawner, all) {
    var ids = (Array.isArray(all) ? all : []).map(function (a) { return a.id; });
    if (!spawner) return ids;
    return (spawner.spawnableAgents || []).filter(function (id) { return ids.indexOf(id) >= 0 && id !== spawner.id; });
  }

  /** The description the spawn_agent tool is offered with: which agents, and what to hand each. */
  function spawnDescription(agents) {
    var lines = (Array.isArray(agents) ? agents : []).map(function (a) {
      return '- ' + a.id + ': ' + (a.spawnerPrompt || a.description || a.name);
    });
    return ('Delegate a task to a sub-agent and get its answer back. Available agents:\n' + lines.join('\n')).slice(0, 1500);
  }

  function typeOk(value, type) {
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return typeof value === 'number' && Math.floor(value) === value;
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return isPlainObject(value);
    if (type === 'null') return value === null;
    return true;
  }

  /** The first JSON object or array in a reply: fenced, bare, or with prose around it. */
  function extractJson(text) {
    var s = String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
    var fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    try { return { ok: true, value: JSON.parse(s) }; } catch { /* look for the object inside */ }
    var start = s.search(/[{[]/);
    var end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try { return { ok: true, value: JSON.parse(s.slice(start, end + 1)) }; } catch { /* not JSON */ }
    }
    return { ok: false, value: null };
  }

  /**
   * checkStructured(text, schema) -> { ok, value, errors }
   *
   * Basic, on purpose: the top-level type, required keys, and the declared type
   * of each property present. Enough to catch a model that ignored the format.
   */
  function checkStructured(text, schema) {
    var found = extractJson(text);
    if (!found.ok) return { ok: false, value: null, errors: ['The reply was not JSON.'] };
    var value = found.value;
    var errors = [];
    var s = isPlainObject(schema) ? schema : {};
    var types = Array.isArray(s.type) ? s.type : (s.type ? [s.type] : []);
    if (types.length && !types.some(function (t) { return typeOk(value, t); })) errors.push('Expected ' + types.join(' or ') + ' at the top.');
    if (isPlainObject(value)) {
      (Array.isArray(s.required) ? s.required : []).forEach(function (k) {
        if (!(k in value)) errors.push('Missing required key "' + k + '".');
      });
      var props = isPlainObject(s.properties) ? s.properties : {};
      Object.keys(props).forEach(function (k) {
        if (!(k in value) || !isPlainObject(props[k]) || !props[k].type) return;
        var want = Array.isArray(props[k].type) ? props[k].type : [props[k].type];
        if (!want.some(function (t) { return typeOk(value[k], t); })) errors.push('"' + k + '" should be ' + want.join(' or ') + '.');
      });
    }
    return { ok: errors.length === 0, value: value, errors: errors };
  }

  /**
   * The agent's answer as it goes into the chat (and back to a spawner):
   * { text, ok, errors }. Structured output is pretty-printed JSON, with what
   * did not match the schema said underneath.
   */
  function formatResult(agent, lastMessage) {
    var raw = String(lastMessage || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
    if (!agent || agent.outputMode !== 'structured') return { text: raw || '(the agent gave no answer)', ok: !!raw, errors: [] };
    var checked = checkStructured(raw, agent.outputSchema);
    if (checked.value == null) {
      return { text: raw + '\n\n_Expected JSON matching the schema; this is not JSON._', ok: false, errors: checked.errors };
    }
    var body = '```json\n' + JSON.stringify(checked.value, null, 2) + '\n```';
    if (!checked.ok) body += '\n\n_Does not match the schema: ' + checked.errors.join(' ') + '_';
    return { text: body, ok: checked.ok, errors: checked.errors };
  }

  /** A new definition to start editing from. */
  function template() {
    return {
      id: 'my-agent',
      name: 'My agent',
      description: 'What it is for, in one line.',
      systemPrompt: 'You are ... Do ... Reply with ...',
      toolNames: ['web_search', 'web_fetch'],
      outputMode: 'last_message',
      includeMessageHistory: false,
    };
  }

  return {
    KEY: KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    MAX_DEPTH: MAX_DEPTH,
    OUTPUT_MODES: OUTPUT_MODES,
    FIELDS: FIELDS,
    CODE_FIELDS: CODE_FIELDS,
    CREDENTIALS_RULE: CREDENTIALS_RULE,
    BUILTINS: BUILTINS,
    codeReason: codeReason,
    validate: validate,
    toolName: toolName,
    allowsTool: allowsTool,
    pickTools: pickTools,
    list: list,
    get: get,
    save: save,
    remove: remove,
    isBuiltin: isBuiltin,
    isOverridden: isOverridden,
    parseImport: parseImport,
    exportJson: exportJson,
    parseCommand: parseCommand,
    messagesFor: messagesFor,
    spawnTargets: spawnTargets,
    spawnDescription: spawnDescription,
    extractJson: extractJson,
    checkStructured: checkStructured,
    formatResult: formatResult,
    template: template,
  };
});
