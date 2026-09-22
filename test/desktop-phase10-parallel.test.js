// Phase 10 (5.7): parallel coding agents, each in its own git worktree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const wt = require('../desktop/src/worktrees.js');

test('tasks become numbered worktrees and branches, four at most', () => {
  const tasks = wt.tasksFrom('- Add validation\n\n2. Write tests!\n* Same task\n* Same task\nFifth');
  assert.deepEqual(tasks, ['Add validation', 'Write tests!', 'Same task', 'Same task', 'Fifth']);
  const rows = wt.plan(tasks, 'x');
  assert.equal(rows.length, wt.MAX_AGENTS);
  assert.deepEqual(rows.map((r) => r.slug), ['add-validation-x1', 'write-tests-x2', 'same-task-x3', 'same-task-x4']);
  assert.equal(rows[0].branch, 'neuraos/add-validation-x1');
  assert.equal(rows[0].dir, '.neuraos/worktrees/add-validation-x1');
});

test('git commands are quoted, and discarding is two separate commands', () => {
  const [row] = wt.plan(['Fix the "login" bug'], 's');
  assert.equal(wt.addCommand(row), 'git worktree add -b neuraos/fix-the-login-bug-s1 ".neuraos/worktrees/fix-the-login-bug-s1" HEAD');
  assert.match(wt.commitCommand(row), /git commit -m "NeuraOS agent: Fix the 'login' bug"/, 'quotes in a task cannot break out');
  assert.equal(wt.mergeCommand(row), 'git merge --no-ff neuraos/fix-the-login-bug-s1 -m "Merge neuraos/fix-the-login-bug-s1"');
  assert.deepEqual(wt.discardCommands(row), ['git worktree remove --force ".neuraos/worktrees/fix-the-login-bug-s1"', 'git branch -D neuraos/fix-the-login-bug-s1']);
  assert.throws(() => wt.addCommand({ ...row, dir: 'a"b' }), /double quote/);
});

test('timers and paths read the way the grid shows them', () => {
  assert.equal(wt.elapsed(4200), '4s');
  assert.equal(wt.elapsed(65000), '1m 05s');
  assert.equal(wt.absolute('C:\\repo\\', '.neuraos/worktrees/a-1'), 'C:\\repo\\.neuraos\\worktrees\\a-1');
  assert.equal(wt.absolute('/home/u/repo', '.neuraos/worktrees/a-1'), '/home/u/repo/.neuraos/worktrees/a-1');
});

test('the grid runs one agent per worktree and merges only on request', () => {
  const screen = read('desktop', 'src', 'screens', 'ParallelScreen.tsx');
  assert.match(screen, /agent\.createSession\(root, model, provider\)/);
  assert.match(screen, /worktrees\.absolute\(localRoot, row\.dir\)/, 'each agent is confined to its worktree');
  assert.match(screen, /'\.neuraos\/\.gitignore', '\*\\n'/, 'worktrees stay out of the main status');
  assert.match(screen, /git\(command, undefined, true\)/, 'discarding asks the shell for the risky-command yes');
  assert.match(screen, /git rev-parse --is-inside-work-tree/);
});
