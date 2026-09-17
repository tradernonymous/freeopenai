// The server workspace as files: in Build mode the page's workspace tools act
// on the folder the shell runs in, through these routes. What matters is the
// same as for the shell -- behind the login and the switch, inside the folder,
// never .git or .env -- plus the edit contract the browser workspace already
// keeps: old_text must be found exactly once unless asked for all of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signSession, SESSION_COOKIE_NAME } = require('../auth.js');
const { loadServerPointedAt } = require('./helpers/github-stand-in.js');

const SECRET = 'test-secret';
process.env.SESSION_SECRET = SECRET;
const SIGNED_IN = { WORKSPACE_RUN: '1', AUTH_USER_1: 'operator', AUTH_PASS_1: 'pw' };

async function withServer(env, run) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeopenai-files-'));
  const { mod, cleanup } = loadServerPointedAt('https://api.github.com', '-files');
  const app = http.createServer(mod.createRequestHandler(appRoot));
  await new Promise((resolve) => app.listen(0, resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const cookie = SESSION_COOKIE_NAME + '=' + signSession(SECRET, 'operator');
  const call = (method, route, body, headers = {}) => fetch(base + route, {
    method,
    headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    await run({ base, appRoot, call, cookie, workspace: mod.workspaceRunRoot(appRoot) });
  } finally {
    await new Promise((resolve) => app.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup();
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
}

test('write, read, search, edit and delete a file on the server, in order', async () => {
  await withServer(SIGNED_IN, async ({ call, workspace }) => {
    const put = await call('PUT', '/api/workspace/file', { path: 'notes/todo.md', content: '# Todo\n- write tests\n- ship\n' });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { path: 'notes/todo.md', bytes: 28, created: true, replaced: 0 });
    assert.equal(fs.readFileSync(path.join(workspace, 'notes/todo.md'), 'utf8'), '# Todo\n- write tests\n- ship\n');

    const read = await call('GET', '/api/workspace/read?path=notes%2Ftodo.md');
    assert.equal(read.status, 200);
    assert.equal((await read.json()).content, '# Todo\n- write tests\n- ship\n');

    const search = await call('GET', '/api/workspace/search?query=SHIP');
    assert.equal(search.status, 200);
    const found = await search.json();
    assert.deepEqual(found.matches, [{ path: 'notes/todo.md', line: 3, text: '- ship' }]);

    const dup = await call('PATCH', '/api/workspace/file', { path: 'notes/todo.md', old_text: '- ', new_text: '* ' });
    assert.equal(dup.status, 409, 'an ambiguous anchor is refused rather than guessed');
    const all = await call('PATCH', '/api/workspace/file', { path: 'notes/todo.md', old_text: '- ', new_text: '* ', all: true });
    assert.equal(all.status, 200);
    assert.equal((await all.json()).replaced, 2);
    const missing = await call('PATCH', '/api/workspace/file', { path: 'notes/todo.md', old_text: 'nope', new_text: '' });
    assert.equal(missing.status, 409);
    assert.match((await missing.json()).error, /not found/);

    const gone = await call('DELETE', '/api/workspace/file?path=notes%2Ftodo.md');
    assert.equal(gone.status, 200);
    assert.equal(fs.existsSync(path.join(workspace, 'notes/todo.md')), false);
    assert.equal((await call('GET', '/api/workspace/read?path=notes%2Ftodo.md')).status, 404);
  });
});

test('the folder\'s edges hold: outside, .git, .env, folders, and no JSON', async () => {
  await withServer(SIGNED_IN, async ({ call }) => {
    assert.equal((await call('PUT', '/api/workspace/file', { path: '../escape.txt', content: 'x' })).status, 400);
    assert.equal((await call('PUT', '/api/workspace/file', { path: '.git/config', content: 'x' })).status, 400);
    assert.equal((await call('PUT', '/api/workspace/file', { path: 'app/.env', content: 'KEY=1' })).status, 400);
    assert.equal((await call('GET', '/api/workspace/read?path=..%2F..%2Fserver.js')).status, 400);
    assert.equal((await call('GET', '/api/workspace/search?query=x&path=..')).status, 400);
    const form = await call('PUT', '/api/workspace/file', null, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415, 'a cross-site form cannot write files');
  });
});

test('the file routes are behind the same switch and login as the shell', async () => {
  await withServer({ ...SIGNED_IN, WORKSPACE_RUN: undefined }, async ({ call }) => {
    assert.equal((await call('PUT', '/api/workspace/file', { path: 'a.txt', content: 'a' })).status, 403);
    assert.equal((await call('GET', '/api/workspace/read?path=a.txt')).status, 403);
  });
  await withServer(SIGNED_IN, async ({ base }) => {
    const res = await fetch(base + '/api/workspace/read?path=a.txt');
    assert.equal(res.status, 401);
  });
});

test('a force push is refused by the shell route before it runs', async () => {
  await withServer(SIGNED_IN, async ({ base, cookie }) => {
    const res = await fetch(base + '/api/workspace/run', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'git push --force origin main' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /force/);
  });
});
