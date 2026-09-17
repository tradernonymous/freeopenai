// The Windows desktop launcher (desktop/freeai4u-desktop.js) and the PE patch
// that stops the packaged exe from opening a console window. Everything that
// touches the machine (spawning a browser, message boxes) is injected, so what
// is tested is the decisions: which server, which browser, which arguments.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const desktop = require('../desktop/freeai4u-desktop.js');
const { setGuiSubsystem } = require('../desktop/tools/set-gui-subsystem.js');

test('a server address must be https, except on this machine', () => {
  assert.equal(desktop.normalizeServer('https://freeopenai-production.up.railway.app/'), 'https://freeopenai-production.up.railway.app');
  assert.equal(desktop.normalizeServer('https://example.com/some/path?x=1'), 'https://example.com');
  assert.equal(desktop.normalizeServer('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(desktop.normalizeServer('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(desktop.normalizeServer('http://example.com'), null, 'plain http to another machine would send the login in the clear');
  assert.equal(desktop.normalizeServer('file:///C:/x'), null);
  assert.equal(desktop.normalizeServer('javascript:alert(1)'), null);
  assert.equal(desktop.normalizeServer('not a url'), null);
  assert.equal(desktop.normalizeServer('https://user:pw@example.com'), null, 'no credentials in the address');
});

test('arguments are read, and unknown ones are reported', () => {
  assert.deepEqual(desktop.parseArgs([]), { server: null, reset: false, help: false, version: false, writeVersion: null, unknown: [] });
  const parsed = desktop.parseArgs(['--server', 'https://a.example', '--reset']);
  assert.equal(parsed.server, 'https://a.example');
  assert.equal(parsed.reset, true);
  assert.equal(desktop.parseArgs(['--server=https://b.example']).server, 'https://b.example');
  assert.equal(desktop.parseArgs(['-h']).help, true);
  assert.equal(desktop.parseArgs(['--write-version', 'C:\\v.txt']).writeVersion, 'C:\\v.txt');
  assert.deepEqual(desktop.parseArgs(['--bogus']).unknown, ['--bogus']);
});

test('Edge is preferred, Chrome is the fallback, and nothing found means the default browser', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const candidates = desktop.browserCandidates(env);
  assert.match(candidates[0], /Edge\\Application\\msedge\.exe$/);
  assert.ok(candidates.some((c) => /Chrome\\Application\\chrome\.exe$/.test(c)));
  const onlyChrome = candidates.find((c) => /chrome\.exe$/.test(c));
  assert.equal(desktop.findBrowser(candidates, (p) => p === onlyChrome), onlyChrome);
  assert.equal(desktop.findBrowser(candidates, () => false), null);
});

test('the window opens the desktop layout in its own profile', () => {
  const url = desktop.appUrl('https://srv.example');
  assert.equal(url, 'https://srv.example/?app=desktop');
  const args = desktop.launchArgs(url, 'C:\\Users\\u\\AppData\\Local\\FreeAI4U\\profile');
  assert.ok(args.includes('--app=https://srv.example/?app=desktop'));
  assert.ok(args.includes('--user-data-dir=C:\\Users\\u\\AppData\\Local\\FreeAI4U\\profile'), 'a separate profile keeps the sign-in apart from the everyday browser');
  assert.ok(args.includes('--no-first-run'));
});

test('settings live in the user profile and survive a bad file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeai4u-desktop-'));
  try {
    const paths = desktop.configPaths({ APPDATA: path.join(dir, 'Roaming'), LOCALAPPDATA: path.join(dir, 'Local') });
    assert.equal(paths.configFile, path.join(dir, 'Roaming', 'FreeAI4U', 'desktop.json'));
    assert.equal(paths.profileDir, path.join(dir, 'Local', 'FreeAI4U', 'profile'));
    assert.deepEqual(desktop.readConfig(paths.configFile), {}, 'no file yet');
    desktop.writeConfig(paths.configFile, { server: 'https://a.example' });
    assert.equal(desktop.readConfig(paths.configFile).server, 'https://a.example');
    fs.writeFileSync(paths.configFile, '{broken');
    assert.deepEqual(desktop.readConfig(paths.configFile), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the server in use: flag, then saved setting, then the default', () => {
  assert.equal(desktop.chooseServer({ server: 'https://flag.example' }, { server: 'https://saved.example' }).server, 'https://flag.example');
  assert.equal(desktop.chooseServer({ server: null }, { server: 'https://saved.example' }).server, 'https://saved.example');
  assert.equal(desktop.chooseServer({ server: null }, {}).server, desktop.DEFAULT_SERVER);
  const bad = desktop.chooseServer({ server: 'http://evil.example' }, {});
  assert.equal(bad.server, null);
  assert.match(bad.error, /https/);
});

test('the health check names what is wrong', async () => {
  const ok = await desktop.checkHealth('https://srv.example', async (url) => {
    assert.equal(url, 'https://srv.example/api/health');
    return { ok: true, status: 200, json: async () => ({ ok: true, version: '1.4.0', commit: 'abc1234def' }) };
  });
  assert.deepEqual(ok, { ok: true, version: '1.4.0', commit: 'abc1234' });
  const down = await desktop.checkHealth('https://srv.example', async () => { throw new Error('ENOTFOUND'); });
  assert.equal(down.ok, false);
  assert.match(down.error, /reach/);
  const notOurs = await desktop.checkHealth('https://srv.example', async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }));
  assert.equal(notOurs.ok, false);
  assert.match(notOurs.error, /FreeAI4U/);
});

test('a message box receives the text through the environment, never the command line', () => {
  const call = desktop.messageBoxCommand('Server "x"; rm -rf', 'FreeAI4U');
  assert.equal(call.command, 'powershell.exe');
  assert.ok(!call.args.join(' ').includes('rm -rf'), 'the text is not spliced into the script');
  assert.equal(call.env.FREEAI4U_MESSAGE, 'Server "x"; rm -rf');
});

test('the exe is switched to a windowed app without a console', () => {
  const pe = Buffer.alloc(512);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'latin1');
  const optional = 0x80 + 24;
  pe.writeUInt16LE(0x20b, optional); // PE32+
  pe.writeUInt16LE(3, optional + 68); // console
  const before = setGuiSubsystem(pe);
  assert.equal(before, 3);
  assert.equal(pe.readUInt16LE(optional + 68), 2);
  assert.throws(() => setGuiSubsystem(Buffer.from('not a pe file at all, no headers')), /PE/);
});
