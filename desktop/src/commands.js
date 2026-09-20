// What the command palette can do, and how a query narrows it.
//
// The rules are here (pure, node-tested) rather than in the component: which
// screens and actions exist, how "bu im" still finds "Open Images", that a
// recent chat and a skill are both reachable from the keyboard, and that the
// best match is first. The palette itself is only a list and a cursor.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app reads the global (published unconditionally -- see chats.js).
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UCommands = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_RESULTS = 9;

  // The fixed surface: every screen the sidebar has, plus the actions that had
  // no home before this existed.
  var COMMANDS = [
    { id: 'go-chat', group: 'Go to', title: 'Chat', hint: 'Talk to a model', keys: 'Alt+1', palette: 'chat' },
    { id: 'go-images', group: 'Go to', title: 'Images', hint: 'Generate a picture', keys: 'Alt+2', palette: 'images' },
    { id: 'go-build', group: 'Go to', title: 'Builds', hint: 'Remote build sessions and approvals', keys: 'Alt+3', palette: 'build' },
    { id: 'go-local', group: 'Go to', title: 'Local', hint: 'Your own folder: tree, viewer, terminal', keys: 'Alt+4', palette: 'local' },
    { id: 'go-design', group: 'Go to', title: 'Design', hint: 'Brand + anti-slop review', keys: 'Alt+5', palette: 'design' },
    { id: 'go-library', group: 'Go to', title: 'Library', hint: 'Skills and saved chats', keys: 'Alt+6', palette: 'library' },
    { id: 'go-files', group: 'Go to', title: 'Files', hint: 'Extract and generate documents', keys: 'Alt+F', palette: 'files' },
    { id: 'go-settings', group: 'Go to', title: 'Settings', hint: 'Engine, sign-in, diagnostics', keys: 'Alt+7', palette: 'settings' },
    { id: 'new-chat', group: 'Do', title: 'New chat', hint: 'Start a fresh conversation' },
    { id: 'toggle-theme', group: 'Do', title: 'Switch theme', hint: 'Light or dark' },
    { id: 'toggle-zen', group: 'Do', title: 'Zen mode', hint: 'Hide the chrome and keep only the canvas', keys: 'Ctrl+Shift+Z' },
    { id: 'open-folder', group: 'Do', title: 'Open a local folder', hint: 'Choose the folder the terminal and agent work in' },
    { id: 'toggle-folder-panel', group: 'Panel', title: 'Local folder tree', hint: 'Files on this machine' },
    { id: 'toggle-terminal', group: 'Panel', title: 'Terminal', hint: 'Run commands on this machine' },
    { id: 'toggle-history', group: 'Panel', title: 'History', hint: 'Your saved chats' },
    { id: 'toggle-approvals', group: 'Panel', title: 'Approvals', hint: 'Pending build approvals, docked on the right' },
    { id: 'toggle-skills', group: 'Panel', title: 'Skills', hint: 'The skills and memory behind the replies' },
    { id: 'build-logs', group: 'Do', title: 'Show build logs', hint: 'The live build timeline and its approvals', palette: 'build' },
    { id: 'local-models', group: 'Do', title: 'Local LLM', hint: 'Start or stop the llama.cpp server on this machine', palette: 'settings' },
    { id: 'export-chats', group: 'Do', title: 'Export chats', hint: 'Write every conversation to a JSON file' },
    { id: 'check-updates', group: 'Do', title: 'Check for updates', hint: 'Read the latest release' },
    { id: 'copy-diagnostics', group: 'Do', title: 'Copy diagnostics', hint: 'The report, in Settings', palette: 'settings' },
  ];

  function normalise(value) {
    return String(value == null ? '' : value).toLowerCase().trim();
  }

  // "bu im" must find "Open Images", and "imag" must too. Every query word has
  // to appear somewhere in the title, hint or group -- order does not matter,
  // because typing a fragment of the middle of a name is normal.
  function score(command, query) {
    var q = normalise(query);
    if (!q) return 1;
    var haystack = normalise(command.title + ' ' + command.hint + ' ' + command.group + ' ' + String(command.id).replace(/-/g, ' '));
    var words = q.split(/\s+/).filter(Boolean);
    var total = 0;
    for (var i = 0; i < words.length; i += 1) {
      var word = words[i];
      var at = haystack.indexOf(word);
      if (at < 0) return 0;
      // A word that starts the title ranks above one found in the middle, and
      // an exact title beats everything.
      if (normalise(command.title) === q) total += 100;
      else if (normalise(command.title).indexOf(word) === 0) total += 20;
      else total += 5;
      total -= Math.min(at, 20) / 10;
    }
    return total;
  }

  function search(query, options) {
    var opts = options || {};
    var limit = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_RESULTS;
    var extra = Array.isArray(opts.extra) ? opts.extra : [];
    var all = COMMANDS.concat(extra);
    var scored = [];
    for (var i = 0; i < all.length; i += 1) {
      var value = score(all[i], query);
      if (value > 0) scored.push({ command: all[i], score: value, order: i });
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    });
    return scored.slice(0, limit).map(function (entry) { return entry.command; });
  }

  // A chat or a skill becomes a palette row without the palette knowing what a
  // chat or a skill is.
  function chatCommand(session) {
    var title = (session && session.title) || 'Chat';
    return { id: 'open-chat:' + session.id, group: 'Chats', title: title, hint: 'Open this conversation', chat: session.id };
  }

  function skillCommand(skill) {
    var name = (skill && (skill.name || skill.id)) || 'Skill';
    return { id: 'open-skill:' + (skill && skill.id), group: 'Skills', title: name, hint: 'Read it in the Library', skill: skill && skill.id };
  }

  return {
    COMMANDS: COMMANDS,
    MAX_RESULTS: MAX_RESULTS,
    score: score,
    search: search,
    chatCommand: chatCommand,
    skillCommand: skillCommand,
  };
});
