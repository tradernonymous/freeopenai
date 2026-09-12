// What a read answered was remembered only for the rest of the question that
// paid for it, so the follow-up to an answer about a file opened by reading that
// file again -- even when the earlier answer was still sitting in the history,
// and certainly once history trimming had dropped it.
//
// Remembering it across questions is only safe with a freshness rule, and these
// are the rules: a write forgets what it touched, a read expires, and a reused
// answer says how old it is. The first one is also a bug fix in its own right --
// without it, a model that wrote a file and read it back was handed the text
// from before its own write and would conclude the write had failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createReadMemory,
  describeRememberedAge,
  isConcurrentSafeTool,
  isMutatingTool,
  isRememberableRead,
  memoSubject,
  memoSubjectInvalidatedByWrite,
  toolCallKey,
  toolCallRecords,
  REMEMBERED_READ_TTL_MS,
} = require('../chatlib.js');

const workspaceRead = (path) => toolCallKey('workspace_read_file', { path });

test('only reads are remembered, and only ones that read something outside the app', () => {
  for (const name of ['workspace_read_file', 'workspace_list_files', 'github_read_file', 'github_list_files', 'github_list_repos', 'web_search', 'web_fetch']) {
    assert.equal(isRememberableRead(name), true, name + ' is a read');
  }
  // A write is not a read: remembering one would let the app claim work it never
  // did in this turn.
  assert.equal(isRememberableRead('workspace_write_file'), false);
  assert.equal(isRememberableRead('github_commit_file'), false);
  // Nor is the app's own scratch state, which costs nothing to ask about again.
  assert.equal(isRememberableRead('task_list'), false);
  assert.equal(isRememberableRead('use_skill'), false);
  assert.equal(isRememberableRead(''), false);
  assert.equal(isRememberableRead(undefined), false);
});

test('the tools that change something are the two writers, and neither runs in parallel', () => {
  assert.equal(isMutatingTool('workspace_write_file'), true);
  assert.equal(isMutatingTool('github_commit_file'), true);
  assert.equal(isMutatingTool('workspace_read_file'), false);
  assert.equal(isMutatingTool('task_write'), false);
  // The two rules have to agree where they overlap: anything that writes is never
  // allowed to run beside another call.
  for (const name of ['workspace_write_file', 'github_commit_file']) {
    assert.equal(isConcurrentSafeTool(name), false);
  }
});

test('an answer knows the place it came from, and a workspace path is not a repo path', () => {
  assert.equal(memoSubject('workspace_read_file', { path: 'notes/a.md' }), 'workspace/notes/a.md');
  // A listing of the whole scratch space is the root, so a write anywhere below
  // it still matches -- otherwise a folder listing read before a file appeared in
  // it would be served back as current.
  assert.equal(memoSubject('workspace_list_files', {}), 'workspace');
  assert.equal(memoSubject('workspace_read_file', { path: '/notes/a.md/' }), 'workspace/notes/a.md');
  // Repo-scoped, and case-folded: the same repository spelled two ways is the
  // same repository, so a commit under one spelling forgets a read under the other.
  assert.equal(memoSubject('github_read_file', { repo: 'o/r', path: 'src/index.js' }), 'github/o/r/src/index.js');
  assert.equal(memoSubject('github_read_file', { repo: 'O/R', path: 'src/index.js' }), 'github/o/r/src/index.js');
  assert.equal(memoSubject('github_list_repos', {}), 'github');
  assert.equal(memoSubject('github_commit_file', { repo: 'o/r', path: 'a.md' }), 'github/o/r/a.md');
  // Identically-spelled paths in the two families are still different places.
  assert.notEqual(
    memoSubject('workspace_read_file', { path: 'o/r/a.md' }),
    memoSubject('github_read_file', { repo: 'o/r', path: 'a.md' })
  );
  // A search, or a tool this file has not been taught, is about no one place.
  assert.equal(memoSubject('web_search', { query: 'x' }), '');
  assert.equal(memoSubject('use_skill', { name: 'x' }), '');
});

test('a write invalidates the path it touched and any listing above it, and nothing else', () => {
  assert.equal(memoSubjectInvalidatedByWrite('workspace/notes/a.md', 'workspace/notes/a.md'), true);
  // The folder listing is the root of the written path, so it is invalidated too.
  assert.equal(memoSubjectInvalidatedByWrite('workspace/notes', 'workspace/notes/a.md'), true);
  assert.equal(memoSubjectInvalidatedByWrite('workspace', 'workspace/notes/a.md'), true);
  assert.equal(memoSubjectInvalidatedByWrite('workspace/other.md', 'workspace/notes/a.md'), false);
  // A sibling that merely starts with the same characters is a different file.
  assert.equal(memoSubjectInvalidatedByWrite('workspace/notes/a.md', 'workspace/notes/a.md.bak'), false);
  // A search was not made stale by a file being written.
  assert.equal(memoSubjectInvalidatedByWrite('', 'workspace/notes/a.md'), false);
  // A write the app cannot place may have changed any file, so every placed
  // answer goes -- but an unplaced one still does not.
  assert.equal(memoSubjectInvalidatedByWrite('workspace/notes/a.md', ''), true);
  assert.equal(memoSubjectInvalidatedByWrite('', ''), false);
});

test('a remembered answer says how old it is', () => {
  assert.equal(describeRememberedAge(0), 'a moment ago');
  assert.equal(describeRememberedAge(44 * 1000), 'a moment ago');
  assert.equal(describeRememberedAge(60 * 1000), '1 minute ago');
  assert.equal(describeRememberedAge(5 * 60 * 1000), '5 minutes ago');
  assert.equal(describeRememberedAge(60 * 60 * 1000), '1 hour ago');
  assert.equal(describeRememberedAge(90 * 60 * 1000), '2 hours ago');
  // Junk must not render as "NaN minutes ago" in a result the model reads.
  assert.equal(describeRememberedAge(-5), 'a moment ago');
  assert.equal(describeRememberedAge('nonsense'), 'a moment ago');
});

test('a read is recalled for free, with an age note attached', () => {
  let clock = 1000;
  const memory = createReadMemory({ now: () => clock });
  const key = workspaceRead('notes/a.md');
  assert.equal(memory.remember('workspace_read_file', { path: 'notes/a.md' }, key, 'CONTENT'), true);
  clock += 4 * 60 * 1000;
  const recalled = memory.recall(key);
  assert.equal(recalled.result, 'CONTENT');
  assert.equal(recalled.ageMs, 4 * 60 * 1000);
  assert.equal(recalled.note, '[remembered from 4 minutes ago] ');
  // Only reads, and only calls with a key, are kept.
  assert.equal(memory.remember('workspace_write_file', { path: 'x' }, 'k', 'r'), false);
  assert.equal(memory.remember('workspace_read_file', { path: 'x' }, '', 'r'), false);
  assert.equal(memory.recall(''), null);
  assert.equal(memory.recall('nothing was ever stored under this'), null);
});

test('a remembered read expires rather than being quoted as current', () => {
  let clock = 0;
  const memory = createReadMemory({ now: () => clock });
  memory.remember('web_search', { query: 'railway deploy' }, 'k', 'RESULTS');
  clock = REMEMBERED_READ_TTL_MS;
  assert.equal(memory.recall('k').result, 'RESULTS', 'still inside the window');
  clock = REMEMBERED_READ_TTL_MS + 1;
  assert.equal(memory.recall('k'), null, 'and dropped the moment it is out of date');
  // Dropped for good, not just hidden from this caller.
  assert.equal(memory.size(), 0);
});

test('a write forgets what it touched, here and in the question memo', () => {
  const memory = createReadMemory();
  const questionMemo = new Map();
  const writeKey = toolCallKey('workspace_write_file', { path: 'notes/a.md', content: 'new' });
  const doomedKey = workspaceRead('notes/a.md');
  const listingKey = toolCallKey('workspace_list_files', { path: 'notes' });
  const keptKey = workspaceRead('notes/b.md');
  const elsewhereKey = workspaceRead('src/app.js');
  memory.remember('workspace_read_file', { path: 'notes/a.md' }, doomedKey, 'OLD');
  memory.remember('workspace_list_files', { path: 'notes' }, listingKey, 'OLD LISTING');
  memory.remember('workspace_read_file', { path: 'notes/b.md' }, keptKey, 'B');
  memory.remember('workspace_read_file', { path: 'src/app.js' }, elsewhereKey, 'APP');
  for (const key of [doomedKey, listingKey, keptKey, elsewhereKey]) questionMemo.set(key, 'stale copy');
  questionMemo.set(writeKey, 'WROTE');

  // Recording the write is the whole interface: it is not remembered, and what it
  // made wrong stops being remembered.
  assert.equal(memory.record('workspace_write_file', { path: 'notes/a.md', content: 'new' }, writeKey, 'WROTE', questionMemo), false);
  assert.equal(memory.recall(doomedKey), null, 'the file it wrote is forgotten');
  assert.equal(memory.recall(listingKey), null, 'and so is the listing that no longer describes it');
  assert.equal(memory.recall(keptKey).result, 'B', 'a sibling file is untouched');
  assert.equal(memory.recall(elsewhereKey).result, 'APP', 'and so is a file nowhere near it');
  assert.equal(questionMemo.has(doomedKey), false, 'the question memo holds no stale copy');
  assert.equal(questionMemo.has(listingKey), false);
  // The write itself stays on record for the question: the same commit asked for
  // twice must still run once, and forgetting it here would be that guard's hole.
  assert.equal(questionMemo.get(writeKey), 'WROTE');
});

test('a read is remembered only from the tool that produced it', () => {
  const memory = createReadMemory();
  const key = workspaceRead('notes/a.md');
  assert.equal(memory.record('workspace_read_file', { path: 'notes/a.md' }, key, 'CONTENT'), true);
  assert.equal(memory.size(), 1);
  // Recording a non-read records nothing, and clears nothing either.
  assert.equal(memory.record('task_list', {}, 'task_list:{}', 'TASKS'), false);
  assert.equal(memory.recall(key).result, 'CONTENT');
});

test('a restored turn hands back what each answer was about', () => {
  const convo = [
    { role: 'user', content: 'read my readme' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'github_read_file', arguments: JSON.stringify({ repo: 'o/r', path: 'README.md' }) } }] },
    { role: 'tool', tool_call_id: 'a', content: 'RAN' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'b', function: { name: 'web_search', arguments: JSON.stringify({ query: 'x' }) } }] },
    { role: 'tool', tool_call_id: 'b', content: 'SEARCHED' },
  ];
  const records = toolCallRecords(convo);
  assert.deepEqual(records.map((r) => [r.name, r.result]), [['github_read_file', 'RAN'], ['web_search', 'SEARCHED']]);
  // The arguments come back as real values, which is the point: a resume can
  // remember a read with a subject a later write can be compared against.
  assert.equal(memoSubject(records[0].name, records[0].args), 'github/o/r/README.md');
  // A result with no call to match is not a record.
  assert.deepEqual(toolCallRecords([{ role: 'tool', tool_call_id: 'zzz', content: 'orphan' }]), []);
  assert.deepEqual(toolCallRecords(null), []);
});
