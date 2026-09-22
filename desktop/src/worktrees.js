// Parallel agents (roadmap 5.7): each agent works in its own git worktree of
// the open folder, on its own branch, so two agents can edit the same file
// without meeting. This module only PLANS: slugs, branch names, folders and
// the exact git commands; ParallelScreen runs them through the shell (which
// applies its own command rules -- discarding needs the risky-command yes).
//
// Worktrees live inside the project, at .neuraos/worktrees/<slug>, because
// every shell command is confined to the open folder. A `*` .gitignore in
// .neuraos keeps them out of the main tree's status.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FreeAI4UWorktrees = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var BASE = '.neuraos/worktrees';
  var BRANCH_PREFIX = 'neuraos/';
  /** More at once than this and a 4 GB GPU (or a free-tier rate limit) chokes. */
  var MAX_AGENTS = 4;

  function slug(text, n) {
    var s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
    return (s || 'task') + '-' + String(n);
  }

  /** Double-quote a path for cmd.exe; quotes inside are refused, not escaped. */
  function q(path) {
    var p = String(path);
    if (p.indexOf('"') >= 0) throw new Error('A path with a double quote cannot be used: ' + p);
    return '"' + p + '"';
  }

  /** One worktree per task line, numbered so two alike tasks never collide. */
  function plan(tasks, stamp) {
    var t = String(stamp || Date.now().toString(36));
    return (tasks || [])
      .map(function (x) { return String(x || '').trim(); })
      .filter(Boolean)
      .slice(0, MAX_AGENTS)
      .map(function (task, i) {
        var s = slug(task, t + (i + 1));
        return { task: task, slug: s, branch: BRANCH_PREFIX + s, dir: BASE + '/' + s };
      });
  }

  /** Split the textarea: one task per line, blank lines and "- " bullets tidied. */
  function tasksFrom(text) {
    return String(text || '').split(/\r?\n/)
      .map(function (l) { return l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim(); })
      .filter(Boolean);
  }

  function addCommand(row) {
    return 'git worktree add -b ' + row.branch + ' ' + q(row.dir) + ' HEAD';
  }

  /** What changed in a worktree, as git's own summary. */
  function statCommand() {
    return 'git add -A && git diff --cached --stat HEAD';
  }

  /** Commit the agent's work on its branch (run inside the worktree). */
  function commitCommand(row) {
    var msg = ('NeuraOS agent: ' + row.task).replace(/"/g, "'").slice(0, 120);
    return 'git add -A && git commit -m ' + q(msg);
  }

  /** Bring the branch into whatever the main tree has checked out. */
  function mergeCommand(row) {
    return 'git merge --no-ff ' + row.branch + ' -m ' + q('Merge ' + row.branch);
  }

  /** Remove the worktree and its branch (risky: needs the person's yes). */
  function discardCommands(row) {
    return ['git worktree remove --force ' + q(row.dir), 'git branch -D ' + row.branch];
  }

  /** "1m 05s" for a running agent's timer. */
  function elapsed(ms) {
    var s = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
    var m = Math.floor(s / 60);
    var rest = s % 60;
    return m ? m + 'm ' + (rest < 10 ? '0' : '') + rest + 's' : rest + 's';
  }

  /** Join the open folder and a worktree's relative dir into the path the agent works in. */
  function absolute(rootPath, dir) {
    var sep = /\\/.test(String(rootPath)) ? '\\' : '/';
    return String(rootPath).replace(/[\\/]+$/, '') + sep + String(dir).split('/').join(sep);
  }

  return {
    BASE: BASE,
    BRANCH_PREFIX: BRANCH_PREFIX,
    MAX_AGENTS: MAX_AGENTS,
    slug: slug,
    plan: plan,
    tasksFrom: tasksFrom,
    addCommand: addCommand,
    statCommand: statCommand,
    commitCommand: commitCommand,
    mergeCommand: mergeCommand,
    discardCommands: discardCommands,
    elapsed: elapsed,
    absolute: absolute,
  };
});
