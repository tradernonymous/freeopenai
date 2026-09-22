// NEURA-056: project-scout maps the open folder once and answers "where is X?"
// from the map.
//
// The whole point is context economy, so the properties worth pinning are the
// boring ones: the walk is BOUNDED (dependency folders are never entered, a
// binary is never read, a big file is listed but not opened, and the caps stop
// it), the map is HONEST (regex-level symbols, and it says so), the answers are
// PATHS AND LINE NUMBERS rather than contents, and a map that no longer matches
// the folder says it is stale instead of answering confidently from an old one.
//
// Every test runs over a fake tree: the lister and the reader are arguments, so
// none of this touches a filesystem.
const test = require('node:test');
const assert = require('node:assert/strict');

const scout = require('../desktop/src/project-scout.js');
const agents = require('../desktop/src/agents.js');

// ---- a fake folder --------------------------------------------------------

/**
 * `files` is { 'rel/path': text | { text, size, mtime, binary } }. Directories
 * are implied by the paths, which is how a real lister sees them too.
 */
function fakeTree(files) {
  const meta = {};
  for (const [path, value] of Object.entries(files)) {
    const record = typeof value === 'string' ? { text: value } : { ...value };
    if (typeof record.text !== 'string') record.text = '';
    if (typeof record.size !== 'number') record.size = record.text.length;
    if (typeof record.mtime !== 'number') record.mtime = 1000;
    meta[path] = record;
  }
  const reads = [];
  const lists = [];

  const listFiles = async (dir) => {
    lists.push(dir);
    const prefix = dir ? `${dir}/` : '';
    const dirs = new Set();
    const entries = [];
    for (const path of Object.keys(meta)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ name: rest, dir: false, size: meta[path].size, mtime: meta[path].mtime });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    for (const name of dirs) entries.push({ name, dir: true, size: 0 });
    return { entries };
  };

  const readFile = async (path) => {
    reads.push(path);
    const record = meta[path];
    if (!record) throw new Error(`no such file: ${path}`);
    if (record.binary) return { text: '', binary: true, bytes: record.size };
    return { text: record.text, binary: false, bytes: record.size };
  };

  return { meta, reads, lists, io: { listFiles, readFile } };
}

const SAMPLE = {
  'package.json': '{"name":"sample","main":"src/index.js"}',
  'README.md': '# Sample\n\nA sample.\n\n## Approval gate\n\nHow writes are approved.\n',
  'src/index.js': 'const { approve } = require("./approval");\n\nexport function boot() {\n  return approve;\n}\n',
  'src/approval.js': [
    '// The approval gate.',
    'export const GATE_KEY = "gate";',
    '',
    'export function approve(request) {',
    '  return !!request;',
    '}',
    '',
    'class ApprovalQueue {',
    '  push() {}',
    '}',
  ].join('\n'),
  'src/deep/nested/util.py': 'def helper(value):\n    return value\n\n\nclass Helper:\n    pass\n',
  'src-tauri/src/main.rs': 'pub fn main() {}\n\npub struct Shell {}\n',
  'assets/logo.png': { text: 'PNG-BYTES', binary: true, size: 4096 },
  'node_modules/left-pad/index.js': 'export function leftPad() {}\n',
  'dist/bundle.js': 'export function bundled() {}\n',
  '.git/config': '[core]\n',
};

// ---- building -------------------------------------------------------------

test('the index is built once and knows the folder: files, areas and entry points', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io, { now: 5 });

  assert.equal(index.version, scout.VERSION);
  assert.equal(index.root, 'C:/repo');
  assert.equal(index.builtAt, 5);
  assert.equal(index.parser, 'regex');
  assert.match(index.note, /No parser/i);

  const paths = index.files.map((f) => f.path);
  assert.ok(paths.includes('src/approval.js'));
  assert.ok(paths.includes('src/deep/nested/util.py'));
  assert.ok(paths.includes('src-tauri/src/main.rs'));

  // Entry points are named, with a reason, shallowest first.
  const entry = index.entries.find((e) => e.path === 'package.json');
  assert.ok(entry, 'package.json is an entry point');
  assert.match(entry.why, /npm/i);
  assert.ok(index.entries.some((e) => e.path === 'README.md'));
  assert.ok(index.entries.some((e) => e.path === 'src/index.js'));

  // Areas say where each part of the repo lives.
  const src = index.areas.find((a) => a.dir === 'src');
  assert.ok(src, 'src is an area');
  assert.ok(src.files >= 2);
  assert.ok(src.languages.includes('javascript'));
  assert.ok(index.areas.some((a) => a.dir === '.'), 'the root is an area too');
});

test('dependency and build folders are never entered, and binaries are never read', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);
  const paths = index.files.map((f) => f.path);

  for (const skipped of ['node_modules/left-pad/index.js', 'dist/bundle.js', '.git/config']) {
    assert.ok(!paths.includes(skipped), `${skipped} must not be indexed`);
  }
  assert.ok(!tree.lists.includes('node_modules'), 'node_modules is never listed');
  assert.ok(!tree.lists.includes('dist'), 'dist is never listed');
  assert.ok(index.stats.skippedDirs >= 3);

  // The image is listed so the map is complete, but its bytes are never read.
  const logo = index.files.find((f) => f.path === 'assets/logo.png');
  assert.ok(logo, 'the image is still in the map');
  assert.equal(logo.read, false);
  assert.equal(logo.why, 'binary');
  assert.deepEqual(logo.symbols, []);
  assert.ok(!tree.reads.includes('assets/logo.png'), 'no binary is ever read');

  assert.equal(scout.isBinaryPath('a/b.png'), true);
  assert.equal(scout.isBinaryPath('a/b.js'), false);
  assert.equal(scout.shouldSkipDir('node_modules'), true);
  assert.equal(scout.shouldSkipDir('NODE_MODULES'), true);
  assert.equal(scout.shouldSkipDir('src'), false);
});

// ---- the caps -------------------------------------------------------------

test('a file over the per-file cap is listed but never opened', async () => {
  const tree = fakeTree({
    'small.js': 'export function small() {}\n',
    'huge.js': { text: 'export function huge() {}\n', size: 900000 },
  });
  const index = await scout.buildIndex('C:/repo', tree.io, { maxFileBytes: 1024 });

  const huge = index.files.find((f) => f.path === 'huge.js');
  assert.equal(huge.read, false);
  assert.match(huge.why, /over 1024 bytes/);
  assert.deepEqual(huge.symbols, []);
  assert.equal(tree.reads.includes('huge.js'), false, 'the big file is never read');
  assert.equal(tree.reads.includes('small.js'), true);
  assert.equal(index.stats.skippedTooBig, 1);
  // And the name is still findable, because the file is still on the map.
  assert.ok(scout.query(index, 'huge').matches.some((m) => m.path === 'huge.js'));
});

test('the file-count cap stops the walk and the index admits it is partial', async () => {
  const many = {};
  for (let i = 0; i < 30; i += 1) many[`src/file${i}.js`] = `export function fn${i}() {}\n`;
  const tree = fakeTree(many);
  const index = await scout.buildIndex('C:/repo', tree.io, { maxFiles: 10 });

  assert.equal(index.files.length, 10);
  assert.equal(index.truncated.files, true);
  assert.match(index.truncated.reasons.join(' '), /more than 10 files/);
  assert.equal(index.stats.filesSeen, 30, 'it still counted what it refused to keep');
  // A partial map says so in every answer.
  assert.match(scout.query(index, 'fn1').note, /Partial index/);
  assert.match(scout.describe(index), /Partial:/);
});

test('the total-bytes cap stops reading, and the shipped caps are sane', async () => {
  const many = {};
  for (let i = 0; i < 20; i += 1) many[`src/file${i}.js`] = `export function fn${i}() {}\n`;
  const tree = fakeTree(many);
  const index = await scout.buildIndex('C:/repo', tree.io, { maxTotalBytes: 60 });

  assert.equal(index.files.length, 20, 'every file is still on the map');
  assert.ok(tree.reads.length < 20, 'but not every file was read');
  assert.equal(index.truncated.bytes, true);
  assert.match(index.truncated.reasons.join(' '), /bytes of source/);
  assert.ok(index.files.some((f) => f.why === 'byte cap reached'));
  assert.ok(index.stats.bytesRead <= 60 + 40, 'it stops at the cap, give or take one file');

  assert.equal(scout.MAX_FILES, 4000);
  assert.equal(scout.MAX_TOTAL_BYTES, 8 * 1024 * 1024);
  assert.equal(scout.MAX_FILE_BYTES, 256 * 1024);
  assert.equal(scout.MAX_DEPTH, 12);
  assert.equal(scout.MAX_SYMBOLS_PER_FILE, 40);
});

test('the depth cap stops the walk rather than recursing forever', async () => {
  const tree = fakeTree({
    'a/b/c/d/deep.js': 'export function deep() {}\n',
    'top.js': 'export function top() {}\n',
  });
  const index = await scout.buildIndex('C:/repo', tree.io, { maxDepth: 2 });
  const paths = index.files.map((f) => f.path);
  assert.ok(paths.includes('top.js'));
  assert.ok(!paths.includes('a/b/c/d/deep.js'), 'nothing below the depth cap is indexed');
  assert.equal(index.truncated.depth, true);
});

test('symbols per file are capped so one generated file cannot drown the index', () => {
  const lines = [];
  for (let i = 0; i < 50; i += 1) lines.push(`export function gen${i}() {}`);
  const symbols = scout.extractSymbols(lines.join('\n'), 'gen.js', 5);
  assert.equal(symbols.length, 5);
  assert.equal(symbols[0].name, 'gen0');
  assert.equal(symbols[0].line, 1);
});

// ---- symbols: regex-level, and honest about it ----------------------------

test('symbols are found by regex across languages, with line numbers', () => {
  const js = scout.extractSymbols(SAMPLE['src/approval.js'], 'src/approval.js');
  const gate = js.find((s) => s.name === 'GATE_KEY');
  assert.deepEqual({ kind: gate.kind, line: gate.line, exported: gate.exported }, { kind: 'const', line: 2, exported: true });
  const approve = js.find((s) => s.name === 'approve');
  assert.equal(approve.kind, 'function');
  assert.equal(approve.line, 4);
  assert.equal(approve.exported, true);
  const queue = js.find((s) => s.name === 'ApprovalQueue');
  assert.equal(queue.kind, 'class');
  assert.equal(queue.exported, false, 'a plain class is not an export');

  const py = scout.extractSymbols(SAMPLE['src/deep/nested/util.py'], 'x.py');
  assert.deepEqual(py.map((s) => s.name).sort(), ['Helper', 'helper']);

  const rs = scout.extractSymbols(SAMPLE['src-tauri/src/main.rs'], 'main.rs');
  assert.ok(rs.some((s) => s.name === 'main' && s.kind === 'function' && s.exported));
  assert.ok(rs.some((s) => s.name === 'Shell' && s.kind === 'type'));

  const go = scout.extractSymbols('func Serve(w int) {}\ntype Server struct {}\n', 'main.go');
  assert.ok(go.some((s) => s.name === 'Serve' && s.kind === 'function'));
  assert.ok(go.some((s) => s.name === 'Server' && s.kind === 'type'));

  const md = scout.extractSymbols(SAMPLE['README.md'], 'README.md');
  assert.deepEqual(md.map((s) => s.kind), ['heading', 'heading']);
  assert.equal(md[1].name, 'Approval gate');
  assert.equal(md[1].line, 5);
});

test('it says "no parser" rather than pretending to understand the code', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);
  assert.equal(index.parser, 'regex');
  assert.match(index.note, /no parser/i);
  assert.match(scout.describe(index), /regex/i);
  // A name a regex cannot see is honestly missing, and the miss is explained.
  const dynamic = scout.query(index, 'somethingBuiltAtRuntime');
  assert.equal(dynamic.ok, false);
  assert.match(dynamic.note, /regex-level/);
});

// ---- queries: paths and lines, never contents -----------------------------

test('a query answers with paths and line numbers, and no file contents', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);

  const answer = scout.query(index, 'approve');
  assert.equal(answer.ok, true);
  const top = answer.matches[0];
  assert.equal(top.path, 'src/approval.js');
  assert.equal(top.line, 4);
  assert.equal(top.name, 'approve');
  assert.equal(top.kind, 'function');

  for (const match of answer.matches) {
    assert.deepEqual(
      Object.keys(match).sort(),
      ['exported', 'kind', 'line', 'name', 'path', 'score', 'why'],
      'a match carries no file content',
    );
    assert.ok(typeof match.line === 'number' && match.line >= 1);
  }
  const serialized = JSON.stringify(answer);
  assert.ok(!serialized.includes('return !!request'), 'a query never hands back source text');
});

test('a filename is an answer too, and an unknown name is an honest miss', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);

  const byName = scout.query(index, 'approval.js');
  assert.ok(byName.matches.some((m) => m.path === 'src/approval.js' && m.why === 'filename'));

  const miss = scout.query(index, 'zzzNotHere');
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.matches, []);

  const empty = scout.query(index, '   ');
  assert.equal(empty.ok, false);
  assert.match(empty.note, /Ask for a name/);

  const none = scout.query(null, 'anything');
  assert.equal(none.ok, false);
  assert.match(none.note, /No index/);

  const limited = scout.query(index, 'a', { limit: 2 });
  assert.ok(limited.matches.length <= 2);
});

test('describe is a compact map, not a file dump', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);
  const text = scout.describe(index);
  assert.match(text, /Project index for C:\/repo/);
  assert.match(text, /Entry points:/);
  assert.match(text, /Areas:/);
  assert.ok(!text.includes('return !!request'), 'describe never carries source');
  assert.ok(text.split('\n').length < 30, 'the map stays small enough to keep in a prompt');
  assert.equal(scout.describe(null), 'No project index has been built yet.');
});

// ---- staleness ------------------------------------------------------------

test('an unchanged folder is fresh and costs no file reads to confirm', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);

  const readsBefore = tree.reads.length;
  const fresh = await scout.checkFresh(index, tree.io);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.reason, '');
  assert.equal(fresh.digest, index.digest);
  assert.equal(tree.reads.length, readsBefore, 'the freshness check reads no file');
});

test('an edited, added or removed file makes the index stale, and it says which', async () => {
  const edited = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', edited.io);

  // Edited: same path, different size and mtime.
  const afterEdit = fakeTree({ ...SAMPLE, 'src/approval.js': `${SAMPLE['src/approval.js']}\nexport function deny() {}\n` });
  const staleEdit = await scout.checkFresh(index, afterEdit.io);
  assert.equal(staleEdit.stale, true);
  assert.deepEqual(staleEdit.changed, ['src/approval.js']);
  assert.match(staleEdit.reason, /1 file edited/);

  // Added.
  const afterAdd = fakeTree({ ...SAMPLE, 'src/new.js': 'export function fresh() {}\n' });
  const staleAdd = await scout.checkFresh(index, afterAdd.io);
  assert.equal(staleAdd.stale, true);
  assert.deepEqual(staleAdd.added, ['src/new.js']);
  assert.match(staleAdd.reason, /1 new file/);

  // Removed.
  const shrunk = { ...SAMPLE };
  delete shrunk['src/index.js'];
  const staleGone = await scout.checkFresh(index, fakeTree(shrunk).io);
  assert.equal(staleGone.stale, true);
  assert.deepEqual(staleGone.removed, ['src/index.js']);
  assert.match(staleGone.reason, /1 file gone/);

  // A touched file with the same size is caught by mtime alone.
  const touched = { ...SAMPLE, 'src/index.js': { text: SAMPLE['src/index.js'], mtime: 9999 } };
  const staleTouch = await scout.checkFresh(index, fakeTree(touched).io);
  assert.equal(staleTouch.stale, true);
  assert.deepEqual(staleTouch.changed, ['src/index.js']);

  assert.equal((await scout.checkFresh(null, edited.io)).stale, true);
});

test('a stale index answers as stale rather than from the old map', async () => {
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io);
  const after = fakeTree({ ...SAMPLE, 'src/new.js': 'export function fresh() {}\n' });

  const fresh = await scout.checkFresh(index, after.io);
  const marked = scout.markFresh(index, fresh, 77);
  assert.equal(marked.stale, true);
  assert.match(marked.staleReason, /1 new file/);
  assert.equal(marked.checkedAt, 77);
  assert.equal(index.stale, false, 'markFresh does not mutate the index it was given');

  const answer = scout.query(marked, 'approve');
  assert.equal(answer.stale, true);
  assert.match(answer.staleReason, /1 new file/);
  assert.match(scout.describe(marked), /STALE:/);

  // And re-building clears it.
  const rebuilt = await scout.buildIndex('C:/repo', after.io);
  assert.equal((await scout.checkFresh(rebuilt, after.io)).stale, false);
  assert.ok(rebuilt.files.some((f) => f.path === 'src/new.js'));
});

test('the digest is over path, size and mtime, and is stable', () => {
  const a = [{ path: 'a.js', size: 1, mtime: 2 }, { path: 'b.js', size: 3, mtime: 4 }];
  const b = [{ path: 'b.js', size: 3, mtime: 4 }, { path: 'a.js', size: 1, mtime: 2 }];
  assert.equal(scout.digestOf(a), scout.digestOf(b), 'order does not change the digest');
  assert.notEqual(scout.digestOf(a), scout.digestOf([{ path: 'a.js', size: 2, mtime: 2 }, a[1]]));
  assert.notEqual(scout.digestOf(a), scout.digestOf([{ path: 'a.js', size: 1, mtime: 9 }, a[1]]));
});

// ---- status and storage ---------------------------------------------------

test('status is what the screen shows: none, building, built or stale', async () => {
  assert.equal(scout.status(null).state, 'none');
  assert.equal(scout.status(null).label, 'Not built');
  assert.equal(scout.status(null, true).state, 'building');

  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io, { now: 42 });
  const built = scout.status(index);
  assert.equal(built.state, 'built');
  assert.equal(built.fileCount, index.files.length);
  assert.ok(built.symbolCount > 0);
  assert.equal(built.builtAt, 42);
  assert.equal(built.root, 'C:/repo');

  const stale = scout.status(scout.markFresh(index, { stale: true, reason: '2 files edited' }));
  assert.equal(stale.state, 'stale');
  assert.equal(stale.label, 'Stale');
  assert.match(stale.reason, /2 files edited/);
});

test('the index round-trips through storage and is not reused for another folder', async () => {
  const data = {};
  const store = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
  const tree = fakeTree(SAMPLE);
  const index = await scout.buildIndex('C:/repo', tree.io, { now: 7 });

  assert.equal(scout.load('C:/repo', store), null, 'nothing is stored yet');
  assert.equal(scout.save(index, store), true);
  const loaded = scout.load('C:/repo', store);
  assert.equal(loaded.builtAt, 7);
  assert.equal(loaded.files.length, index.files.length);
  assert.equal(scout.query(loaded, 'approve').matches[0].path, 'src/approval.js');

  assert.equal(scout.load('C:/other', store), null, 'an index for another folder is not this one');

  data[scout.KEY] = '{ not json';
  assert.equal(scout.load('C:/repo', store), null, 'a broken entry is not a crash');
  data[scout.KEY] = JSON.stringify({ version: scout.VERSION + 99, files: [] });
  assert.equal(scout.load('C:/repo', store), null, 'a future version is not read');

  scout.save(index, store);
  assert.equal(scout.clear(store), true);
  assert.equal(scout.load('C:/repo', store), null);
});

// ---- the subagent registration -------------------------------------------

test('project-scout ships as a built-in agent, read-only and validating', () => {
  assert.equal(agents.SCOUT_ID, 'project-scout');
  const scoutAgent = agents.list({ getItem: () => null, setItem: () => {}, removeItem: () => {} })
    .find((a) => a.id === agents.SCOUT_ID);
  assert.ok(scoutAgent, 'the built-in list carries project-scout');
  assert.equal(agents.isBuiltin(agents.SCOUT_ID), true);

  const checked = agents.validate(scoutAgent);
  assert.equal(checked.ok, true, checked.errors.join(' '));

  // Read-only: it maps and answers, it never writes or runs anything.
  assert.deepEqual(scoutAgent.toolNames, ['list_files', 'read_file']);
  for (const forbidden of ['write_file', 'edit_file', 'run_command']) {
    assert.equal(agents.allowsTool(scoutAgent.toolNames, forbidden), false, `${forbidden} must not be offered`);
  }
  assert.equal(agents.allowsTool(scoutAgent.toolNames, 'list_files'), true);

  // It answers with paths and line numbers, and admits it has no parser.
  assert.equal(scoutAgent.outputMode, 'structured');
  assert.deepEqual(scoutAgent.outputSchema.required, ['matches']);
  assert.match(scoutAgent.systemPrompt, /LINE NUMBERS/);
  assert.match(scoutAgent.systemPrompt, /no parser/i);
  assert.match(scoutAgent.systemPrompt, /node_modules/);
  assert.equal(scoutAgent.includeMessageHistory, false);
});

test('the scout definition is data, like every other agent', () => {
  const scoutAgent = agents.BUILTINS.find((a) => a.id === agents.SCOUT_ID);
  assert.equal(agents.codeReason(scoutAgent), '', 'a built-in carries no code');
  const structured = agents.checkStructured('{"matches":[{"path":"src/approval.js","line":4}]}', scoutAgent.outputSchema);
  assert.equal(structured.ok, true, structured.errors.join(' '));
  assert.equal(agents.checkStructured('{"note":"nothing"}', scoutAgent.outputSchema).ok, false);
});
