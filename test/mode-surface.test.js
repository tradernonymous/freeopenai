// A mode that only asks nicely is not a mode. Chat answers, Plan proposes, Build
// changes -- and the difference is enforced as a tool surface rather than as a
// sentence in the prompt, because a model with a write tool in front of it will
// use it whatever the instruction above says. These are the rules that decide
// what each mode is offered, and the refusal that catches a call that arrives
// anyway (a turn resumed from another mode, a model reaching for a tool it
// remembers).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GITHUB_TOOLS,
  GITHUB_WRITE_TOOL_NAMES,
  MODE_TOOL_GROUPS,
  TOOL_GROUPS,
  TASK_TOOLS,
  USE_SKILL_TOOL,
  WEB_TOOLS,
  WORKSPACE_TOOLS,
  WORKSPACE_WRITE_TOOL_NAMES,
  WRITE_TOOL_GROUPS,
  modeAllowsTool,
  modeBlocksWrite,
  modeWriteRefusal,
  toolGroupsForName,
  toolsForMode,
  isGithubWriteTool,
} = require('../chatlib.js');

const ALL_TOOLS = [...WEB_TOOLS, ...WORKSPACE_TOOLS, ...TASK_TOOLS, ...GITHUB_TOOLS, USE_SKILL_TOOL];
const namesFor = (mode) => toolsForMode(mode, ALL_TOOLS).map((t) => t.function.name);

test('every write tool is in a write group, and every write group is real', () => {
  // The two lists that must not drift: the groups the surface is built from and
  // the names the parallel-safety rule and the refusal both read. A write tool
  // that is missing from its group would be offered in Plan mode.
  const grouped = new Set(WRITE_TOOL_GROUPS.flatMap((group) => TOOL_GROUPS[group]));
  for (const name of [...WORKSPACE_WRITE_TOOL_NAMES, ...GITHUB_WRITE_TOOL_NAMES]) {
    assert.ok(grouped.has(name), `${name} is a write but is in no write group`);
    assert.equal(isGithubWriteTool(name) || name.startsWith('workspace_'), true);
  }
  // And nothing in a write group is a read.
  for (const name of grouped) {
    assert.match(name, /_(write|edit|delete|commit)_file$/, `${name} looks like a read but is in a write group`);
  }
});

test('chat mode is research: reads everywhere, and no way to change anything', () => {
  const names = namesFor('chat');
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('web_fetch'));
  assert.ok(names.includes('workspace_read_file'));
  assert.ok(names.includes('workspace_search_files'));
  assert.ok(names.includes('github_read_file'));
  assert.ok(names.includes('github_search_code'));
  assert.ok(names.includes('github_list_commits'));
  // Nothing that writes, plans, or goes shopping for skills.
  for (const name of [...WORKSPACE_WRITE_TOOL_NAMES, ...GITHUB_WRITE_TOOL_NAMES]) {
    assert.equal(names.includes(name), false, name + ' must not be offered in Chat');
  }
  assert.equal(names.includes('task_add'), false, 'the todo list is a planning tool');
  assert.equal(names.includes('use_skill'), false);
});

test('plan mode adds the task list and nothing else that changes', () => {
  const names = namesFor('plan');
  assert.deepEqual(names.filter((n) => n.startsWith('task_')).sort(), ['task_add', 'task_list', 'task_update']);
  assert.ok(names.includes('use_skill'), 'the plan may load the method it needs');
  assert.ok(names.includes('github_search_code'));
  for (const name of [...WORKSPACE_WRITE_TOOL_NAMES, ...GITHUB_WRITE_TOOL_NAMES]) {
    assert.equal(names.includes(name), false, name + ' must not be offered in Plan');
  }
});

test('build mode is the only one with the tools to change anything', () => {
  const names = namesFor('build');
  for (const name of [...WORKSPACE_WRITE_TOOL_NAMES, ...GITHUB_WRITE_TOOL_NAMES]) {
    assert.ok(names.includes(name), name + ' must be offered in Build');
  }
  assert.equal(names.length, ALL_TOOLS.length, 'Build is the whole surface');
});

test('a tool no group names is offered everywhere, so a new read cannot be locked out', () => {
  // The asymmetry is deliberate: an unknown name is assumed to be a read, and
  // every write is listed. A read tool added later must not silently vanish from
  // two modes, while a write added later is still caught by the write groups and
  // by the approval dialog every write already goes through.
  assert.deepEqual(toolGroupsForName('some_future_tool'), []);
  for (const mode of ['chat', 'plan', 'build']) {
    assert.equal(modeAllowsTool(mode, 'some_future_tool'), true);
    assert.equal(modeAllowsTool(mode, ''), true);
    assert.equal(modeAllowsTool(mode, undefined), true);
  }
});

test('an unnamed mode falls back to the default rather than being wide open', () => {
  // MODE_TOOL_GROUPS[mode] with a bogus mode must not read as "no restrictions".
  assert.equal(modeAllowsTool('yolo', 'github_commit_file'), false);
  assert.equal(modeAllowsTool('yolo', 'web_search'), true);
});

test('a write that arrives outside Build is refused, and nothing runs', () => {
  for (const mode of ['chat', 'plan']) {
    for (const name of [...WORKSPACE_WRITE_TOOL_NAMES, ...GITHUB_WRITE_TOOL_NAMES]) {
      assert.equal(modeBlocksWrite(mode, name), true, `${mode}/${name}`);
      const refusal = modeWriteRefusal(mode, name);
      assert.match(refusal, /read-only/);
      assert.match(refusal, /Nothing changed/);
      assert.ok(refusal.includes(name));
    }
    // The task list is not a write to the world: a plan is a note to self, and
    // Plan mode is exactly where it is written.
    assert.equal(modeBlocksWrite(mode, 'task_add'), false);
    assert.equal(modeBlocksWrite(mode, 'workspace_read_file'), false);
  }
  assert.equal(modeBlocksWrite('build', 'github_commit_file'), false);
});

test('the refusal says where the work goes instead, in the mode\u2019s own words', () => {
  assert.match(modeWriteRefusal('plan', 'github_commit_file'), /switch to Build mode/);
  assert.match(modeWriteRefusal('chat', 'github_commit_file'), /Build mode is where it happens/);
  assert.match(modeWriteRefusal('chat', 'github_commit_file'), /^Refused: Chat mode/);
});

test('a tool list full of junk cannot crash a turn', () => {
  assert.deepEqual(toolsForMode('chat', null), []);
  assert.deepEqual(toolsForMode('chat', []), []);
  assert.deepEqual(toolsForMode('chat', [null, {}, { type: 'function' }]), []);
  assert.deepEqual(
    toolsForMode('chat', [{ type: 'function', function: { name: 'web_search' } }]).length,
    1,
  );
});

test('every mode group names a real group', () => {
  for (const [mode, groups] of Object.entries(MODE_TOOL_GROUPS)) {
    for (const group of groups) {
      assert.ok(TOOL_GROUPS[group], `${mode} names an unknown group: ${group}`);
    }
  }
});
