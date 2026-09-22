// The composer's grammar: modes, the `/` menu, the `@` menu, and the thread
// as Markdown. Pure (node-tested); ChatScreen and Composer.tsx only render it.
//
//   * MODES replace the ModePicker pill. Chat, Plan and Build are what the
//     next message IS, cycled with Tab / Shift+Tab. Shell (`!`) and Design are
//     where it GOES; they are left with Backspace at the start, or Escape.
//   * SLASH is one registry with aliases, a mode to switch to, or text to
//     insert. Skills join it as /skill:<name>. Interview -> Plan -> Implement
//     -> Review is a flow: each step names the next, and the chat offers it.
//   * The `@` menu is one ranked list over whatever sources the caller has
//     (models, files in the open folder, MCP servers, skills).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UComposer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MODES = [
    { id: 'chat', label: '', hint: 'Talk to the model', cycle: true },
    { id: 'plan', label: 'Plan', hint: 'Draft a plan first — nothing is changed', cycle: true },
    { id: 'build', label: 'Build', hint: 'Starts a remote build session with approvals', cycle: true },
    { id: 'shell', label: '!', hint: 'Runs the line as a command in the open folder', cycle: false },
    { id: 'design', label: 'Design', hint: 'Sends the brief to the Design studio', cycle: false },
  ];

  var CYCLE = MODES.filter(function (m) { return m.cycle; }).map(function (m) { return m.id; });

  function modeById(id) {
    for (var i = 0; i < MODES.length; i += 1) if (MODES[i].id === id) return MODES[i];
    return MODES[0];
  }

  /** Tab / Shift+Tab: the next agent mode. A "where it goes" mode steps back into the cycle. */
  function cycleMode(current, backwards) {
    var at = CYCLE.indexOf(current);
    if (at < 0) return 'chat';
    var step = backwards ? -1 : 1;
    return CYCLE[(at + step + CYCLE.length) % CYCLE.length];
  }

  /** Typing `!` into an empty composer is the way into Shell. */
  function modeFromTyping(mode, text) {
    if (text === '!' && mode !== 'shell') return { mode: 'shell', text: '' };
    return null;
  }

  /** Backspace at the very start, or Escape, leaves a non-default mode. */
  function leaveMode(mode, key, caret) {
    if (mode === 'chat') return null;
    if (key === 'Escape') return 'chat';
    if (key === 'Backspace' && caret === 0) return 'chat';
    return null;
  }

  var SLASH = [
    { id: 'new', aliases: ['clear'], hint: 'Start a fresh chat', keys: 'Ctrl+N' },
    { id: 'history', aliases: ['chats'], hint: 'Your saved chats' },
    { id: 'chat', hint: 'Plain chat mode', mode: 'chat' },
    { id: 'interview', hint: 'Let the model ask what it needs before planning', next: 'plan',
      insertText: 'Interview me about this before any plan: ask the 3–5 questions whose answers would change the approach, one short list, then wait.\n\nTopic: ' },
    { id: 'plan', hint: 'Draft a plan first — nothing is changed', mode: 'plan', next: 'implement' },
    { id: 'implement', aliases: ['do'], hint: 'Carry out the plan above with the tools', next: 'review', mode: 'chat',
      insertText: 'Implement the plan above step by step. Use the tools you have; say what you changed after each step.' },
    { id: 'review', hint: 'Check what was done against the plan', mode: 'chat',
      insertText: 'Review what was just done against the plan: what is finished, what is wrong or missing, and what to do next.' },
    { id: 'build', hint: 'Start a remote build session', mode: 'build' },
    { id: 'shell', aliases: ['sh', 'run'], hint: 'Run a command in the open folder', mode: 'shell' },
    { id: 'design', hint: 'Send a brief to the Design studio', mode: 'design' },
    { id: 'agent', aliases: ['agents'], hint: 'Run a sub-agent — /agent file-picker find the router code' },
    { id: 'recipe', aliases: ['recipes'], hint: 'Run a saved recipe — /recipe daily-brief topic=rust' },
    { id: 'research', hint: 'Search the web, read the sources, answer with citations — /research how do heat pumps work' },
    { id: 'model', aliases: ['models'], hint: 'Pick the model', keys: 'Ctrl+M' },
    { id: 'tools', hint: 'Tools and connectors (Settings)' },
    { id: 'mcp', hint: 'MCP servers (Settings)' },
    { id: 'compare', aliases: ['split'], hint: 'The same prompt on two or three models, side by side' },
    { id: 'reasoning', aliases: ['think'], hint: 'How hard the model thinks — /reasoning off, low, medium or high' },
    { id: 'attach', aliases: ['file', 'image'], hint: 'Attach a picture, PDF, Word, Excel, PowerPoint or text file' },
    { id: 'screenshot', aliases: ['capture'], hint: 'Attach a capture of a screen or window (vision models)' },
    { id: 'memory', aliases: ['remember'], hint: 'Save a fact the model should remember — /memory I prefer TypeScript' },
    { id: 'share', hint: 'A read-only link to this chat' },
    { id: 'copy', hint: 'Copy the whole thread as Markdown, tool results included' },
    { id: 'export', hint: 'Save the thread — /export md or /export json' },
    { id: 'settings', aliases: ['prefs'], hint: 'Everything else' },
    { id: 'help', aliases: ['?'], hint: 'What the composer understands' },
  ];

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().trim();
  }

  function registry(extra) {
    return SLASH.concat(Array.isArray(extra) ? extra : []);
  }

  /** Skills as slash rows, without the registry knowing what a skill is. */
  function skillRow(skill) {
    var name = norm((skill && (skill.name || skill.id)) || 'skill').replace(/\s+/g, '-');
    return { id: 'skill:' + name, hint: (skill && skill.description) || 'Use this skill', skill: skill && (skill.id || skill.name) };
  }

  /**
   * The open menu for what is typed, or []. Only while the text is `/word`
   * with no space yet: once an argument starts, the menu has done its job.
   */
  function slashMenu(text, extra, limit) {
    var t = String(text || '');
    if (t.charAt(0) !== '/' || /\s/.test(t)) return [];
    var q = norm(t.slice(1));
    var rows = [];
    registry(extra).forEach(function (cmd, order) {
      var names = [cmd.id].concat(cmd.aliases || []);
      var best = 0;
      names.forEach(function (n) {
        var name = norm(n);
        if (!q) best = Math.max(best, 1);
        else if (name === q) best = Math.max(best, 100);
        else if (name.indexOf(q) === 0) best = Math.max(best, 50 - name.length);
        else if (name.indexOf(q) > 0) best = Math.max(best, 10);
      });
      if (best > 0) rows.push({ cmd: cmd, score: best, order: order });
    });
    rows.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    return rows.slice(0, limit || 8).map(function (r) { return r.cmd; });
  }

  /** '/plan ship the thing' -> { command, arg }; unknown or not a command -> null. */
  function parseSlash(text, extra) {
    var m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
    if (!m) return null;
    var word = norm(m[1]);
    var list = registry(extra);
    for (var i = 0; i < list.length; i += 1) {
      var cmd = list[i];
      var names = [cmd.id].concat(cmd.aliases || []).map(norm);
      if (names.indexOf(word) >= 0) return { command: cmd, arg: (m[2] || '').trim() };
    }
    return null;
  }

  /** The step the flow suggests after this command, as its registry row. */
  function nextStep(id) {
    var from = parseSlash('/' + id);
    if (!from || !from.command.next) return null;
    var to = parseSlash('/' + from.command.next);
    return to ? to.command : null;
  }

  /** The `@word` the caret is in: { start, query } or null. */
  function mentionAt(text, caret) {
    var t = String(text || '');
    var end = typeof caret === 'number' ? caret : t.length;
    var before = t.slice(0, end);
    var m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { start: end - m[2].length - 1, query: m[2] };
  }

  var KIND_ORDER = { model: 0, file: 1, mcp: 2, skill: 3 };

  /** Rank sources for an `@` query. A source is { kind, id, label, hint? }. */
  function mentionMenu(query, sources, limit) {
    var q = norm(query);
    var out = [];
    (sources || []).forEach(function (s, order) {
      var label = norm(s.label || s.id);
      var at = q ? label.indexOf(q) : 0;
      if (q && at < 0) {
        // "qwen coder" should still find "qwen2.5-coder": every word, anywhere.
        var words = q.split(/[\s/:_-]+/).filter(Boolean);
        if (!words.length || !words.every(function (w) { return label.indexOf(w) >= 0; })) return;
        at = 30;
      }
      var score = (at === 0 ? 40 : 20 - Math.min(at, 19)) - (KIND_ORDER[s.kind] || 0);
      out.push({ source: s, score: score, order: order });
    });
    out.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    return out.slice(0, limit || 8).map(function (r) { return r.source; });
  }

  /** Replace the `@query` at `start` with `insert`; returns { text, caret }. */
  function completeMention(text, start, caret, insert) {
    var t = String(text || '');
    var head = t.slice(0, start);
    var tail = t.slice(caret);
    var piece = insert ? insert + (tail.charAt(0) === ' ' ? '' : ' ') : '';
    return { text: head + piece + tail, caret: head.length + piece.length };
  }

  /** The thread as Markdown -- tool calls and their results included. */
  function threadMarkdown(session) {
    var s = session || {};
    var lines = ['# ' + (s.title || 'Chat'), ''];
    (s.messages || []).forEach(function (m) {
      var who = m.role === 'user' ? 'You' : (m.model ? 'Assistant (' + m.model + ')' : 'Assistant');
      lines.push('## ' + who, '');
      if (m.content) lines.push(String(m.content), '');
      (m.tools || []).forEach(function (t) {
        lines.push('> Tool `' + t.name + '` — ' + (t.status || 'done'));
        lines.push('```json', JSON.stringify(t.args || {}, null, 2), '```');
        if (t.result != null) lines.push('```', String(t.result), '```');
        lines.push('');
      });
      if (m.failure && m.failure.summary) lines.push('_Failed: ' + m.failure.summary + '_', '');
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function lastUserText(messages) {
    var list = messages || [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] && list[i].role === 'user' && list[i].content) {
        return String(list[i].content).split('\n\n--- attached ---\n')[0];
      }
    }
    return '';
  }

  return {
    MODES: MODES,
    SLASH: SLASH,
    modeById: modeById,
    cycleMode: cycleMode,
    modeFromTyping: modeFromTyping,
    leaveMode: leaveMode,
    skillRow: skillRow,
    slashMenu: slashMenu,
    parseSlash: parseSlash,
    nextStep: nextStep,
    mentionAt: mentionAt,
    mentionMenu: mentionMenu,
    completeMention: completeMention,
    threadMarkdown: threadMarkdown,
    lastUserText: lastUserText,
  };
});
