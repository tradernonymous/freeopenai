const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
  isWorkspaceTool,
  isWorkspaceWriteTool,
  normalizeWorkspacePath,
  workspaceList,
  workspaceRead,
  workspaceWrite,
  planToolCalls,
  isConcurrentSafeTool,
  describeToolCall,
  MAX_WORKSPACE_PATH_CHARS,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_FILE_CHARS,
  MAX_WORKSPACE_TOTAL_CHARS,
} = require('../chatlib.js');

test('the workspace tools are well-formed specs with unique names', () => {
  assert.deepEqual(WORKSPACE_TOOL_NAMES, [
    'workspace_list_files',
    'workspace_read_file',
    'workspace_write_file',
  ]);
  assert.deepEqual(WORKSPACE_TOOLS.map((t) => t.type), ['function', 'function', 'function']);
  for (const tool of WORKSPACE_TOOLS) {
    assert.equal(typeof tool.function.name, 'string');
    // The description is what decides whether the model reaches for the tool at
    // all, so it has to say what the workspace is.
    assert.ok(tool.function.description.length > 40, `${tool.function.name} needs a real description`);
    assert.equal(tool.function.parameters.type, 'object');
    for (const required of tool.function.parameters.required) {
      assert.ok(required in tool.function.parameters.properties, `${tool.function.name} requires undefined "${required}"`);
    }
  }
  assert.ok(isWorkspaceTool('workspace_write_file'));
  assert.ok(!isWorkspaceTool('github_read_file'));
  assert.ok(!isWorkspaceTool(undefined));
});

test('a path that could leave the workspace is refused rather than rewritten', () => {
  // Absolute paths and drive letters, in either slash direction.
  for (const bad of ['/etc/passwd', 'C:/Windows', 'c:\\Users', '\\\\server\\share']) {
    assert.equal(normalizeWorkspacePath(bad), null, `${bad} must be refused`);
  }
  // Traversal, wherever it appears -- including one that would resolve back
  // inside the root, since accepting that teaches the model it can try.
  for (const bad of ['..', '../x', 'notes/../../x', 'notes/..', 'a/b/../../../c']) {
    assert.equal(normalizeWorkspacePath(bad), null, `${bad} must be refused`);
  }
  // Control characters, the null byte included, are part of no real path.
  assert.equal(normalizeWorkspacePath('a\u0000b'), null);
  assert.equal(normalizeWorkspacePath('a\nb'), null);
  assert.equal(normalizeWorkspacePath(''), null);
  assert.equal(normalizeWorkspacePath('   '), null);
  assert.equal(normalizeWorkspacePath(null), null);
  assert.equal(normalizeWorkspacePath('x'.repeat(MAX_WORKSPACE_PATH_CHARS + 1)), null);
});

test('ordinary paths are normalised instead of refused', () => {
  assert.equal(normalizeWorkspacePath('notes/todo.md'), 'notes/todo.md');
  assert.equal(normalizeWorkspacePath('  notes/todo.md  '), 'notes/todo.md');
  assert.equal(normalizeWorkspacePath('notes//todo.md'), 'notes/todo.md');
  assert.equal(normalizeWorkspacePath('./notes/./todo.md'), 'notes/todo.md');
  assert.equal(normalizeWorkspacePath('notes\\todo.md'), 'notes/todo.md');
  assert.equal(normalizeWorkspacePath('todo.md'), 'todo.md');
});

test('listing derives folders from the paths, folders first', () => {
  const files = { 'todo.md': 'a', 'notes/one.md': 'bb', 'notes/two.md': 'ccc', 'zzz.md': 'd' };
  const root = workspaceList(files);
  assert.deepEqual(
    root.entries.map((e) => e.name + ':' + e.type),
    ['notes:folder', 'todo.md:file', 'zzz.md:file'],
  );
  assert.equal(root.totalFiles, 4);
  // Sizes come with the listing, so a choice can be made without reading both.
  assert.equal(root.entries.find((e) => e.name === 'todo.md').chars, 1);

  const notes = workspaceList(files, 'notes');
  assert.deepEqual(notes.entries.map((e) => e.name), ['one.md', 'two.md']);
  assert.equal(notes.path, 'notes');
  // A file inside the folder is not a child of a sibling folder with a similar
  // prefix: 'notes-two/' must not appear under 'notes'.
  const decoy = workspaceList({ 'notes-two/x.md': 'a', 'notes/y.md': 'b' }, 'notes');
  assert.deepEqual(decoy.entries.map((e) => e.name), ['y.md']);
});

test('a name that is both a file and a folder is reported as the folder', () => {
  const listed = workspaceList({ thing: 'text', 'thing/deep.md': 'text' });
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].type, 'folder');
});

test('listing an empty or invalid folder explains itself', () => {
  const empty = workspaceList({});
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.totalFiles, 0);
  assert.ok(workspaceList({}, 'nope').entries.length === 0);
  assert.match(workspaceList({}, '/etc').error, /Invalid folder path/);
  assert.match(workspaceList({}, '../x').error, /Invalid folder path/);
});

test('reading a file that is not there names what is', () => {
  const missing = workspaceRead({ 'todo.md': 'x' }, 'notes/todo.md');
  assert.match(missing.error, /No file at "notes\/todo\.md"/);
  assert.match(missing.error, /todo\.md/);
  const inEmpty = workspaceRead({}, 'todo.md');
  assert.match(inEmpty.error, /workspace is empty/);
  assert.equal(workspaceRead({ 'todo.md': 'x' }, '/etc/passwd').error, 'Invalid file path.');
});

test('reading returns the exact text that was stored', () => {
  const store = { 'notes/todo.md': '# hi\n\n- item\n' };
  const read = workspaceRead(store, 'notes/todo.md');
  assert.equal(read.path, 'notes/todo.md');
  assert.equal(read.content, '# hi\n\n- item\n');
  // The same file reached by a differently spelled path.
  assert.equal(workspaceRead(store, 'notes//./todo.md').content, '# hi\n\n- item\n');
});

test('writing returns a new store and leaves the old one alone', () => {
  const before = { 'todo.md': 'old' };
  const written = workspaceWrite(before, 'todo.md', 'new');
  assert.equal(written.files['todo.md'], 'new');
  assert.equal(written.created, false);
  // The input is untouched, so a refused or declined write cannot leak out.
  assert.deepEqual(before, { 'todo.md': 'old' });

  const created = workspaceWrite(before, 'notes/new.md', 'hello');
  assert.equal(created.created, true);
  assert.equal(created.chars, 5);
  assert.deepEqual(Object.keys(created.files).sort(), ['notes/new.md', 'todo.md']);
  assert.deepEqual(before, { 'todo.md': 'old' });
});

test('a write that would exceed a cap is refused, and changes nothing', () => {
  const full = {};
  for (let i = 0; i < MAX_WORKSPACE_FILES; i++) full['f' + i + '.md'] = 'x';
  const tooMany = workspaceWrite(full, 'one-more.md', 'x');
  assert.match(tooMany.error, new RegExp('already holds ' + MAX_WORKSPACE_FILES));
  // Rewriting an existing file is still allowed at the cap: only new files hit it.
  assert.equal(workspaceWrite(full, 'f0.md', 'yy').chars, 2);

  const tooBig = workspaceWrite({}, 'big.md', 'x'.repeat(MAX_WORKSPACE_FILE_CHARS + 1));
  assert.match(tooBig.error, /the limit is/);

  const nearFull = { 'a.md': 'x'.repeat(MAX_WORKSPACE_TOTAL_CHARS - 10) };
  const wouldOverflow = workspaceWrite(nearFull, 'b.md', 'x'.repeat(50));
  assert.match(wouldOverflow.error, /the limit is/);
  assert.deepEqual(Object.keys(nearFull), ['a.md']);

  // A refusal returns no store at all, so a caller cannot save a partial one.
  for (const bad of [tooMany, tooBig, wouldOverflow]) {
    assert.equal(bad.files, undefined);
    assert.equal(typeof bad.error, 'string');
  }
});

test('writes are serial while workspace reads may overlap', () => {
  // This is the pairing step 1 relies on: the write is absent from the safe set,
  // so it can never share a wave with anything else.
  assert.ok(isConcurrentSafeTool('workspace_read_file'));
  assert.ok(isConcurrentSafeTool('workspace_list_files'));
  assert.ok(!isConcurrentSafeTool('workspace_write_file'));
  assert.ok(isWorkspaceWriteTool('workspace_write_file'));
  assert.ok(!isWorkspaceWriteTool('workspace_read_file'));

  const plan = planToolCalls([
    { function: { name: 'workspace_read_file' } },
    { function: { name: 'workspace_write_file' } },
    { function: { name: 'workspace_list_files' } },
  ]);
  assert.deepEqual(plan.concurrent, [0, 2]);
  assert.deepEqual(plan.serial, [1]);
});

test('a workspace step names the file it is touching', () => {
  assert.equal(describeToolCall('workspace_write_file', { path: 'a.md' }), 'Writing "a.md" to the workspace');
  assert.equal(describeToolCall('workspace_read_file', { path: 'a.md' }), 'Reading "a.md" from the workspace');
  assert.equal(describeToolCall('workspace_list_files', {}), 'Listing the workspace files');
  assert.equal(describeToolCall('workspace_list_files', { path: 'notes' }), 'Listing the workspace folder "notes"');
});
