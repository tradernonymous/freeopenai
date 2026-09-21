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

  function systemPrompt(projectNotes) {
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
        var content = await readFile(candidates[i]);
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

    // Step 0: project notes.
    var notes = '';
    if (c.readFile) {
      try {
        notes = await readProjectNotes(c.readFile);
      } catch { /* ignore */ }
    }

    var sysPrompt = systemPrompt(notes);
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
          result = await executeReadOnly(tool.name, args, c, session.root);
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

      // Mutating tools need approval.
      var diff = null;
      if (call.name === 'edit_file' && args.old_text != null && args.new_text != null) {
        diff = computeDiff(args.old_text, args.new_text);
      }
      if (call.name === 'write_file' && args.content != null) {
        diff = '+ ' + (args.content || '').split('\n').join('\n+ ');
      }

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

      // Execute the mutation.
      var execResult;
      try {
        execResult = await executeMutating(call.name, args, c, session.root);
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

  async function executeReadOnly(name, args, c, root) {
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
  };
});
