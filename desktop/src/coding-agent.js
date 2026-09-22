// Local coding agent: a plan → approve → edit → run loop for real files on
// this machine.
//
// This module is the engine: it owns the session state, the tool-call parsing,
// the approval gate, and the stop/expire/repeat detection. The UI that renders
// the diffs and the approve/reject buttons is in CodeScreen.tsx (React). The
// actual file and command execution goes through bridge.ts (the Rust shell).
//
// The design mirrors the engine's agent-sessions.js as closely as possible:
//   - plan → steps, each step is a tool call
//   - tool calls are parsed from the model's output (tool-call-text.js pattern)
//   - every mutation (write_file, edit_file, run_command) is gated by an
//     approval request with the diff or command shown
//   - the agent can be stopped at any time
//   - AGENTS.md and CLAUDE.md project notes are read at the start
//
// The model source is the same streamChat / streamLocalChat in api.ts — the
// agent sends the conversation to whichever provider the user picked.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UCodingAgent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // --- the tools the agent can call ---------------------------------------

  var TOOLS = [
    {
      name: 'list_files',
      description: 'List files in the project directory. Pass a relative path to list a subdirectory.',
      params: [{ name: 'path', type: 'string', required: false }],
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file.',
      params: [
        { name: 'path', type: 'string', required: true },
        { name: 'offset', type: 'number', required: false },
        { name: 'limit', type: 'number', required: false },
      ],
    },
    {
      // NEURA-056. The whole point of the index: the answer is a list of places,
      // so the model stops spending a list_files/read_file round trip to find
      // out where a name lives. It never returns file contents.
      name: 'find_symbol',
      description: 'Look a name up in the project index: the answer is paths and line numbers, never file contents. '
        + 'Try this before list_files or read_file. It says so when the index is stale, partial or missing.',
      params: [
        { name: 'query', type: 'string', required: true },
        { name: 'limit', type: 'number', required: false },
      ],
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with new content.',
      params: [
        { name: 'path', type: 'string', required: true },
        { name: 'content', type: 'string', required: true },
      ],
      mutating: true,
    },
    {
      name: 'edit_file',
      description: 'Replace a span of text in a file. The old_text must match exactly.',
      params: [
        { name: 'path', type: 'string', required: true },
        { name: 'old_text', type: 'string', required: true },
        { name: 'new_text', type: 'string', required: true },
      ],
      mutating: true,
    },
    {
      name: 'run_command',
      description: 'Run a shell command in the project directory. Destructive commands need approval.',
      params: [
        { name: 'command', type: 'string', required: true },
        { name: 'cwd', type: 'string', required: false },
      ],
      mutating: true,
    },
  ];

  var MAX_ROUNDS = 30;
  var MAX_TOOL_CALLS = 100;
  var MAX_RETRY = 3;

  // --- system prompt ------------------------------------------------------

  // The per-project file's rules live in project-config.js, which the Code
  // screen loads for its side effect. It is read off the global rather than
  // imported, because these UMD modules are loaded as scripts and one must not
  // have to know another's path. When it is absent -- any caller that never
  // loads it, such as Parallel -- every mutating tool stays approval-gated,
  // which is the behaviour this agent has always had.
  function projectConfig() {
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : null;
      return (scope && scope.FreeAI4UProjectConfig) || null;
    } catch {
      return null;
    }
  }

  // NEURA-056. project-scout.js is read off the global for the same reason as
  // project-config.js: these UMD modules are loaded as scripts, and a caller
  // that never loaded it (Parallel, a test) must still get today's behaviour --
  // no map, no find_symbol answer, and a note saying so rather than a crash.
  function projectScout() {
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : null;
      return (scope && scope.FreeAI4UProjectScout) || null;
    } catch {
      return null;
    }
  }

  /**
   * The scout's I/O, which is the agent's own callbacks with the session root
   * already bound: the scout asks for a relative path and never learns what
   * folder it is in, which is the shape project-scout.js documents.
   */
  function scoutIO(c, root) {
    if (!c || typeof c.listFiles !== 'function') return null;
    var io = {
      listFiles: function (path) { return c.listFiles(root, path || ''); },
    };
    if (typeof c.readFile === 'function') {
      io.readFile = function (path) { return c.readFile(root, path); };
    }
    return io;
  }

  /**
   * The map for this folder, built at most once per run: a saved index that
   * still matches the tree is used as it is, anything else is rebuilt and
   * saved. Never throws -- a folder that cannot be mapped degrades to the
   * behaviour the agent has always had, with a line saying why.
   *
   * Returns `{ index, note }`; `note` is '' when there is nothing to say.
   */
  async function ensureIndex(session, c) {
    var scout = projectScout();
    if (!scout) return { index: null, note: '' };
    var io = scoutIO(c, session && session.root);
    if (!io) return { index: null, note: '' };
    try {
      var index = null;
      try { index = scout.load(session.root); } catch { index = null; }
      if (index) {
        var fresh = await scout.checkFresh(index, io);
        index = scout.markFresh(index, fresh);
        // A stale map is worth less than the walk that replaces it, and the
        // walk reads names and sizes only until it decides to.
        if (fresh.stale) index = null;
      }
      if (!index) {
        emit(c.onEvent, { type: 'index', state: 'building' });
        index = await scout.buildIndex(session.root, io);
      }
      scout.save(index);
      emit(c.onEvent, { type: 'index', state: 'ready', status: scout.status(index) });
      return { index: index, note: '' };
    } catch (err) {
      var why = String(err?.message || err);
      emit(c.onEvent, { type: 'index', state: 'failed', error: why });
      return {
        index: null,
        note: 'The project index could not be built (' + why + '), so find_symbol has nothing to answer from. '
          + 'Use list_files and read_file as usual.',
      };
    }
  }

  /**
   * A query answer as lines the model can act on: `path:line  kind name`, and
   * nothing else. No file content ever crosses this boundary, and a stale or
   * partial index says so on its own line instead of being quietly trusted.
   */
  function renderMatches(answer) {
    if (!answer) return 'No project index is available. Use list_files and read_file.';
    var lines = [];
    if (answer.stale) {
      lines.push('STALE INDEX: ' + (answer.staleReason || 'the folder changed since this map was built')
        + '. Treat these lines as a starting point and confirm with read_file.');
    }
    if (!answer.ok || !answer.matches || !answer.matches.length) {
      lines.push('No match in the index for "' + answer.query + '".');
      if (answer.note) lines.push(answer.note);
      return lines.join('\n');
    }
    for (var i = 0; i < answer.matches.length; i++) {
      var m = answer.matches[i];
      lines.push(m.path + ':' + m.line + '  ' + m.kind + ' ' + m.name);
    }
    if (answer.note) lines.push(answer.note);
    return lines.join('\n');
  }

  function systemPrompt(projectNotes, projectPrompt, projectMap) {
    var notes = projectNotes || '';
    var header = [
      'You are a coding assistant that helps the user edit files on their machine.',
      'You work in a single project folder. Every file path is relative to that folder.',
      'When the user asks you to make a change, you:',
      '1. Plan the change (explain what you will do and why).',
      '2. Call the appropriate tool to make the edit.',
      '3. Run any relevant tests or checks.',
      '4. Report what you did and whether it succeeded.',
      '',
      'Rules:',
      '- Never modify files outside the project folder.',
      '- Never modify .git or .env files.',
      '- Always explain before mutating.',
      '- If a command is destructive (git push, rm -rf, etc.), flag it for approval.',
      '- When editing, use edit_file with the exact old_text to replace.',
      '- Keep changes minimal and focused.',
    ];
    if (notes) {
      header.push('', 'Project notes:', notes);
    }
    // `projectPrompt` arrives already labelled as the project's own words
    // (project-config.promptBlock). It goes *after* the rules, never instead of
    // them: a folder can add context about itself, not re-brief the agent.
    if (projectPrompt) {
      header.push('', String(projectPrompt));
    }
    // NEURA-056. The map goes in the prompt so the first turn already knows the
    // areas and the entry points: that is a list_files round trip the agent no
    // longer has to spend before it can think.
    if (projectMap) {
      header.push('', 'Project map (from the index; ask find_symbol for a name, do not re-walk the tree):',
        String(projectMap));
    }
    header.push('', 'Available tools:');
    for (var i = 0; i < TOOLS.length; i++) {
      var t = TOOLS[i];
      var sig = t.name + '(' + t.params.map(function (p) {
        return p.name + (p.required ? '' : '?');
      }).join(', ') + ')';
      header.push('- ' + sig + ': ' + t.description);
    }
    header.push(
      '',
      'To call a tool, output a JSON block like:',
      '```tool',
      '{"name": "tool_name", "args": {"param": "value"}}',
      '```',
      'Only call one tool per response. Wait for the result before calling another.',
    );
    return header.join('\n');
  }

  // --- tool-call parsing --------------------------------------------------
  //
  // The agent outputs tool calls in ```tool ... ``` code blocks. Weak models
  // may also output them as plain JSON or with markdown wrappers. We try
  // several patterns, like the engine's tool-call-text.js.

  function parseToolCall(text) {
    var s = String(text || '');
    // Pattern 1: ```tool\n{...}\n```
    var m = s.match(/```(?:tool|json|)\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/);
    if (m) return safeJson(m[1]);
    // Pattern 2: plain JSON object at the top level
    m = s.match(/^\s*(\{[\s\S]*\})\s*$/);
    if (m) return safeJson(m[1]);
    // Pattern 3: {"name": ...} anywhere
    m = s.match(/(\{[^{}]*"name"\s*:[^{}]*\})/);
    if (m) return safeJson(m[1]);
    // Pattern 4: name: "tool_name" ... args: {...}
    m = s.match(/name:\s*["'](\w+)["']/);
    if (m) {
      var name = m[1];
      var argsM = s.match(/args:\s*(\{[^{}]*\})/);
      return argsM ? { name: name, args: safeJson(argsM[1]) || {} } : { name: name, args: {} };
    }
    return null;
  }

  function safeJson(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  // --- session state ------------------------------------------------------

  function createSession(root, model, provider) {
    return {
      id: 'agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      root: root,
      model: model || '',
      provider: provider || '',
      // The folder's effective settings (project-config.merge), or null when
      // the caller read no project file -- null means "ask about everything".
      config: null,
      status: 'idle',       // idle | planning | running | awaiting | done | error | stopped
      plan: [],             // step objects: { id, title, status, tool, args, result, diff }
      messages: [],         // the conversation sent to the model
      pendingApproval: null, // { id, tool, args, diff?, command? }
      toolCalls: 0,
      rounds: 0,
      error: null,
      startedAt: null,
      updatedAt: null,
    };
  }

  // --- project notes ------------------------------------------------------

  async function readProjectNotes(readFile) {
    var candidates = ['AGENTS.md', 'CLAUDE.md', '.github/AGENTS.md'];
    var notes = [];
    for (var i = 0; i < candidates.length; i++) {
      try {
        var raw = await readFile(candidates[i]);
        // The bridge's reader answers `{ text, binary, bytes }`; a test's may
        // answer a plain string. Both are notes.
        var content = raw && typeof raw === 'object' ? String(raw.text || '') : String(raw || '');
        if (content && content.trim()) {
          notes.push('## ' + candidates[i] + '\n' + content.trim());
        }
      } catch { /* not every project has these */ }
    }
    return notes.join('\n\n');
  }

  // --- diff generation for edit_file --------------------------------------

  function computeDiff(oldText, newText) {
    var oldLines = String(oldText || '').split('\n');
    var newLines = String(newText || '').split('\n');
    var diff = [];
    var maxLen = Math.max(oldLines.length, newLines.length);
    for (var i = 0; i < maxLen; i++) {
      var oldLine = i < oldLines.length ? oldLines[i] : undefined;
      var newLine = i < newLines.length ? newLines[i] : undefined;
      if (oldLine === newLine) {
        diff.push('  ' + (oldLine || ''));
      } else {
        if (oldLine !== undefined) diff.push('- ' + oldLine);
        if (newLine !== undefined) diff.push('+ ' + newLine);
      }
    }
    return diff.join('\n');
  }

  // --- the execution loop -------------------------------------------------

  /**
   * runAgent(session, { sendMessage, readFile, writeFile, editFile, runCmd, onEvent })
   *
   * The agent loop:
   * 1. Read project notes.
   * 2. Send the user's request + system prompt to the model.
   * 3. Parse the model's response for a tool call.
   * 4. If the tool is read-only, execute immediately.
   * 5. If the tool is mutating, create an approval request and wait.
   * 6. Feed the result back and repeat until the model says it's done or
   *    we hit the round limit.
   *
   * All I/O goes through callbacks so this module is testable without Rust.
   */
  async function runAgent(session, callbacks) {
    var c = callbacks;
    session.status = 'running';
    session.startedAt = session.startedAt || Date.now();
    session.updatedAt = Date.now();
    emit(c.onEvent, { type: 'status', status: 'running' });

    // Step 0: project notes, and the folder's map (NEURA-056). Both are read
    // once, before the first model call, and neither can fail the run.
    var notes = '';
    if (c.readFile) {
      try {
        notes = await readProjectNotes(function (path) { return c.readFile(session.root, path); });
      } catch { /* ignore */ }
    }

    var scouted = await ensureIndex(session, c);
    var projectIndex = scouted.index;
    var scout = projectScout();
    var mapBlock = projectIndex && scout ? scout.describe(projectIndex) : scouted.note;

    var config = session.config || null;
    var pc = projectConfig();
    var sysPrompt = systemPrompt(notes, pc && config ? pc.promptBlock(config.systemPrompt) : '', mapBlock);
    session.messages = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: session.plan[0]?.title || 'Help me with this project.' },
    ];

    // If the initial request was provided as a "plan", the first message
    // content is the user's description. The plan entries are the steps the
    // agent will report as it works.
    if (session.plan.length && session.plan[0].tool === 'user_request') {
      session.messages[1] = { role: 'user', content: session.plan[0].title };
      session.plan.shift();
    }

    while (session.rounds < MAX_ROUNDS && session.toolCalls < MAX_TOOL_CALLS) {
      if (session.status === 'stopped') break;

      session.rounds++;
      session.updatedAt = Date.now();
      emit(c.onEvent, { type: 'round', round: session.rounds });

      // Call the model.
      var response;
      try {
        response = await c.sendMessage(session.messages, session.model, session.provider);
      } catch (err) {
        session.status = 'error';
        session.error = String(err?.message || err);
        emit(c.onEvent, { type: 'error', error: session.error });
        return session;
      }

      var content = typeof response === 'string' ? response : (response?.content || '');
      session.messages.push({ role: 'assistant', content: content });

      // Parse a tool call from the response.
      var call = parseToolCall(content);
      if (!call || !call.name) {
        // No tool call — the model is talking to the user. We're done.
        session.status = 'done';
        session.updatedAt = Date.now();
        emit(c.onEvent, { type: 'status', status: 'done', message: content });
        return session;
      }

      var tool = TOOLS.find(function (t) { return t.name === call.name; });
      if (!tool) {
        session.messages.push({
          role: 'user',
          content: 'Error: unknown tool "' + call.name + '". Available tools: ' +
            TOOLS.map(function (t) { return t.name; }).join(', '),
        });
        continue;
      }

      session.toolCalls++;
      var args = call.args || {};
      var stepId = session.toolCalls;

      // Emit the step so the UI can show it.
      var step = {
        id: stepId,
        title: tool.name + '(' + summarizeArgs(args) + ')',
        status: 'running',
        tool: tool.name,
        args: args,
        result: null,
        diff: null,
      };
      session.plan.push(step);
      emit(c.onEvent, { type: 'step', step: step });

      // Read-only tools execute immediately.
      if (!tool.mutating) {
        var result;
        try {
          result = await executeReadOnly(tool.name, args, c, session.root, projectIndex);
          step.status = 'done';
          step.result = result;
          emit(c.onEvent, { type: 'step', step: step });
          session.messages.push({ role: 'user', content: 'Result:\n' + result });
        } catch (err) {
          step.status = 'failed';
          step.result = 'Error: ' + (err?.message || err);
          emit(c.onEvent, { type: 'step', step: step });
          session.messages.push({ role: 'user', content: step.result });
        }
        continue;
      }

      // Mutating tools need approval, unless the folder's effective settings
      // say this one does not. Those settings are the person's own narrowed by
      // the project file, never widened by it (project-config.js), so with no
      // settings -- or a module that never loaded -- the answer is "ask".
      var gated = !pc || !config ? true : pc.needsApproval(config, call.name, args);

      var diff = null;
      if (call.name === 'edit_file' && args.old_text != null && args.new_text != null) {
        diff = computeDiff(args.old_text, args.new_text);
      }
      if (call.name === 'write_file' && args.content != null) {
        diff = '+ ' + (args.content || '').split('\n').join('\n+ ');
      }

      if (gated) {
        var approvalId = 'approval-' + stepId;
        session.pendingApproval = {
          id: approvalId,
          stepId: stepId,
          tool: call.name,
          args: args,
          diff: diff,
          command: call.name === 'run_command' ? args.command : null,
        };
        session.status = 'awaiting';
        emit(c.onEvent, {
          type: 'approval',
          approval: session.pendingApproval,
        });

        // Wait for the user's decision. The caller invokes approve() or reject().
        var decision = await waitForDecision(c, approvalId);
        session.pendingApproval = null;

        if (decision.cancelled || session.status === 'stopped') {
          session.status = 'stopped';
          step.status = 'skipped';
          emit(c.onEvent, { type: 'step', step: step });
          break;
        }

        if (!decision.approved) {
          step.status = 'skipped';
          step.result = 'Rejected by user.';
          emit(c.onEvent, { type: 'step', step: step });
          session.messages.push({
            role: 'user',
            content: 'The user rejected this action. ' + (decision.reason || 'Try a different approach.'),
          });
          continue;
        }
      } else {
        // Not gated: still say so, so an unattended action is never invisible.
        session.status = 'running';
        step.diff = diff;
        emit(c.onEvent, { type: 'auto', tool: call.name, step: step });
      }

      // Execute the mutation.
      var execResult;
      try {
        execResult = await executeMutating(call.name, args, c, session.root);
        // NEURA-056. The file just changed, so the map no longer describes the
        // folder. Marking it stale (here and in storage) is what makes the next
        // find_symbol say so instead of answering from a pre-edit map.
        if (call.name === 'write_file' || call.name === 'edit_file') {
          projectIndex = markIndexStale(projectIndex, String(args.path || 'a file'));
        }
        step.status = 'done';
        step.result = execResult;
        emit(c.onEvent, { type: 'step', step: step });
        session.messages.push({ role: 'user', content: 'Success:\n' + execResult });
      } catch (err) {
        step.status = 'failed';
        step.result = 'Error: ' + (err?.message || err);
        emit(c.onEvent, { type: 'step', step: step });
        session.messages.push({ role: 'user', content: step.result });
      }
    }

    if (session.status === 'running') {
      session.status = session.toolCalls >= MAX_TOOL_CALLS ? 'error' : 'done';
      if (session.toolCalls >= MAX_TOOL_CALLS) {
        session.error = 'Tool call limit (' + MAX_TOOL_CALLS + ') reached.';
      }
    }
    session.updatedAt = Date.now();
    emit(c.onEvent, { type: 'status', status: session.status });
    return session;
  }

  // --- tool executors -----------------------------------------------------

  /**
   * The index, and the copy in storage, marked stale after this session wrote
   * to `path`. A failure to store is not a failure of the turn -- the in-memory
   * index still carries the warning.
   */
  function markIndexStale(index, path) {
    var scout = projectScout();
    if (!scout || !index) return index;
    try {
      var next = scout.markFresh(index, {
        stale: true,
        reason: 'this session changed ' + path + ' after the map was built',
      });
      scout.save(next);
      return next;
    } catch {
      return index;
    }
  }

  async function executeReadOnly(name, args, c, root, index) {
    if (name === 'list_files') {
      if (!c.listFiles) throw new Error('list_files is not available');
      var listing = await c.listFiles(root, args.path || '');
      // Format for the model.
      var entries = Array.isArray(listing?.entries) ? listing.entries : [];
      return entries.map(function (e) {
        return (e.dir ? '[dir] ' : '      ') + e.name + (e.size ? ' (' + e.size + ' bytes)' : '');
      }).join('\n') || '(empty directory)';
    }
    if (name === 'read_file') {
      if (!c.readFile) throw new Error('read_file is not available');
      var file = await c.readFile(root, args.path);
      if (file && file.binary) return '(binary file — ' + file.bytes + ' bytes)';
      return file?.text || file || '(empty file)';
    }
    if (name === 'find_symbol') {
      var scout = projectScout();
      if (!scout || !index) {
        return 'No project index has been built for this folder, so there is nothing to look up. '
          + 'Use list_files and read_file instead.';
      }
      var limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
      return renderMatches(scout.query(index, args.query || args.name || args.symbol || '', { limit: limit }));
    }
    throw new Error('Unknown read-only tool: ' + name);
  }

  async function executeMutating(name, args, c, root) {
    if (name === 'write_file') {
      if (!c.writeFile) throw new Error('write_file is not available');
      var res = await c.writeFile(root, args.path, args.content);
      return 'Wrote ' + (res?.bytes || 0) + ' bytes to ' + args.path;
    }
    if (name === 'edit_file') {
      if (!c.editFile) throw new Error('edit_file is not available');
      var res2 = await c.editFile(root, args.path, args.old_text, args.new_text);
      return 'Replaced ' + (res2?.replaced || 0) + ' occurrence(s) in ' + args.path;
    }
    if (name === 'run_command') {
      if (!c.runCmd) throw new Error('run_command is not available');
      var runRes = await c.runCmd(root, args.command, args.cwd);
      var out = '';
      if (runRes.stdout) out += 'stdout:\n' + runRes.stdout + '\n';
      if (runRes.stderr) out += 'stderr:\n' + runRes.stderr + '\n';
      out += 'exit code: ' + (runRes.exitCode ?? 'unknown');
      if (runRes.timedOut) out += ' (timed out)';
      return out;
    }
    throw new Error('Unknown mutating tool: ' + name);
  }

  // --- approval wait ------------------------------------------------------

  function waitForDecision(c, approvalId) {
    return new Promise(function (resolve) {
      if (c.onDecision) c.onDecision(approvalId, resolve);
      else resolve({ approved: false, cancelled: true });
    });
  }

  // --- helpers ------------------------------------------------------------

  function emit(fn, data) {
    if (typeof fn === 'function') {
      try { fn(data); } catch { /* swallow */ }
    }
  }

  function summarizeArgs(args) {
    var keys = Object.keys(args || {});
    return keys.map(function (k) {
      var v = args[k];
      if (typeof v === 'string') return k + '=' + (v.length > 40 ? v.slice(0, 40) + '…' : v);
      return k + '=' + JSON.stringify(v);
    }).join(', ');
  }

  return {
    TOOLS: TOOLS,
    MAX_ROUNDS: MAX_ROUNDS,
    MAX_TOOL_CALLS: MAX_TOOL_CALLS,
    systemPrompt: systemPrompt,
    parseToolCall: parseToolCall,
    createSession: createSession,
    readProjectNotes: readProjectNotes,
    computeDiff: computeDiff,
    runAgent: runAgent,
    summarizeArgs: summarizeArgs,
    scoutIO: scoutIO,
    ensureIndex: ensureIndex,
    renderMatches: renderMatches,
  };
});
