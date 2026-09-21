// Tools: what a model in Chat may ask for, and the rules around asking.
//
// The engine already does the work -- web search and fetch, the multi-account
// GitHub API, remote MCP servers (/api/mcp/*) -- and the shell already reads
// files and runs commands in the folder the person opened. What Chat lacked
// was the conversation: offering the tools, reading a model's tool calls out
// of a stream, asking before anything is changed, and handing results back.
// The rules are here (pure, node-tested); tool-run.ts executes, agent-turn.ts
// loops, ToolCards.tsx draws.
//
// ONE RULE ABOVE THE OTHERS, the app's standing one: every file write, every
// command and every commit waits for an explicit Allow. Reading is free.
// An MCP tool is somebody else's code with unknown effects, so it asks too --
// once, or "always for this server" if the person says so.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MCP_KEY = 'freeai4u.mcp_servers';
  var ON_KEY = 'freeai4u.tools_on';
  var ALWAYS_KEY = 'freeai4u.tools_always';
  var CHANGED_EVENT = 'freeai4u:tools-changed';
  /** How many times a turn may go round before it is stopped. */
  var MAX_ROUNDS = 8;
  /** A tool result handed back to the model is clipped to this. */
  var MAX_RESULT_CHARS = 12000;

  function fn(name, description, properties, required) {
    return {
      type: 'function',
      function: {
        name: name,
        description: description,
        parameters: { type: 'object', properties: properties || {}, required: required || [] },
      },
    };
  }

  var STR = { type: 'string' };
  var REPO = { type: 'string', description: 'owner/name' };
  var ACCOUNT = { type: 'string', description: 'GitHub login to act as, when more than one account is connected' };
  var BRANCH = { type: 'string', description: 'Branch name; the default branch when omitted' };

  var WEB = [
    fn('web_search', 'Search the web. Returns titles, URLs and snippets.', { query: STR }, ['query']),
    fn('web_fetch', 'Read one public web page as text.', { url: STR }, ['url']),
  ];

  var GITHUB = [
    fn('github_list_repos', 'List the repositories the connected GitHub accounts can see.', {}, []),
    fn('github_list_files', 'List a folder of a repository.', { repo: REPO, path: STR, branch: BRANCH, account: ACCOUNT }, ['repo']),
    fn('github_read_file', 'Read one file of a repository.', { repo: REPO, path: STR, branch: BRANCH, account: ACCOUNT }, ['repo', 'path']),
    fn('github_search_code', 'Search the code of one repository.', { repo: REPO, query: STR, account: ACCOUNT }, ['repo', 'query']),
    fn('github_list_commits', 'List recent commits, optionally for one path.', { repo: REPO, path: STR, account: ACCOUNT }, ['repo']),
    fn('github_list_branches', 'List the branches of a repository.', { repo: REPO, account: ACCOUNT }, ['repo']),
    fn('github_create_branch', 'Create a branch. Asks the user first.', { repo: REPO, branch: STR, from: BRANCH, account: ACCOUNT }, ['repo', 'branch']),
    fn('github_commit_file', 'Create or replace one file with a commit. Asks the user first.',
      { repo: REPO, path: STR, content: STR, message: STR, branch: BRANCH, account: ACCOUNT }, ['repo', 'path', 'content']),
    fn('github_delete_file', 'Delete one file with a commit. Asks the user first.',
      { repo: REPO, path: STR, message: STR, branch: BRANCH, account: ACCOUNT }, ['repo', 'path']),
  ];

  var LOCAL = [
    fn('list_files', 'List a folder inside the project folder the user opened.', { path: { type: 'string', description: 'Relative path; empty for the root' } }, []),
    fn('read_file', 'Read a text file inside the project folder.', { path: STR }, ['path']),
    fn('write_file', 'Create or overwrite a file inside the project folder. Asks the user first.', { path: STR, content: STR }, ['path', 'content']),
    fn('edit_file', 'Replace an exact piece of text in a file inside the project folder. Asks the user first.',
      { path: STR, old_text: STR, new_text: STR }, ['path', 'old_text', 'new_text']),
    fn('run_command', 'Run a shell command in the project folder. Asks the user first.', { command: STR, cwd: STR }, ['command']),
  ];

  // Everything that changes something. Reading never asks.
  var ASKS = {
    write_file: 'writes a file on this PC',
    edit_file: 'edits a file on this PC',
    run_command: 'runs a command on this PC',
    github_commit_file: 'commits to GitHub',
    github_delete_file: 'deletes a file on GitHub',
    github_create_branch: 'creates a branch on GitHub',
  };

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

  // ---- MCP servers ------------------------------------------------------------

  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  }

  function mcpServers(given) {
    var target = storage(given);
    if (!target) return [];
    try {
      var parsed = JSON.parse(target.getItem(MCP_KEY) || '[]');
      return (Array.isArray(parsed) ? parsed : []).filter(function (s) {
        return s && typeof s.name === 'string' && slug(s.name) && typeof s.url === 'string' && /^https:\/\//i.test(s.url);
      }).map(function (s) {
        return { name: s.name, url: s.url, tools: Array.isArray(s.tools) ? s.tools : [] };
      });
    } catch {
      return [];
    }
  }

  function saveMcpServers(list, given) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(MCP_KEY, JSON.stringify(Array.isArray(list) ? list : []));
      announce();
      return true;
    } catch {
      return false;
    }
  }

  /** Add or replace a server by name. https only: the engine refuses the rest. */
  function addMcpServer(name, url, tools, given) {
    var label = String(name || '').trim().slice(0, 40);
    var address = String(url || '').trim();
    if (!slug(label)) return { ok: false, reason: 'Give the server a short name.' };
    if (!/^https:\/\/[^\s]+$/i.test(address)) return { ok: false, reason: 'An MCP server address starts with https://' };
    var rest = mcpServers(given).filter(function (s) { return slug(s.name) !== slug(label); });
    rest.push({ name: label, url: address, tools: Array.isArray(tools) ? tools : [] });
    return { ok: saveMcpServers(rest, given), reason: '' };
  }

  function removeMcpServer(name, given) {
    var rows = mcpServers(given);
    var next = rows.filter(function (s) { return s.name !== name; });
    return next.length !== rows.length && saveMcpServers(next, given);
  }

  /** `mcp__<server>__<tool>`: a name a model can call and this app can route. */
  function mcpToolName(server, tool) {
    return 'mcp__' + slug(server) + '__' + String(tool || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  }

  /** The server and tool behind an mcp__ name, or null. */
  function mcpTarget(name, given) {
    var m = /^mcp__([a-z0-9_]+?)__(.+)$/.exec(String(name || ''));
    if (!m) return null;
    var servers = mcpServers(given);
    for (var i = 0; i < servers.length; i += 1) {
      if (slug(servers[i].name) !== m[1]) continue;
      var tools = servers[i].tools || [];
      for (var j = 0; j < tools.length; j += 1) {
        if (mcpToolName(servers[i].name, tools[j].name) === name) {
          return { server: servers[i], tool: tools[j].name };
        }
      }
    }
    return null;
  }

  function mcpDefs(given) {
    var out = [];
    mcpServers(given).forEach(function (server) {
      (server.tools || []).forEach(function (tool) {
        if (!tool || !tool.name) return;
        var schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
        out.push({
          type: 'function',
          function: {
            name: mcpToolName(server.name, tool.name),
            description: ('[' + server.name + '] ' + String(tool.description || tool.name)).slice(0, 500),
            parameters: schema,
          },
        });
      });
    });
    return out;
  }

  // ---- what is offered ----------------------------------------------------------

  /**
   * catalogue({ github, localRoot, shell })
   *
   * The tools to offer this turn. Web tools always; GitHub only with an
   * account connected; the local ones only when a folder is open AND there is
   * a shell to reach it; MCP tools for every registered server.
   */
  function catalogue(context, given) {
    var ctx = context || {};
    var out = WEB.slice();
    if (ctx.github) out = out.concat(GITHUB);
    if (ctx.localRoot && ctx.shell) out = out.concat(LOCAL);
    return out.concat(mcpDefs(given));
  }

  function enabled(given) {
    var target = storage(given);
    if (!target) return true;
    try {
      return target.getItem(ON_KEY) !== '0';
    } catch {
      return true;
    }
  }

  function setEnabled(on, given) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(ON_KEY, on ? '1' : '0');
      announce();
      return true;
    } catch {
      return false;
    }
  }

  // ---- asking first ---------------------------------------------------------------

  function alwaysMap(given) {
    var target = storage(given);
    if (!target) return {};
    try {
      var parsed = JSON.parse(target.getItem(ALWAYS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** The key "always allow" is remembered under, or '' when it never may be. */
  function alwaysKey(name) {
    var m = /^mcp__([a-z0-9_]+?)__/.exec(String(name || ''));
    // Only an MCP server can be trusted wholesale. Writes, commands and
    // commits ask every time -- that is the rule, not a default.
    return m ? 'mcp:' + m[1] : '';
  }

  function setAlways(name, given) {
    var key = alwaysKey(name);
    var target = storage(given);
    if (!key || !target) return false;
    var map = alwaysMap(given);
    map[key] = true;
    try {
      target.setItem(ALWAYS_KEY, JSON.stringify(map));
      return true;
    } catch {
      return false;
    }
  }

  /** '' when the call may simply run; otherwise the reason it asks. */
  function needsApproval(name, given) {
    var n = String(name || '');
    if (ASKS[n]) return ASKS[n];
    if (/^mcp__/.test(n)) {
      return alwaysMap(given)[alwaysKey(n)] ? '' : 'calls a tool on an MCP server you added';
    }
    return '';
  }

  // ---- reading tool calls out of a stream -----------------------------------------

  /**
   * collect(state, deltas) -> state
   *
   * OpenAI-shaped streams send a tool call in pieces: the first delta for an
   * index carries the id and the name, later ones append to `arguments`.
   * Ollama sends whole calls with object arguments. Both end up as
   * [{ id, name, arguments: '<json text>' }].
   */
  function collect(state, deltas) {
    var calls = Array.isArray(state) ? state : [];
    (Array.isArray(deltas) ? deltas : []).forEach(function (d, position) {
      if (!d) return;
      var index = typeof d.index === 'number' ? d.index : (d.id ? -1 : position);
      var slot = null;
      if (index >= 0) slot = calls[index] || (calls[index] = { id: '', name: '', arguments: '' });
      else {
        slot = { id: '', name: '', arguments: '' };
        calls.push(slot);
      }
      var f = d.function || {};
      if (d.id) slot.id = String(d.id);
      if (f.name) slot.name = String(f.name);
      if (typeof f.arguments === 'string') slot.arguments += f.arguments;
      else if (f.arguments && typeof f.arguments === 'object') slot.arguments = JSON.stringify(f.arguments);
    });
    return calls;
  }

  /** The finished calls: named, with an id (one is made up when none came). */
  function finish(state) {
    return (Array.isArray(state) ? state : [])
      .filter(function (c) { return c && c.name; })
      .map(function (c, i) {
        return { id: c.id || 'call_' + i + '_' + Math.random().toString(36).slice(2, 8), name: c.name, arguments: c.arguments || '{}' };
      });
  }

  function parseArgs(text) {
    if (text && typeof text === 'object') return text;
    try {
      var parsed = JSON.parse(String(text || '{}'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** The assistant message that asked, in the shape the next request needs. */
  function assistantMessage(text, calls) {
    return {
      role: 'assistant',
      content: text || '',
      tool_calls: calls.map(function (c) {
        return { id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } };
      }),
    };
  }

  function clip(text) {
    var s = String(text == null ? '' : text);
    if (s.length <= MAX_RESULT_CHARS) return s;
    return s.slice(0, MAX_RESULT_CHARS) + '\n[... ' + (s.length - MAX_RESULT_CHARS) + ' more characters not shown]';
  }

  function toolMessage(call, result) {
    return { role: 'tool', tool_call_id: call.id, name: call.name, content: clip(result) };
  }

  /** One line for the card: what is being asked, in words. */
  function summarise(name, args) {
    var a = args || {};
    var n = String(name || '');
    if (n === 'web_search') return 'Search the web for “' + (a.query || '') + '”';
    if (n === 'web_fetch') return 'Read ' + (a.url || 'a page');
    if (n === 'list_files') return 'List ' + (a.path || 'the project folder');
    if (n === 'read_file') return 'Read ' + (a.path || 'a file');
    if (n === 'write_file') return 'Write ' + (a.path || 'a file') + ' (' + String(a.content || '').length + ' characters)';
    if (n === 'edit_file') return 'Edit ' + (a.path || 'a file');
    if (n === 'run_command') return 'Run: ' + (a.command || '');
    if (n === 'github_commit_file') return 'Commit ' + (a.path || 'a file') + ' to ' + (a.repo || 'a repository') + (a.branch ? ' (' + a.branch + ')' : '');
    if (n === 'github_delete_file') return 'Delete ' + (a.path || 'a file') + ' from ' + (a.repo || 'a repository');
    if (n === 'github_create_branch') return 'Create branch ' + (a.branch || '') + ' in ' + (a.repo || 'a repository');
    if (/^github_/.test(n)) return n.replace(/^github_/, 'GitHub: ').replace(/_/g, ' ') + (a.repo ? ' · ' + a.repo : '');
    var m = /^mcp__([a-z0-9_]+?)__(.+)$/.exec(n);
    if (m) return m[1] + ': ' + m[2];
    return n;
  }

  /** Whether a provider's refusal is about tools, so the turn can go on without. */
  function isToolsRefusal(message) {
    return /tool|function.?call|does not support|unsupported|not supported|unknown (field|parameter)|extra inputs/i.test(String(message || ''));
  }

  return {
    MCP_KEY: MCP_KEY,
    ON_KEY: ON_KEY,
    ALWAYS_KEY: ALWAYS_KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    MAX_ROUNDS: MAX_ROUNDS,
    MAX_RESULT_CHARS: MAX_RESULT_CHARS,
    WEB: WEB,
    GITHUB: GITHUB,
    LOCAL: LOCAL,
    ASKS: ASKS,
    slug: slug,
    mcpServers: mcpServers,
    saveMcpServers: saveMcpServers,
    addMcpServer: addMcpServer,
    removeMcpServer: removeMcpServer,
    mcpToolName: mcpToolName,
    mcpTarget: mcpTarget,
    mcpDefs: mcpDefs,
    catalogue: catalogue,
    enabled: enabled,
    setEnabled: setEnabled,
    alwaysKey: alwaysKey,
    setAlways: setAlways,
    needsApproval: needsApproval,
    collect: collect,
    finish: finish,
    parseArgs: parseArgs,
    assistantMessage: assistantMessage,
    toolMessage: toolMessage,
    clip: clip,
    summarise: summarise,
    isToolsRefusal: isToolsRefusal,
  };
});
