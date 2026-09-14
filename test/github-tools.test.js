// The coding tools a repository needs beyond read-a-file: find where something
// lives (search), see what changed lately (commits), and remove a file. All
// three go through the connector's own routes, and all three are tested against
// a stand-in rather than the real API -- the server hardcodes api.github.com on
// purpose, so the stand-in is a copy of the source with that hostname replaced.
//
// The delete is the one that changes something, so its happy path is not the
// interesting case: what matters is that it looks the file's sha up itself (a
// caller that deletes without reading has none to give), and that a file that is
// not there is refused rather than reported as deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { githubSessionCookie, loadServerPointedAt } = require('./helpers/github-stand-in.js');

process.env.SESSION_SECRET = 'test-secret';

// A stand-in for the three endpoints, recording what was asked of it.
function startFakeGithub(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = req.url;
    seen.push(req.method + ' ' + url);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const answer = routes(req, url, body ? JSON.parse(body) : null);
      if (!answer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      res.writeHead(answer.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  return { server, seen };
}

async function withApp(routes, run) {
  const gh = startFakeGithub(routes);
  await new Promise((r) => gh.server.listen(0, r));
  const { mod, cleanup } = loadServerPointedAt(`http://127.0.0.1:${gh.server.address().port}`, '-tools');
  const app = http.createServer(mod.createRequestHandler(path.join(__dirname, '..')));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const cookie = githubSessionCookie('test-secret');
  try {
    return await run({ base, cookie, seen: gh.seen });
  } finally {
    app.close();
    gh.server.close();
    cleanup();
  }
}

test('code search answers with paths and line numbers, not just paths', async () => {
  await withApp(
    (req, url) => {
      if (!url.startsWith('/search/code')) return null;
      return {
        body: {
          items: [
            {
              path: 'src/send.js',
              text_matches: [{ fragment: 'const a = 1;\nfunction handleSend() {\n  send();\n}', matches: ['handleSend'] }],
            },
            { path: 'src/other.js' },
          ],
        },
      };
    },
    async ({ base, cookie, seen }) => {
      const res = await fetch(`${base}/api/github/search?repo=octocat/demo&q=handleSend`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body[0].path, 'src/send.js');
      // The match is on the second line of the fragment, and a result a caller
      // cannot locate costs a full read to use.
      assert.equal(body[0].line, 2);
      assert.match(body[0].text, /handleSend/);
      // An item with no fragment still answers with its path rather than being
      // dropped: half an answer beats nothing.
      assert.equal(body[1].path, 'src/other.js');
      // The search is scoped to the repo the caller named, and it asks for the
      // fragments -- without the extra Accept, GitHub answers with paths only.
      assert.ok(seen.some((line) => line.startsWith('GET /search/code') && line.includes('octocat%2Fdemo')));
    },
  );
});

test('an unindexed repository reports GitHub\u2019s own explanation', async () => {
  await withApp(
    (req, url) => (url.startsWith('/search/code')
      ? { status: 422, body: { message: 'You can only search the default branch' } }
      : null),
    async ({ base, cookie }) => {
      const res = await fetch(`${base}/api/github/search?repo=octocat/demo&q=x`, { headers: { cookie } });
      assert.equal(res.status, 422);
      assert.match((await res.json()).error, /default branch/);
    },
  );
});

test('search insists on both a repository and something to look for', async () => {
  await withApp(
    () => null,
    async ({ base, cookie }) => {
      const missingQ = await fetch(`${base}/api/github/search?repo=octocat/demo`, { headers: { cookie } });
      assert.equal(missingQ.status, 400);
      assert.match((await missingQ.json()).error, /q are required/);
      const missingRepo = await fetch(`${base}/api/github/search?q=x`, { headers: { cookie } });
      assert.equal(missingRepo.status, 400);
    },
  );
});

test('the commit list is one line per commit, newest first as GitHub returns it', async () => {
  await withApp(
    (req, url) => (!url.startsWith('/repos/octocat/demo/commits')
      ? null
      : {
        body: [
          { sha: 'abcdef1234567890', commit: { message: 'Fix the thing\n\nlong body', author: { name: 'Ada', date: '2026-09-01T10:00:00Z' } } },
          { sha: '0987654321', commit: { message: 'Add the thing', author: { name: 'Grace', date: '2026-08-30T10:00:00Z' } } },
        ],
      }),
    async ({ base, cookie, seen }) => {
      const res = await fetch(`${base}/api/github/commits?repo=octocat/demo`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body[0], {
        sha: 'abcdef1234567890',
        // Only the subject: a body would be re-sent in every later round of the
        // turn for no answer.
        message: 'Fix the thing',
        author: 'Ada',
        date: '2026-09-01T10:00:00Z',
      });
      assert.equal(body.length, 2);
      assert.ok(!seen.some((line) => line.includes('path=')), 'no path asked for means the whole repo');
    },
  );
});

test('a commit list can be narrowed to one file', async () => {
  await withApp(
    (req, requestUrl) => (requestUrl.includes('path=src%2Findex.js')
      ? { body: [{ sha: 'abc', commit: { message: 'Touch index', author: { name: 'Ada', date: '2026-09-01' } } }] }
      : { body: [] }),
    async ({ base, cookie }) => {
      const res = await fetch(`${base}/api/github/commits?repo=octocat/demo&path=src%2Findex.js`, { headers: { cookie } });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).length, 1);
    },
  );
});

test('deleting a file looks the sha up itself, so a caller needs none', async () => {
  let deleted = null;
  await withApp(
    (req, url, body) => {
      if (req.method === 'GET' && url.includes('/contents/')) {
        return url.includes('gone.md') ? null : { body: { sha: 'sha-of-file', content: 'x' } };
      }
      if (req.method === 'DELETE') {
        deleted = { url, body };
        return { body: { commit: { html_url: 'https://example/commit/1' } } };
      }
      return null;
    },
    async ({ base, cookie }) => {
      const res = await fetch(`${base}/api/github/file`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ repo: 'octocat/demo', path: 'src/old.js', message: 'Remove it' }),
      });
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      const body = await res.json();
      assert.equal(body.path, 'src/old.js');
      assert.equal(body.account, 'octocat');
      assert.equal(body.commitUrl, 'https://example/commit/1');
      assert.equal(deleted.body.sha, 'sha-of-file', 'the current sha was looked up, not invented');
      assert.equal(deleted.body.message, 'Remove it');
    },
  );
});

test('deleting a file that is not there is refused, not reported as deleted', async () => {
  await withApp(
    (req) => (req.method === 'GET' ? null : { body: {} }),
    async ({ base, cookie }) => {
      const res = await fetch(`${base}/api/github/file`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ repo: 'octocat/demo', path: 'nope.md', message: 'x' }),
      });
      assert.equal(res.status, 404);
      // GitHub's own "Not Found" says nothing about which argument was wrong, so
      // the route replaces it with the path it could not find.
      assert.match((await res.json()).error, /No file at "nope\.md" in octocat\/demo/);
    },
  );
});

test('a delete without a path is a 400 rather than a request to GitHub', async () => {
  await withApp(
    () => ({ body: { sha: 'x' } }),
    async ({ base, cookie, seen }) => {
      const res = await fetch(`${base}/api/github/file`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ repo: 'octocat/demo' }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /repo and path are required/);
      assert.deepEqual(seen, [], 'nothing was asked of GitHub');
    },
  );
});

test('all three routes need the connector, like the rest of them', async () => {
  await withApp(
    () => ({ body: {} }),
    async ({ base }) => {
      for (const url of ['/api/github/search?repo=o/r&q=x', '/api/github/commits?repo=o/r']) {
        assert.equal((await fetch(base + url)).status, 401, url);
      }
      const deleted = await fetch(`${base}/api/github/file`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'o/r', path: 'a.md', message: 'x' }),
      });
      assert.equal(deleted.status, 401);
    },
  );
});
