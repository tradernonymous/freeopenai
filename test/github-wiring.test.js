// The page's GitHub runner, extracted and driven against a stubbed fetch.
//
// The routes have their own tests (github-tools.test.js). This is about the
// wiring between them and the model: that the three new tools call the right
// route with the right arguments, that a delete forgets the cached sha of the
// file it just removed, and -- the one that matters most -- that a tool which
// changes a repository asks the user first, wherever it is added.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeToolCall,
  isGithubWriteTool,
  isGithubTool,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['runGithubTool'];

function harness({ approve = true, answer = {} } = {}) {
  const calls = [];
  const asked = [];
  const deps = {
    // The real rules, so this exercises the shipped pairing of the runner with
    // chatlib's idea of what a write is.
    describeToolCall,
    isGithubWriteTool,
    isGithubTool,
    askGithubConfirm: async (text) => {
      asked.push(text);
      return approve;
    },
    safeJson: async (res) => res.json(),
    accountParam: (args) => (args && args.account ? '&account=' + encodeURIComponent(args.account) : ''),
    shaKey: (args) => args.repo + '/' + args.path,
    githubShaCache: {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      const key = String(url).split('?')[0];
      const body = answer[key] === undefined ? { data: [{ url: 'x' }] } : answer[key];
      const status = (answer[key] && answer[key].status) || 200;
      return {
        ok: status < 400,
        status,
        json: async () => (body && body.body !== undefined ? body.body : body),
      };
    },
  };
  const loaded = loadFromIndex(NAMES, deps);
  return {
    deps,
    calls,
    asked,
    run: (name, args) => loaded.runGithubTool(name, args),
  };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('code search asks its own route and reads the result as a line per hit', async () => {
  const h = harness({
    answer: {
      '/api/github/search': [
        { path: 'src/a.js', line: 12, text: 'handleSend()' },
        { path: 'src/b.js', line: 0, text: '' },
      ],
    },
  });
  const reply = await h.run('github_search_code', { repo: 'octocat/demo', query: 'handleSend' });
  assert.equal(h.calls[0].url, '/api/github/search?repo=octocat%2Fdemo&q=handleSend');
  assert.equal(reply, 'src/a.js:12 — handleSend()\nsrc/b.js');
  // A read never asks the user anything.
  assert.deepEqual(h.asked, []);
});

test('a search with no hits says so rather than answering with nothing', async () => {
  const h = harness({ answer: { '/api/github/search': [] } });
  assert.match(await h.run('github_search_code', { repo: 'o/r', query: 'nope' }), /No code in o\/r matches "nope"/);
});

test('a search without a query is refused before anything is asked of GitHub', async () => {
  const h = harness();
  assert.match(await h.run('github_search_code', { repo: 'o/r' }), /^Error: repo and query are required/);
  assert.deepEqual(h.calls, []);
});

test('the commit list is one line per commit, with the short sha', async () => {
  const h = harness({
    answer: {
      '/api/github/commits': [
        { sha: 'abcdef1234567890', message: 'Fix the thing', author: 'Ada', date: '2026-09-01T10:00:00Z' },
      ],
    },
  });
  const reply = await h.run('github_list_commits', { repo: 'octocat/demo', path: 'src/index.js' });
  assert.equal(h.calls[0].url, '/api/github/commits?repo=octocat%2Fdemo&path=src%2Findex.js');
  assert.equal(reply, 'abcdef1 2026-09-01 Ada: Fix the thing');
});

test('a delete is confirmed once, and forgets the sha of the file it removed', async () => {
  const h = harness({
    approve: true,
    answer: { '/api/github/file': { path: 'src/old.js', account: 'octocat', commitUrl: 'https://example/c' } },
  });
  h.deps.githubShaCache['octocat/demo/src/old.js'] = 'sha-before';
  const reply = await h.run('github_delete_file', { repo: 'octocat/demo', path: 'src/old.js', message: 'Remove it' });
  assert.equal(h.asked.length, 1, 'exactly one question');
  assert.match(h.asked[0], /Deleting "src\/old\.js" from octocat\/demo as octocat\?/);
  assert.equal(h.calls[0].init.method, 'DELETE');
  assert.equal(JSON.parse(h.calls[0].init.body).path, 'src/old.js');
  // The cached sha belonged to a file that no longer exists; a later write to
  // the same path must not be told to update a version that is gone.
  assert.equal(h.deps.githubShaCache['octocat/demo/src/old.js'], undefined);
  assert.match(reply, /^Deleted src\/old\.js as octocat\./);
});

test('a declined delete changes nothing at all', async () => {
  const h = harness({ approve: false });
  const reply = await h.run('github_delete_file', { repo: 'o/r', path: 'a.md', message: 'x' });
  assert.match(reply, /user declined/);
  assert.deepEqual(h.calls, [], 'nothing was sent');
});

test('a commit is confirmed by the same single guard, not by its own copy', async () => {
  // The point of the central check: a write added later cannot forget the
  // dialog, because it never had one of its own to forget.
  const h = harness({ approve: true, answer: { '/api/github/file': { sha: 'after', account: 'octocat', commitUrl: 'https://example/c' } } });
  await h.run('github_commit_file', { repo: 'octocat/demo', path: 'README.md', content: 'x', message: 'y' });
  assert.equal(h.asked.length, 1);
  assert.match(h.asked[0], /Committing "README\.md" to octocat\/demo as octocat\?/);
  assert.equal(h.calls[0].init.method, 'PUT');
});

test('a read is never confirmed, and an unknown tool is an error', async () => {
  const h = harness();
  await h.run('github_read_file', { repo: 'o/r', path: 'a.md' });
  await h.run('github_list_repos', {});
  assert.deepEqual(h.asked, []);
  assert.equal(await h.run('github_nuke_repo', {}), 'Error: unknown tool github_nuke_repo');
});

test('a route failure comes back as an error string, not a thrown turn', async () => {
  // The loop reads a tool failure as an ordinary result so the model can correct
  // itself; throwing here would end the turn instead.
  const h = harness({ answer: { '/api/github/search': { status: 422, body: { error: 'you can only search the default branch' } } } });
  const reply = await h.run('github_search_code', { repo: 'o/r', query: 'x' });
  assert.match(reply, /^Error: you can only search the default branch/);
});
