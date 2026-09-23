// Pull request review from the phone (docs/android-master-plan.md, Phase 4):
// list a repo's open PRs, read one with its changed files, and submit a
// review. Tested against a stand-in for api.github.com, like the other GitHub
// routes (test/helpers/github-stand-in.js).
//
// The review is the one route that changes something on GitHub, so what
// matters most is what it refuses before anything is sent: an event that is
// not one of GitHub's three, a comment or change request with no text, a repo
// name that could steer the path, a number that is not a number.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { githubSessionCookie, loadServerPointedAt } = require('./helpers/github-stand-in.js');

process.env.SESSION_SECRET = 'test-secret';

function startFakeGithub(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const answer = routes(req.method, req.url, body ? JSON.parse(body) : null);
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
  const { mod, cleanup } = loadServerPointedAt(`http://127.0.0.1:${gh.server.address().port}`, '-pulls');
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

const review = (base, cookie, body) => fetch(`${base}/api/github/review`, {
  method: 'POST',
  headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('the open pull requests of a repo come back in a small, flat shape', async () => {
  await withApp(
    (method, url) => {
      if (method !== 'GET' || !url.startsWith('/repos/octocat/demo/pulls?')) return null;
      return {
        body: [{
          number: 7, title: 'Add dark mode', draft: false, updated_at: '2026-09-20T10:00:00Z',
          user: { login: 'mona' }, head: { ref: 'dark' }, base: { ref: 'main' }, body: 'x'.repeat(10),
        }],
      };
    },
    async ({ base, cookie, seen }) => {
      const res = await fetch(`${base}/api/github/pulls?repo=octocat/demo`, { headers: { cookie } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), [{
        number: 7, title: 'Add dark mode', author: 'mona', draft: false,
        updatedAt: '2026-09-20T10:00:00Z', head: 'dark', base: 'main',
      }]);
      assert.match(seen[0].url, /state=open/);
    },
  );
});

test('one pull request comes with its changed files, each patch clipped', async () => {
  await withApp(
    (method, url) => {
      if (url === '/repos/octocat/demo/pulls/7') {
        return {
          body: {
            number: 7, title: 'Add dark mode', body: 'Why: ' + 'y'.repeat(5000), state: 'open', draft: false,
            user: { login: 'mona' }, head: { ref: 'dark' }, base: { ref: 'main' },
            additions: 12, deletions: 3, html_url: 'https://github.com/octocat/demo/pull/7',
          },
        };
      }
      if (url.startsWith('/repos/octocat/demo/pulls/7/files')) {
        return {
          body: [
            { filename: 'src/theme.kt', status: 'modified', additions: 10, deletions: 2, patch: '@@ -1 +1 @@\n-a\n+b\n' + 'z'.repeat(9000) },
            { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
          ],
        };
      }
      return null;
    },
    async ({ base, cookie }) => {
      const res = await fetch(`${base}/api/github/pull?repo=octocat/demo&number=7`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const pr = await res.json();
      assert.equal(pr.number, 7);
      assert.equal(pr.author, 'mona');
      assert.equal(pr.additions, 12);
      assert.equal(pr.url, 'https://github.com/octocat/demo/pull/7');
      assert.ok(pr.body.length <= 4000, 'a long description is clipped');
      assert.equal(pr.files.length, 2);
      assert.equal(pr.files[0].filename, 'src/theme.kt');
      assert.ok(pr.files[0].patch.startsWith('@@ -1 +1 @@'));
      assert.ok(pr.files[0].patch.length <= 6000, 'a long patch is clipped');
      assert.equal(pr.files[0].clipped, true);
      assert.equal(pr.files[1].patch, '', 'a binary file has no patch, and says so by being empty');
      assert.equal(pr.files[1].clipped, false);
    },
  );
});

test('an approval is sent to GitHub exactly as asked, and its answer returned', async () => {
  await withApp(
    (method, url) => {
      if (method === 'POST' && url === '/repos/octocat/demo/pulls/7/reviews') return { body: { id: 99, state: 'APPROVED' } };
      return null;
    },
    async ({ base, cookie, seen }) => {
      const res = await review(base, cookie, { repo: 'octocat/demo', number: 7, event: 'APPROVE' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { id: 99, state: 'APPROVED' });
      assert.deepEqual(seen[0].body, { event: 'APPROVE', body: '' });
    },
  );
});

test('a comment or a change request carries its text', async () => {
  await withApp(
    (method, url) => (method === 'POST' && url === '/repos/octocat/demo/pulls/7/reviews' ? { body: { id: 5, state: 'CHANGES_REQUESTED' } } : null),
    async ({ base, cookie, seen }) => {
      const res = await review(base, cookie, { repo: 'octocat/demo', number: 7, event: 'REQUEST_CHANGES', body: 'Rename the flag.' });
      assert.equal(res.status, 200);
      assert.deepEqual(seen[0].body, { event: 'REQUEST_CHANGES', body: 'Rename the flag.' });
    },
  );
});

test('a review is refused before anything is sent when it cannot be right', async () => {
  await withApp(
    () => ({ body: { id: 1, state: 'APPROVED' } }),
    async ({ base, cookie, seen }) => {
      const cases = [
        [{ repo: 'octocat/demo', number: 7, event: 'MERGE' }, /event/],
        [{ repo: 'octocat/demo', number: 7, event: 'COMMENT', body: '   ' }, /text/],
        [{ repo: 'octocat/demo', number: 7, event: 'REQUEST_CHANGES' }, /text/],
        [{ repo: 'octocat/../../user', number: 7, event: 'APPROVE' }, /repo/],
        [{ repo: 'octocat/demo', number: 0, event: 'APPROVE' }, /number/],
        [{ repo: 'octocat/demo', number: '7; rm', event: 'APPROVE' }, /number/],
      ];
      for (const [body, why] of cases) {
        const res = await review(base, cookie, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match((await res.json()).error, why);
      }
      assert.equal(seen.length, 0, 'nothing reached GitHub');
    },
  );
});

test('the read routes refuse a repo name that could steer the path', async () => {
  await withApp(
    () => ({ body: [] }),
    async ({ base, cookie, seen }) => {
      for (const url of ['/api/github/pulls?repo=a/../../user', '/api/github/pull?repo=octocat/demo&number=-1', '/api/github/pulls']) {
        const res = await fetch(base + url, { headers: { cookie } });
        assert.equal(res.status, 400, url);
      }
      assert.equal(seen.length, 0);
    },
  );
});

test('GitHub\'s own refusal is passed on with its reason', async () => {
  await withApp(
    (method) => (method === 'POST' ? { status: 422, body: { message: 'Can not approve your own pull request' } } : null),
    async ({ base, cookie }) => {
      const res = await review(base, cookie, { repo: 'octocat/demo', number: 7, event: 'APPROVE' });
      assert.equal(res.status, 422);
      assert.match((await res.json()).error, /own pull request/);
    },
  );
});

test('without a GitHub connection the routes say so', async () => {
  await withApp(
    () => ({ body: [] }),
    async ({ base }) => {
      const res = await fetch(`${base}/api/github/pulls?repo=octocat/demo`);
      assert.equal(res.status, 401);
    },
  );
});
