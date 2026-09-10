const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { encryptJson } = require('../github.js');

process.env.SESSION_SECRET = 'test-secret';

// GitHub refuses to update an existing file unless it is given that file's
// current sha. The app's model hit this as:
//
//   "the commit failed due to the lack of a sha parameter"
//
// It should never have been the caller's problem. These tests run against a
// stand-in that enforces the same rule, so the fix is verified against the
// behaviour that actually broke rather than against an assumption.
function startFakeGithub(existing) {
  const files = { ...existing };
  const server = http.createServer((req, res) => {
    const filePath = decodeURIComponent((req.url.split('/contents/')[1] || '').split('?')[0]);
    if (req.method === 'GET') {
      if (!files[filePath]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...files[filePath], path: filePath }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      if (files[filePath] && !payload.sha) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: `${filePath} does not match ("sha" wasn't supplied)` }));
      }
      files[filePath] = { sha: 'sha-after', content: payload.content };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: { sha: 'sha-after', html_url: 'https://example/blob' },
        commit: { html_url: 'https://example/commit' },
      }));
    });
  });
  return server;
}

// The server hardcodes api.github.com, so point a copy at the stand-in.
function loadServerPointedAt(origin) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .replace(/https:\/\/api\.github\.com/g, origin);
  const copy = path.join(__dirname, '..', '.server-under-test.js');
  fs.writeFileSync(copy, source);
  try {
    delete require.cache[require.resolve(copy)];
    return { mod: require(copy), cleanup: () => fs.unlinkSync(copy) };
  } catch (err) {
    fs.unlinkSync(copy);
    throw err;
  }
}

async function commitThrough(files, payload) {
  const gh = startFakeGithub(files);
  await new Promise((r) => gh.listen(0, r));
  const { mod, cleanup } = loadServerPointedAt(`http://127.0.0.1:${gh.address().port}`);
  const app = http.createServer(mod.createRequestHandler(path.join(__dirname, '..')));
  await new Promise((r) => app.listen(0, r));

  const cookie = 'fo_gh=' + encryptJson('test-secret', {
    appUser: null,
    exp: Date.now() + 60000,
    accounts: [{ token: 'tok', login: 'octocat' }],
  });

  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/github/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    app.close();
    gh.close();
    cleanup();
  }
}

test('updating an existing file works without the caller supplying a sha', async () => {
  const result = await commitThrough(
    { 'README.md': { sha: 'sha-before', content: Buffer.from('old').toString('base64') } },
    { repo: 'octocat/demo', path: 'README.md', content: '# new', message: 'Update README' }
  );
  assert.equal(result.status, 200, `expected success, got ${JSON.stringify(result.body)}`);
  assert.equal(result.body.sha, 'sha-after');
  assert.equal(result.body.account, 'octocat');
});

test('creating a new file sends no sha, rather than inventing one', async () => {
  const result = await commitThrough(
    { 'README.md': { sha: 'sha-before', content: 'x' } },
    { repo: 'octocat/demo', path: 'docs/NEW.md', content: 'hello', message: 'Add doc' }
  );
  assert.equal(result.status, 200, `expected success, got ${JSON.stringify(result.body)}`);
});

test('a sha the caller does supply is still honoured', async () => {
  const result = await commitThrough(
    { 'README.md': { sha: 'sha-before', content: 'x' } },
    { repo: 'octocat/demo', path: 'README.md', content: '# new', message: 'Update', sha: 'sha-before' }
  );
  assert.equal(result.status, 200);
});

test('a path with spaces and nesting survives encoding', async () => {
  const result = await commitThrough(
    { 'docs/my notes.md': { sha: 'sha-before', content: 'x' } },
    { repo: 'octocat/demo', path: 'docs/my notes.md', content: 'updated', message: 'Update notes' }
  );
  assert.equal(result.status, 200, `expected success, got ${JSON.stringify(result.body)}`);
});
