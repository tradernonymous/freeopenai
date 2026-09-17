// The workspace lives in index.html, which has no DOM setup: the tools the model
// calls, the approval they ask for, and the store they write to all live there.
// These tests pull the shipped functions out of the file and run them against
// stubs, so the wiring is exercised as written rather than as described.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWorkspacePath,
  workspaceList,
  workspaceRead,
  workspaceWrite,
  workspaceEdit,
  workspaceDelete,
  workspaceSearch,
  MAX_WORKSPACE_FILE_CHARS,
  MAX_WORKSPACE_SEARCH_MATCHES,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['formatChars', 'runWorkspaceTool'];

function harness({ files = {}, approve = true, capture = null } = {}) {
  const events = [];
  let saves = 0;
  // The store is now per chat: the page reads the active chat's files
  // through activeWorkspace() and writes back through setActiveWorkspace().
  let store = { ...files };
  const deps = {
    // The real rules, not stubs, so this exercises the shipped pairing of the
    // page's wiring with chatlib's decisions.
    workspaceList,
    workspaceRead,
    workspaceWrite,
    workspaceEdit,
    workspaceDelete,
    workspaceSearch,
    MAX_WORKSPACE_SEARCH_MATCHES,
    normalizeWorkspacePath,
    // The browser workspace is under test here; the server-backed path has its
    // own route tests (workspace-files.test.js).
    useServerWorkspace: () => false,
    runServerWorkspaceTool: async () => 'unexpected: server workspace',
    // Mirrors the page's contract: setActiveWorkspace persists the store.
    activeWorkspace: () => store,
    setActiveWorkspace: (next) => { store = next; deps.saveWorkspaceFiles(); },
    askWorkspaceConfirm: async (text) => {
      if (capture) capture.push(text);
      return approve;
    },
    saveWorkspaceFiles: () => { saves += 1; },
    showStatus: (kind, text) => events.push(kind + ': ' + text),
  };
  const loaded = loadFromIndex(NAMES, deps);
  return {
    deps,
    call: (name, args) => loaded.runWorkspaceTool(name, args),
    files: () => store,
    saves: () => saves,
    events,
  };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('the sandbox guard refuses a run that is missing a page-scope name', () => {
  // Proves the guard is load-bearing: a missing dep throws a ReferenceError
  // that the caller could otherwise mistake for an ordinary result.
  const thin = { workspaceList, workspaceRead, workspaceWrite, normalizeWorkspacePath };
  assert.throws(() => assertSandboxCovers(NAMES, thin), /missing from the sandbox/);
});

test('listing an empty workspace says so rather than returning nothing', async () => {
  assert.equal(await harness({}).call('workspace_list_files', {}), 'The workspace is empty.');
  assert.equal(await harness({}).call('workspace_list_files', { path: 'notes' }), 'No files under "notes".');
});

test('listing names folders and file sizes so a choice needs no extra read', async () => {
  const h = harness({ files: { 'todo.md': 'abc', 'notes/one.md': 'x'.repeat(1200) } });
  const text = await h.call('workspace_list_files', {});
  // Folders first, then files by name, and a folder shows no size of its own.
  assert.equal(text, 'notes/\ntodo.md (3 characters)');
  // The folder itself is listed at the root, and its contents one level down.
  assert.equal(await h.call('workspace_list_files', { path: 'notes' }), 'notes/one.md (1.2k characters)');
});

test('reading a missing file points at what does exist', async () => {
  const text = await harness({ files: { 'a.md': 'x' } }).call('workspace_read_file', { path: 'b.md' });
  assert.match(text, /^Error: No file at "b\.md"/);
  assert.ok(text.includes('a.md'));
});

test('reading returns the stored text unchanged', async () => {
  const content = '# title\n\n  indented\n';
  const h = harness({ files: { 'notes/a.md': content } });
  assert.equal(await h.call('workspace_read_file', { path: 'notes/a.md' }), content);
});

test('an approved write is saved, and told back with its size', async () => {
  const asked = [];
  const h = harness({ approve: true, capture: asked });
  const reply = await h.call('workspace_write_file', { path: 'notes/todo.md', content: 'hello' });
  assert.equal(h.files()['notes/todo.md'], 'hello');
  assert.equal(h.saves(), 1);
  assert.match(reply, /Wrote "notes\/todo\.md" \(5 characters\), 1 file\(s\)/);
  // The dialog states the path and the size, not a vague description.
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Create "notes\/todo\.md" in the workspace \(5 characters\)/);
  assert.match(asked[0], /this browser only/);
});

test('replacing an existing file is announced as a replace', async () => {
  const asked = [];
  const h = harness({ files: { 'a.md': 'old' }, capture: asked });
  await h.call('workspace_write_file', { path: 'a.md', content: 'new' });
  assert.match(asked[0], /^Replace "a\.md"/);
  assert.equal(h.files()['a.md'], 'new');
});

test('a declined write changes nothing and is not saved', async () => {
  const h = harness({ files: { 'a.md': 'old' }, approve: false });
  const reply = await h.call('workspace_write_file', { path: 'a.md', content: 'new' });
  assert.match(reply, /user declined/);
  assert.equal(h.files()['a.md'], 'old');
  assert.equal(h.saves(), 0);
});

test('a path that could escape the workspace is refused before the user is asked', async () => {
  for (const path of ['../secrets.md', '/etc/passwd', 'a/../../b.md']) {
    const asked = [];
    const h = harness({ files: { 'safe.md': 'x' }, capture: asked });
    const reply = await h.call('workspace_write_file', { path, content: 'nope' });
    assert.match(reply, /^Error: Invalid file path\./, `${path} must be refused`);
    // Refusing and then asking for permission would be incoherent, and the
    // dialog would be the only place the user ever saw the bad path.
    assert.equal(asked.length, 0, `${path} must not reach the user`);
    assert.equal(h.saves(), 0);
    assert.deepEqual(h.files(), { 'safe.md': 'x' });
  }
});

test('a write over the size cap is refused before the user is asked', async () => {
  const asked = [];
  const h = harness({ capture: asked });
  const reply = await h.call('workspace_write_file', {
    path: 'big.md',
    content: 'x'.repeat(MAX_WORKSPACE_FILE_CHARS + 1),
  });
  assert.match(reply, /^Error: That file is/);
  assert.equal(asked.length, 0);
  assert.equal(h.saves(), 0);
  assert.deepEqual(h.files(), {});
});

test('a read is not held up by an approval and never saves', async () => {
  const asked = [];
  const h = harness({ files: { 'a.md': 'x' }, capture: asked });
  await h.call('workspace_read_file', { path: 'a.md' });
  await h.call('workspace_list_files', {});
  assert.equal(asked.length, 0);
  assert.equal(h.saves(), 0);
});

test('an unknown workspace tool is an error, not a silent success', async () => {
  assert.equal(await harness({}).call('workspace_rm_rf', {}), 'Error: unknown tool workspace_rm_rf');
});

// ---- the tools a coding agent actually needs most --------------------------

test('a search answers with paths and line numbers, not a wall of text', async () => {
  const h = harness({ files: { 'src/a.js': 'const x = 1;\n// TODO: rename\n', 'src/b.js': 'nothing here\n' } });
  assert.equal(await h.call('workspace_search_files', { query: 'todo' }), 'src/a.js:2: // TODO: rename');
  // The line number is the point: without it the answer is "it is in there",
  // which costs a full read to act on.
  assert.equal(await h.call('workspace_search_files', { query: 'rename', path: 'src' }), 'src/a.js:2: // TODO: rename');
  assert.equal(await h.call('workspace_search_files', { query: 'goldfish' }), 'No match anywhere in the workspace.');
  assert.equal(await h.call('workspace_search_files', { query: 'x', path: 'nope' }), 'No match in "nope".');
  // And no user is asked about a read.
  assert.equal(h.saves(), 0);
});

test('a search is capped, and says when it stopped early', async () => {
  const many = Array.from({ length: MAX_WORKSPACE_SEARCH_MATCHES + 10 }, (_, i) => 'hit ' + i).join('\n');
  const text = await harness({ files: { 'a.txt': many } }).call('workspace_search_files', { query: 'hit' });
  assert.equal(text.split('\n').length, MAX_WORKSPACE_SEARCH_MATCHES + 1);
  assert.match(text, new RegExp('stopped at ' + MAX_WORKSPACE_SEARCH_MATCHES + ' matches'));
});

test('an edit that cannot find its target says so instead of writing anyway', async () => {
  const asked = [];
  const h = harness({ files: { 'a.md': 'hello world' }, capture: asked });
  const reply = await h.call('workspace_edit_file', { path: 'a.md', old_text: 'goodbye', new_text: 'hi' });
  assert.match(reply, /^Error: old_text does not appear/);
  // Refusing and then asking permission would be incoherent, and the file would
  // be the only place the user saw the mistake.
  assert.equal(asked.length, 0);
  assert.equal(h.files()['a.md'], 'hello world');
  assert.equal(h.saves(), 0);
});

test('an ambiguous edit is refused with the count rather than guessed at', async () => {
  const asked = [];
  const h = harness({ files: { 'a.md': 'x\nx\n' }, capture: asked });
  const reply = await h.call('workspace_edit_file', { path: 'a.md', old_text: 'x', new_text: 'y' });
  assert.match(reply, /appears 2 times/);
  assert.match(reply, /all: true/);
  assert.equal(asked.length, 0, 'a replacement nobody can place is not a question for the user');
});

test('an approved edit reports what it replaced, and an all:true edit reports the count', async () => {
  const asked = [];
  const one = harness({ files: { 'a.md': 'keep\ntarget\nkeep\n' }, capture: asked });
  const reply = await one.call('workspace_edit_file', { path: 'a.md', old_text: 'target', new_text: 'changed' });
  assert.equal(one.files()['a.md'], 'keep\nchanged\nkeep\n');
  assert.match(reply, /Edited "a\.md" \(1 replacement\), 1 file\(s\)/);
  assert.match(asked[0], /1 replacement/);

  const all = harness({ files: { 'a.md': 'x x x' } });
  const many = await all.call('workspace_edit_file', { path: 'a.md', old_text: 'x', new_text: 'y', all: true });
  assert.equal(all.files()['a.md'], 'y y y');
  assert.match(many, /\(3 replacements\)/);
});

test('a declined edit changes nothing and is not saved', async () => {
  const h = harness({ files: { 'a.md': 'old' }, approve: false });
  const reply = await h.call('workspace_edit_file', { path: 'a.md', old_text: 'old', new_text: 'new' });
  assert.match(reply, /user declined/);
  assert.equal(h.files()['a.md'], 'old');
  assert.equal(h.saves(), 0);
});

test('a delete asks first, and only an approved one removes the file', async () => {
  const asked = [];
  const yes = harness({ files: { 'a.md': 'x', 'b.md': 'y' }, capture: asked });
  const reply = await yes.call('workspace_delete_file', { path: 'a.md' });
  assert.deepEqual(Object.keys(yes.files()), ['b.md']);
  assert.equal(yes.saves(), 1);
  assert.match(reply, /Deleted "a\.md", 1 file\(s\) left/);
  assert.match(asked[0], /cannot be undone/);

  const no = harness({ files: { 'a.md': 'x' }, approve: false });
  assert.match(await no.call('workspace_delete_file', { path: 'a.md' }), /user declined/);
  assert.deepEqual(Object.keys(no.files()), ['a.md']);
  assert.equal(no.saves(), 0);
});

test('deleting a file that is not there names what is', async () => {
  const h = harness({ files: { 'a.md': 'x' } });
  const reply = await h.call('workspace_delete_file', { path: 'b.md' });
  assert.match(reply, /^Error: No file at "b\.md"/);
  assert.ok(reply.includes('a.md'));
  assert.equal(h.saves(), 0);
});
