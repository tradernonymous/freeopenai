// The one tool in this app that can do something the user cannot take back.
//
// A command runs on the server, so most of what is worth testing is what stops
// it: it is off until an operator asks for it, it refuses when the app has no
// login to hide behind, it cannot see the operator's keys, and it cannot leave
// the directory it was given. The last test is the thing it was built for --
// create a script that generates a PDF and run it -- because a capability that
// cannot be shown working end to end is a capability nobody has.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signSession, SESSION_COOKIE_NAME } = require('../auth.js');
const { loadServerPointedAt } = require('./helpers/github-stand-in.js');
const {
  capRunOutput,
  listWorkspaceFiles,
  resolveWorkspaceCwd,
  runEnvironment,
  workspaceRunRefusal,
  workspaceRunRoot,
  workspaceRunTimeoutMs,
} = require('../server.js');

const SECRET = 'test-secret';
process.env.SESSION_SECRET = SECRET;

// The operator's own settings, which are exactly the things a command must not
// be able to read.
const OPERATOR_ENV = {
  NARA_API_KEY: 'nara-secret-value',
  OPENROUTER_API_KEY: 'openrouter-secret-value',
  GITHUB_TOKEN: 'github-secret-value',
  SESSION_SECRET: 'session-secret-value',
};

function sessionCookie() {
  return SESSION_COOKIE_NAME + '=' + signSession(SECRET, 'operator');
}

// A login and a temp root, because both are what the route checks: no accounts
// means no shell (see the refusal test), and the workspace lives inside
// whatever directory the handler was pointed at, so a real one is never touched.
async function withServer(env, run) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeopenai-run-'));
  const { mod, cleanup } = loadServerPointedAt('https://api.github.com', '-run');
  const app = http.createServer(mod.createRequestHandler(appRoot));
  await new Promise((resolve) => app.listen(0, resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = (body, headers = {}) => fetch(base + '/api/workspace/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  try {
    await run({ base, appRoot, post, cookie: sessionCookie() });
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

const SIGNED_IN = { WORKSPACE_RUN: '1', AUTH_USER_1: 'operator', AUTH_PASS_1: 'hunter2' };

test('running is off until an operator asks for it, and says which switch', () => {
  // Two separate reasons, because they need two different fixes. A refusal that
  // does not say which one is a refusal the operator cannot act on.
  assert.match(workspaceRunRefusal({}), /WORKSPACE_RUN=1/);
  assert.match(workspaceRunRefusal({ WORKSPACE_RUN: 'true' }), /WORKSPACE_RUN=1/, 'only 1 turns it on');
  assert.match(workspaceRunRefusal({ WORKSPACE_RUN: '1' }), /login/,
    'and on an app with no accounts configured it is still refused');
  assert.equal(workspaceRunRefusal({ WORKSPACE_RUN: '1', AUTH_USER_1: 'u', AUTH_PASS_1: 'p' }), '');
});

test('the timeout is bounded on both ends', () => {
  assert.equal(workspaceRunTimeoutMs({}), 120000, 'a command that hangs is stopped without being asked');
  assert.equal(workspaceRunTimeoutMs({ WORKSPACE_RUN_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(workspaceRunTimeoutMs({ WORKSPACE_RUN_TIMEOUT_MS: '1' }), 1000, 'a floor, so a typo is still a run');
  assert.equal(workspaceRunTimeoutMs({ WORKSPACE_RUN_TIMEOUT_MS: '99999999' }), 600000, 'and a ceiling');
  assert.equal(workspaceRunTimeoutMs({ WORKSPACE_RUN_TIMEOUT_MS: 'soon' }), 120000, 'nonsense falls back');
});

test('a command is handed a shell, a home, and none of the operator\'s secrets', () => {
  const env = runEnvironment({ ...OPERATOR_ENV, PATH: '/usr/bin', LANG: 'C.UTF-8', NODE_OPTIONS: '--require ./evil.js' }, '/tmp/ws');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/tmp/ws', 'caches belong in the workspace, not in the operator\'s home');
  for (const key of Object.keys(OPERATOR_ENV)) {
    assert.equal(key in env, false, key + ' would be readable by any script the model writes');
  }
  // NODE_OPTIONS and friends are not secrets but they are worse: either one is a
  // way to run code around the command that was actually approved.
  assert.equal('NODE_OPTIONS' in env, false);
  assert.equal('PORT' in env, false);
});

test('output is capped rather than returned in full', () => {
  assert.deepEqual(capRunOutput('short'), { text: 'short', truncated: false });
  const capped = capRunOutput('x'.repeat(50), 10);
  assert.equal(capped.text, 'x'.repeat(10));
  assert.equal(capped.truncated, true);
  assert.deepEqual(capRunOutput(null), { text: '', truncated: false });
});

test('a working directory cannot leave the workspace', () => {
  const root = path.join(os.tmpdir(), 'ws');
  assert.equal(resolveWorkspaceCwd(root, ''), root);
  assert.equal(resolveWorkspaceCwd(root, '.'), root);
  assert.equal(resolveWorkspaceCwd(root, 'sub'), path.join(root, 'sub'));
  assert.equal(resolveWorkspaceCwd(root, 'sub/deeper'), path.join(root, 'sub', 'deeper'));
  // The three spellings that matter: a relative climb, an absolute path, and a
  // sibling whose name merely starts with the root's.
  assert.equal(resolveWorkspaceCwd(root, '../..'), null);
  assert.equal(resolveWorkspaceCwd(root, path.join(path.sep, 'etc')), null);
  assert.equal(resolveWorkspaceCwd(root, '../ws-backup'), null);
});

test('the file listing is the whole tree, sorted, with sizes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freeopenai-list-'));
  try {
    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, 'notes', 'b.md'), 'bb');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    assert.deepEqual(listWorkspaceFiles(root).map((f) => f.path), ['a.txt', 'notes/b.md']);
    assert.equal(listWorkspaceFiles(root)[1].bytes, 2);
    assert.deepEqual(listWorkspaceFiles(path.join(root, 'missing')), [], 'a directory that is not there is not an error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a command is refused with a reason on a server that has not enabled it', async () => {
  // The case that matters most: WORKSPACE_RUN set on an app where `isAuthenticated`
  // has no accounts to check, so it lets everyone through. The shell has to refuse
  // on its own, because there is nothing else left to refuse for it.
  await withServer({ WORKSPACE_RUN: '1', AUTH_USER_1: undefined, AUTH_PASS_1: undefined }, async ({ post }) => {
    const res = await post({ command: 'node --version' });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /login/, 'the reason names the missing login, not the missing switch');
  });

  await withServer({ ...SIGNED_IN, WORKSPACE_RUN: undefined }, async ({ post, cookie }) => {
    const res = await post({ command: 'node --version' }, { cookie });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /WORKSPACE_RUN=1/);
    assert.equal(data.enabled, false);
  });
});

test('a shell is behind the login, not beside it', async () => {
  await withServer(SIGNED_IN, async ({ post }) => {
    const res = await post({ command: 'node --version' });
    assert.equal(res.status, 401, 'without a session there is no shell');
    const wrong = await post({ command: 'node --version' }, { cookie: SESSION_COOKIE_NAME + '=nonsense' });
    assert.equal(wrong.status, 401, 'and a forged one is the same as none');
  });
});

test('create and run a PDF generation script', async () => {
  // The whole point of the tool, end to end: a script written into the server
  // workspace, run there, and the file it produced fetched back through the
  // download route. The script uses the app's own PDF builder, so the bytes that
  // come back are the ones this app writes for the Download menu.
  await withServer(SIGNED_IN, async ({ base, appRoot, post, cookie }) => {
    const workspace = workspaceRunRoot(appRoot);
    fs.mkdirSync(workspace, { recursive: true });
    const script = [
      "const fs = require('fs');",
      "const { buildImagePdf } = require(" + JSON.stringify(path.join(__dirname, '..', 'chatlib.js')) + ");",
      'const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);',
      "fs.writeFileSync('report.pdf', buildImagePdf(jpeg, 1536, 864));",
      "console.log('wrote report.pdf');",
    ].join('\n');
    fs.writeFileSync(path.join(workspace, 'make-pdf.js'), script);

    const res = await post({ command: 'node make-pdf.js' }, { cookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.equal(data.exitCode, 0);
    assert.equal(data.timedOut, false);
    assert.match(data.stdout, /wrote report\.pdf/);
    assert.equal(data.cwd, '.');

    // The file it produced is named in the result, which is what tells the model
    // its script worked and gives the user something to click.
    const report = data.files.find((f) => f.path === 'report.pdf');
    assert.ok(report, 'the produced file is listed: ' + JSON.stringify(data.files));
    assert.ok(report.bytes > 100, 'and with a size that is really a PDF');

    const download = await fetch(base + '/api/workspace/file?path=report.pdf', { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(download.headers.get('content-disposition'), /report\.pdf/);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(bytes.length, report.bytes, 'the download is the file that was listed');
  });
});

test('a command cannot read the operator\'s environment, and says so by running', async () => {
  // The session secret is left out here on purpose: with one set, loading a copy
  // of the server under a different value is what makes the cookie invalid, and
  // the helper test above already covers it being scrubbed.
  const { SESSION_SECRET, ...secrets } = OPERATOR_ENV;
  void SESSION_SECRET;
  await withServer({ ...SIGNED_IN, ...secrets }, async ({ post, cookie }) => {
    // Asked of a real shell rather than of the helper: the thing being tested is
    // what a script the model wrote would actually see.
    const res = await post({ command: 'node -e "console.log(JSON.stringify(process.env))"' }, { cookie });
    const data = await res.json();
    assert.equal(data.exitCode, 0, JSON.stringify(data));
    for (const value of Object.values(secrets)) {
      assert.equal(data.stdout.includes(value), false, value + ' leaked into a command');
    }
    assert.match(data.stdout, /PATH/, 'and the process still has what it needs to run');
  });
});

test('a command that outlives its timeout is stopped, not waited on', async () => {
  await withServer({ ...SIGNED_IN, WORKSPACE_RUN_TIMEOUT_MS: '1000' }, async ({ post, cookie }) => {
    const res = await post({ command: 'node -e "setTimeout(() => {}, 30000)"' }, { cookie });
    const data = await res.json();
    assert.equal(data.timedOut, true, JSON.stringify(data));
    assert.equal(data.ok, false);
    assert.ok(data.durationMs < 20000, 'it did not wait for the command: ' + data.durationMs);
  });
});

test('one command at a time, and a failure is an answer rather than a 500', async () => {
  await withServer(SIGNED_IN, async ({ post, cookie }) => {
    const failing = await post({ command: 'node -e "process.exit(3)"' }, { cookie });
    const data = await failing.json();
    assert.equal(failing.status, 200, 'a non-zero exit is a result the model can read');
    assert.equal(data.exitCode, 3);
    assert.equal(data.ok, false);

    const missing = await post({ command: 'node not-a-file.js' }, { cookie });
    const missingData = await missing.json();
    assert.equal(missing.status, 200);
    assert.notEqual(missingData.exitCode, 0);
    assert.ok(missingData.stderr.length > 0, 'the reason is in stderr, where the model will look');

    assert.equal((await post({}, { cookie })).status, 400, 'no command is not a command');
    assert.equal((await post({ command: '   ' }, { cookie })).status, 400);
    assert.equal((await post({ command: 'x'.repeat(9000) }, { cookie })).status, 400);
    assert.equal((await post({ command: 'node --version', cwd: '../../..' }, { cookie })).status, 400);
  });
});
