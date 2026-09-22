// Tools: what a model in Chat may ask for, and the rules around asking.
//
// The engine already does the work -- web search and fetch, the multi-account
// GitHub API, remote MCP servers (/api/mcp/*) -- and the shell already reads
// files and runs commands in the folder the person opened, and hosts local
// (stdio) MCP servers (mcp.rs). What Chat lacked
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

  // Delegation to a sub-agent (agents.js). Not in the catalogue: Chat offers it
  // with the list of agents in its description. The agent's own tools still
  // ask one by one; this asks before the agent starts at all.
  var SPAWN_AGENT = fn('spawn_agent', 'Delegate a task to a named sub-agent and get its answer back. Asks the user first.',
    { agent: { type: 'string', description: 'The agent id' }, task: { type: 'string', description: 'What the agent should do, with everything it needs to know' } },
    ['agent', 'task']);
  var SPAWN_REASON = 'starts a sub-agent that can use its own tools';

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

  function isStdio(server) {
    return !!server && server.transport === 'stdio';
  }

  function cleanArgs(list) {
    return (Array.isArray(list) ? list : []).filter(function (a) {
      return typeof a === 'string' || typeof a === 'number';
    }).map(String).slice(0, 64);
  }

  function cleanEnv(map) {
    var out = {};
    if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
    Object.keys(map).forEach(function (key) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && map[key] != null && typeof map[key] !== 'object') out[key] = String(map[key]);
    });
    return out;
  }

  /**
   * A local (stdio) server row, checked and normalised: { ok, reason, server }.
   * The shell spawns `command` directly with `args` -- no shell -- so a command
   * is one program, not a command line.
   */
  function validateStdioServer(row) {
    var r = row || {};
    var label = String(r.name || '').trim().slice(0, 40);
    var command = String(r.command || '').trim();
    if (!slug(label)) return { ok: false, reason: 'Give the server a short name.', server: null };
    if (!command) return { ok: false, reason: 'A local MCP server needs a command, such as npx or uvx.', server: null };
    if (/[\0\r\n]/.test(command)) return { ok: false, reason: 'A command is one line.', server: null };
    var server = {
      name: label,
      transport: 'stdio',
      command: command,
      args: cleanArgs(r.args),
      env: cleanEnv(r.env),
      tools: Array.isArray(r.tools) ? r.tools : [],
    };
    var cwd = typeof r.cwd === 'string' ? r.cwd.trim() : '';
    if (cwd) server.cwd = cwd;
    return { ok: true, reason: '', server: server };
  }

  function mcpServers(given) {
    var target = storage(given);
    if (!target) return [];
    try {
      var parsed = JSON.parse(target.getItem(MCP_KEY) || '[]');
      var out = [];
      (Array.isArray(parsed) ? parsed : []).forEach(function (s) {
        if (!s || typeof s.name !== 'string' || !slug(s.name)) return;
        if (isStdio(s)) {
          var checked = validateStdioServer(s);
          if (checked.ok) out.push(checked.server);
          return;
        }
        if (typeof s.url === 'string' && /^https:\/\//i.test(s.url)) {
          out.push({ name: s.name, url: s.url, tools: Array.isArray(s.tools) ? s.tools : [] });
        }
      });
      return out;
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

  /** Add or replace a local (stdio) server by name. */
  function addStdioServer(row, given) {
    var checked = validateStdioServer(row);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    var rest = mcpServers(given).filter(function (s) { return slug(s.name) !== slug(checked.server.name); });
    rest.push(checked.server);
    return { ok: saveMcpServers(rest, given), reason: '' };
  }

  /** Cache a server's tool list on its row (either transport). */
  function setMcpTools(name, list, given) {
    var rows = mcpServers(given);
    var found = false;
    rows.forEach(function (s) {
      if (slug(s.name) === slug(name)) {
        s.tools = Array.isArray(list) ? list : [];
        found = true;
      }
    });
    return found && saveMcpServers(rows, given);
  }

  function removeMcpServer(name, given) {
    var rows = mcpServers(given);
    var next = rows.filter(function (s) { return s.name !== name; });
    return next.length !== rows.length && saveMcpServers(next, given);
  }

  /**
   * One line of arguments, split the way a terminal would: on spaces, with
   * "double" or 'single' quotes keeping a space inside one argument, and a
   * backslash escaping a quote inside double quotes. Backslashes elsewhere are
   * kept (Windows paths).
   */
  function splitArgs(line) {
    var text = String(line == null ? '' : line);
    var out = [];
    var current = '';
    var started = false;
    var quote = '';
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === quote) quote = '';
        else if (quote === '"' && ch === '\\' && text[i + 1] === '"') { current += '"'; i += 1; }
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        started = true;
      } else if (/\s/.test(ch)) {
        if (started) { out.push(current); current = ''; started = false; }
      } else {
        current += ch;
        started = true;
      }
    }
    if (started) out.push(current);
    return out;
  }

  /** An argument list back as one line, quoting what needs it. */
  function joinArgs(list) {
    return (Array.isArray(list) ? list : []).map(function (a) {
      var s = String(a);
      return s === '' || /[\s"']/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
    }).join(' ');
  }

  /** KEY=VALUE lines to an env map; blank lines and # comments are skipped. */
  function parseEnvLines(text) {
    var env = {};
    var bad = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line || line[0] === '#') return;
      var at = line.indexOf('=');
      var key = at > 0 ? line.slice(0, at).trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { bad.push(line.slice(0, 40)); return; }
      env[key] = line.slice(at + 1);
    });
    return { env: env, bad: bad };
  }

  /**
   * A pasted Claude-Desktop-style config -- {"mcpServers": {"x": {"command",
   * "args", "env", "cwd"}}}, or the inner map by itself -- as server rows.
   * An entry with a `url` is a remote server (https only, as everywhere else).
   * Returns { servers, errors }; nothing is saved.
   */
  function parseMcpConfig(text) {
    var parsed;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch {
      return { servers: [], errors: ['That is not valid JSON.'] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { servers: [], errors: ['Expected an object such as {"mcpServers": {...}}.'] };
    }
    var map = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed;
    var servers = [];
    var errors = [];
    Object.keys(map).forEach(function (name) {
      var entry = map[name];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(name + ': not a server entry.');
        return;
      }
      if (typeof entry.url === 'string' && !entry.command) {
        var address = entry.url.trim();
        if (!slug(name)) errors.push(name + ': give the server a short name.');
        else if (!/^https:\/\/[^\s]+$/i.test(address)) errors.push(name + ': a remote server address starts with https://');
        else servers.push({ name: String(name).trim().slice(0, 40), url: address, tools: [] });
        return;
      }
      var checked = validateStdioServer({ name: name, command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd });
      if (checked.ok) servers.push(checked.server);
      else errors.push(name + ': ' + checked.reason);
    });
    if (!servers.length && !errors.length) errors.push('No servers were found in that config.');
    return { servers: servers, errors: errors };
  }

  /** A `tools/call` result as the text a model is handed: its text parts, joined. */
  function mcpResultText(result) {
    var content = result && Array.isArray(result.content) ? result.content : [];
    var text = content.filter(function (c) { return c && c.type === 'text' && typeof c.text === 'string'; })
      .map(function (c) { return c.text; }).join('\n');
    if (text) return text;
    if (result && result.structuredContent) return JSON.stringify(result.structuredContent);
    return JSON.stringify(result || {});
  }

  // ---- MCP Apps (the ext-apps extension) ----------------------------------------
  //
  // A tool may name a UI resource -- `_meta.ui.resourceUri` (older drafts:
  // `_meta["ui/resourceUri"]`) -- that the host reads with `resources/read` and
  // draws in a sandboxed frame under the call. Only `ui://` URIs count: an app
  // is something the server hands over, never a page fetched from somewhere.

  /** An app's HTML is capped at this many bytes. */
  var MAX_APP_HTML_BYTES = 2 * 1024 * 1024;

  /** The tool's `ui://` resource URI, or ''. */
  function uiResourceOf(tool) {
    var meta = tool && tool._meta && typeof tool._meta === 'object' ? tool._meta : null;
    if (!meta) return '';
    var uri = meta.ui && typeof meta.ui === 'object' && typeof meta.ui.resourceUri === 'string'
      ? meta.ui.resourceUri
      : (typeof meta['ui/resourceUri'] === 'string' ? meta['ui/resourceUri'] : '');
    uri = uri.trim();
    return /^ui:\/\/[^\s]+$/i.test(uri) ? uri : '';
  }

  /** Whether one `resources/read` content entry is an app's HTML. */
  function isAppHtml(content) {
    if (!content || typeof content !== 'object') return false;
    var type = String(content.mimeType || '').toLowerCase().replace(/\s+/g, '');
    return type === 'text/html' || type.indexOf('text/html;') === 0;
  }

  function decodeBase64(blob) {
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    if (typeof scope.atob === 'function' && typeof TextDecoder === 'function') {
      var bin = scope.atob(blob);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (typeof Buffer === 'function') return Buffer.from(blob, 'base64').toString('utf8');
    throw new Error('no base64 decoder');
  }

  /**
   * appHtmlFrom(readResult) -> { html, reason }
   *
   * The app's HTML out of a `resources/read` result: the first HTML content,
   * as `text` or a base64 `blob`. `html` is '' (and `reason` says why) when
   * there is none, it will not decode, or it is over MAX_APP_HTML_BYTES.
   */
  function appHtmlFrom(readResult) {
    var contents = readResult && Array.isArray(readResult.contents) ? readResult.contents : [];
    var entry = null;
    for (var i = 0; i < contents.length; i += 1) {
      if (isAppHtml(contents[i])) { entry = contents[i]; break; }
    }
    if (!entry) return { html: '', reason: 'The server did not return an HTML app for this tool.' };
    var html = '';
    if (typeof entry.text === 'string') html = entry.text;
    else if (typeof entry.blob === 'string') {
      // Base64 is 4 characters per 3 bytes: refuse before decoding something huge.
      if (entry.blob.length > Math.ceil(MAX_APP_HTML_BYTES / 3) * 4 + 4) return { html: '', reason: 'The app is larger than 2 MB.' };
      try {
        html = decodeBase64(entry.blob.replace(/\s+/g, ''));
      } catch {
        return { html: '', reason: 'The app could not be decoded.' };
      }
    }
    if (!html) return { html: '', reason: 'The app is empty.' };
    var size = typeof TextEncoder === 'function' ? new TextEncoder().encode(html).length : html.length;
    if (size > MAX_APP_HTML_BYTES) return { html: '', reason: 'The app is larger than 2 MB.' };
    return { html: html, reason: '' };
  }

  /** A shell error split into its message and the server's stderr tail (mcp.rs STDERR_MARK). */
  function splitStderr(message) {
    var s = String(message == null ? '' : message);
    var at = s.indexOf('\n\nstderr:\n');
    if (at < 0) return { message: s, stderr: '' };
    return { message: s.slice(0, at), stderr: s.slice(at + '\n\nstderr:\n'.length) };
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
    if (name === 'spawn_agent') return 'agent:spawn';
    var m = /^mcp__([a-z0-9_]+?)__/.exec(String(name || ''));
    // Only an MCP server (or delegation, whose agents' tools still ask) can be
    // trusted wholesale. Writes, commands and commits ask every time -- that
    // is the rule, not a default.
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
    if (n === 'spawn_agent') return alwaysMap(given)[alwaysKey(n)] ? '' : SPAWN_REASON;
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
    SPAWN_AGENT: SPAWN_AGENT,
    slug: slug,
    mcpServers: mcpServers,
    saveMcpServers: saveMcpServers,
    addMcpServer: addMcpServer,
    addStdioServer: addStdioServer,
    setMcpTools: setMcpTools,
    removeMcpServer: removeMcpServer,
    isStdio: isStdio,
    validateStdioServer: validateStdioServer,
    splitArgs: splitArgs,
    joinArgs: joinArgs,
    parseEnvLines: parseEnvLines,
    parseMcpConfig: parseMcpConfig,
    mcpResultText: mcpResultText,
    MAX_APP_HTML_BYTES: MAX_APP_HTML_BYTES,
    uiResourceOf: uiResourceOf,
    isAppHtml: isAppHtml,
    appHtmlFrom: appHtmlFrom,
    splitStderr: splitStderr,
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
