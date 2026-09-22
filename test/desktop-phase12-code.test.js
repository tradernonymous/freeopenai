// Phase 12e: code helpers (test-writer, doc-writer, pr-opener agents), the
// Monaco editor on the Local screen, the opt-in Docker sandbox for the coding
// agent's run_command, and the language-server MCP preset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const agents = require('../desktop/src/agents.js');
const docker = require('../desktop/src/docker-sandbox.js');

function memory() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    data,
  };
}

// ---- code-helper agents ---------------------------------------------------------------

test('the three code helpers are built-ins and pass agents.js validation', () => {
  for (const id of ['test-writer', 'doc-writer', 'pr-opener']) {
    const raw = agents.BUILTINS.find((b) => b.id === id);
    assert.ok(raw, id);
    const checked = agents.validate(raw);
    assert.equal(checked.ok, true, `${id}: ${checked.errors.join(' ')}`);
    assert.deepEqual(checked.warnings, [], id);
    assert.equal(agents.codeReason(raw), '', `${id} carries no code`);
    assert.ok(agents.get(id, memory()), `${id} is listed`);
  }
});

test('test-writer runs tests, iterates at most twice and never edits the code under test', () => {
  const a = agents.BUILTINS.find((b) => b.id === 'test-writer');
  assert.deepEqual(a.toolNames, ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command']);
  assert.match(a.systemPrompt, /at most twice/);
  assert.match(a.systemPrompt, /never the code under test/);
  assert.match(a.systemPrompt, /Never add a new test framework/);
});

test('doc-writer only edits, and only comments', () => {
  const a = agents.BUILTINS.find((b) => b.id === 'doc-writer');
  assert.deepEqual(a.toolNames, ['list_files', 'read_file', 'edit_file']);
  assert.ok(!a.toolNames.includes('write_file') && !a.toolNames.includes('run_command'));
  assert.match(a.systemPrompt, /change ONLY comments and\s+docstrings/);
});

test('pr-opener summarises git diff, pushes and opens a PR, all through approved tools', () => {
  const a = agents.BUILTINS.find((b) => b.id === 'pr-opener');
  assert.ok(a.toolNames.includes('run_command'));
  assert.ok(a.toolNames.includes('github/create_pull_request'));
  assert.ok(!a.toolNames.includes('write_file'), 'it does not write files');
  assert.equal(agents.toolName('github/create_pull_request'), 'mcp__github__create_pull_request');
  assert.match(a.systemPrompt, /git diff/);
  assert.match(a.systemPrompt, /git push -u origin/);
  assert.match(a.systemPrompt, /never\s+git add -A/);
  assert.match(a.systemPrompt, /Never\s+force-push/);
  assert.match(a.systemPrompt, /gh pr create/);
});

test('recipes have no built-ins, so the helper recipes ship as importable JSON in the docs and import cleanly', () => {
  const recipes = require('../desktop/src/recipes.js');
  const doc = read('docs', 'desktop.md');
  const block = /```json\n(\{"recipes": \[[\s\S]*?\]\})\n```/.exec(doc);
  assert.ok(block, 'the recipes JSON block is in docs/desktop.md');
  const parsed = recipes.parseImport(block[1]);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.recipes.map((r) => r.id), ['write-tests', 'add-docs', 'open-pr']);
});

// ---- Docker sandbox ---------------------------------------------------------------------

test('wrap builds the documented docker line', () => {
  const win = docker.wrap({ root: 'C:\\cc_work\\my proj', command: 'npm test' });
  assert.deepEqual(win, { ok: true, command: 'docker run --rm -v "C:\\cc_work\\my proj:/work" -w /work node:22-bookworm sh -lc "npm test"' });
  const posix = docker.wrap({ root: '/home/me/app', command: "grep -r 'a b' src", cwd: 'packages\\web', image: 'python:3.12-slim' });
  assert.equal(posix.command, 'docker run --rm -v "/home/me/app:/work" -w "/work/packages/web" python:3.12-slim sh -lc "grep -r \'a b\' src"');
  assert.equal(docker.wrap({ root: '/r', command: 'ls', cwd: './' }).command, 'docker run --rm -v "/r:/work" -w /work node:22-bookworm sh -lc "ls"');
});

test('wrap refuses what it cannot quote rather than escaping it', () => {
  const refusals = [
    ['echo "hi"', /double quote/],
    ['echo `id`', /backtick/],
    ['echo $HOME', /dollar/],
    ['echo %PATH%', /percent/],
    ['printf a\\nb', /backslash/],
    ['ls\nrm -rf /', /line break/],
  ];
  for (const [command, why] of refusals) {
    const r = docker.wrap({ root: '/r', command });
    assert.equal(r.ok, false, command);
    assert.match(r.reason, why, command);
    assert.match(r.reason, /Refused/);
  }
  assert.equal(docker.wrap({ root: '/r', command: '   ' }).ok, false);
  assert.match(docker.wrap({ root: 'C:\\a"b', command: 'ls' }).reason, /double quote/);
  assert.match(docker.wrap({ root: '/a/$x', command: 'ls' }).reason, /dollar/);
  assert.match(docker.wrap({ root: '/a:b', command: 'ls' }).reason, /":"/);
  assert.match(docker.wrap({ root: '\\\\server\\share', command: 'ls' }).reason, /Network paths/);
  assert.match(docker.wrap({ root: '', command: 'ls' }).reason, /Open a folder/);
  assert.equal(docker.wrap({ root: '/r', command: 'ls', cwd: '../up' }).ok, false);
  assert.equal(docker.wrap({ root: '/r', command: 'ls', cwd: '/etc' }).ok, false);
  assert.equal(docker.wrap({ root: '/r', command: 'ls', cwd: 'C:/x' }).ok, false);
  assert.equal(docker.wrap({ root: '/r', command: 'ls', image: 'bad image; rm' }).ok, false);
  assert.equal(docker.wrap({ root: '/r', command: 'ls', image: 'ghcr.io/org/img:1.2@sha256:abc' }).ok, true);
});

test('settings live under freeai4u.docker_sandbox, off with node:22-bookworm by default', () => {
  const store = memory();
  assert.equal(docker.KEY, 'freeai4u.docker_sandbox');
  assert.deepEqual(docker.settings(store), { enabled: false, image: 'node:22-bookworm' });
  assert.equal(docker.saveSettings({ enabled: true, image: '  ' }, store), true);
  assert.deepEqual(JSON.parse(store.data['freeai4u.docker_sandbox']), { enabled: true, image: 'node:22-bookworm' });
  store.setItem(docker.KEY, '{not json');
  assert.equal(docker.settings(store).enabled, false);
});

test('run: straight through when off; with it on, checks docker version once, then runs wrapped', async () => {
  docker.resetCheck();
  const calls = [];
  const runner = async (command, cwd, timeoutMs) => {
    calls.push({ command, cwd, timeoutMs });
    return { exitCode: 0, timedOut: false, stdout: 'ok', stderr: '' };
  };
  await docker.run({ root: '/r', command: 'npm test', cwd: 'sub', settings: { enabled: false, image: 'x' } }, runner);
  assert.deepEqual(calls[0], { command: 'npm test', cwd: 'sub', timeoutMs: undefined });

  const on = { enabled: true, image: 'node:22-bookworm' };
  await docker.run({ root: '/r', command: 'npm test', settings: on }, runner);
  await docker.run({ root: '/r', command: 'npm run lint', settings: on }, runner);
  assert.deepEqual(calls.slice(1).map((c) => c.command), [
    'docker version',
    'docker run --rm -v "/r:/work" -w /work node:22-bookworm sh -lc "npm test"',
    'docker run --rm -v "/r:/work" -w /work node:22-bookworm sh -lc "npm run lint"',
  ]);
  assert.equal(calls[2].timeoutMs, docker.RUN_TIMEOUT_MS);
});

test('run: Docker not running is said plainly, nothing runs, and the check is retried next time', async () => {
  docker.resetCheck();
  const on = { enabled: true, image: 'node:22-bookworm' };
  const calls = [];
  let up = false;
  const runner = async (command) => {
    calls.push(command);
    if (command === 'docker version') {
      return up ? { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
        : { exitCode: 1, timedOut: false, stdout: '', stderr: 'error during connect: is the docker daemon running?' };
    }
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  };
  await assert.rejects(docker.run({ root: '/r', command: 'npm test', settings: on }, runner), (e) => {
    assert.match(e.message, /Docker is not running, so nothing was run/);
    assert.match(e.message, /start Docker Desktop/);
    assert.match(e.message, /docker daemon running/);
    return true;
  });
  assert.deepEqual(calls, ['docker version']);
  up = true;
  await docker.run({ root: '/r', command: 'npm test', settings: on }, runner);
  assert.equal(calls.length, 3);
  await assert.rejects(docker.run({ root: '/r', command: 'echo "x"', settings: on }, runner), /double quote/);
  docker.resetCheck();
});

test('both coding-agent runCmd callbacks go through the Docker sandbox; the toggle is on the Code screen', () => {
  const code = read('desktop', 'src', 'screens', 'CodeScreen.tsx');
  const parallel = read('desktop', 'src', 'screens', 'ParallelScreen.tsx');
  for (const src of [code, parallel]) {
    assert.match(src, /import '\.\.\/docker-sandbox\.js';/);
    assert.match(src, /runCmd:[\s\S]{0,200}?dockerSandbox\.run\(/);
    assert.doesNotMatch(src, /runCmd:[^\n]*=> runLocal\(/, 'no runCmd bypasses the sandbox');
  }
  assert.match(code, /Run agent commands in Docker/);
  assert.match(code, /dockerSandbox\.saveSettings\(/);
  assert.match(read('docs', 'desktop.md'), /project folder itself is mounted read-write/);
});

// ---- Monaco -------------------------------------------------------------------------------

test('Monaco is only a dynamic import, with local ?worker workers and no CDN', () => {
  const editor = read('desktop', 'src', 'components', 'CodeEditor.tsx');
  assert.match(editor, /import\('monaco-editor'\)/);
  assert.doesNotMatch(editor, /^import [^\n]*from 'monaco-editor/m, 'no static import of Monaco');
  for (const w of ['editor/editor.worker', 'language/json/json.worker', 'language/css/css.worker', 'language/html/html.worker', 'language/typescript/ts.worker']) {
    assert.match(editor, new RegExp(`import\\('monaco-editor/esm/vs/${w.replace(/\//g, '\\/').replace(/\./g, '\\.')}\\?worker'\\)`), w);
  }
  assert.match(editor, /MonacoEnvironment/);
  assert.doesNotMatch(editor, /https?:\/\/|jsdelivr|unpkg|@monaco-editor\/loader|loader\.config/i, 'no remote loader');
  assert.match(editor, /writeLocalFile\(root, path, value\)/, 'saves through the shell');
  assert.match(editor, /KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyS/);
  const pkg = JSON.parse(read('desktop', 'package.json'));
  assert.ok(pkg.dependencies['monaco-editor'], 'monaco-editor is a dependency');
});

test('the main entry never references Monaco; LocalScreen lazy-loads the editor and stays read-only by default', () => {
  const src = path.join(ROOT, 'desktop', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/CodeEditor\.tsx$/.test(entry.name)) {
        if (/monaco-editor/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], 'only CodeEditor.tsx names monaco-editor');
  for (const entry of ['main.tsx', 'App.tsx']) {
    assert.doesNotMatch(read('desktop', 'src', entry), /CodeEditor|monaco/i, entry);
  }
  const local = read('desktop', 'src', 'screens', 'LocalScreen.tsx');
  assert.match(local, /const CodeEditor = lazy\(\(\) => import\('\.\.\/components\/CodeEditor'\)\);/);
  assert.doesNotMatch(local, /^import CodeEditor/m);
  assert.match(local, /useState\(false\);\n\s*const \[dirty/, 'editing starts off');
  assert.match(local, /disabled=\{file\.truncated\}/, 'a truncated file cannot be edited');
});

// ---- language-server preset ------------------------------------------------------------------

test('ConnectorsCard keeps the browser preset and adds a language-server form with placeholders only', () => {
  const card = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  assert.match(card, /addPreset\(\{ name: 'browser', command: 'npx', args: \['-y', 'chrome-devtools-mcp@latest'\] \}\)/);
  assert.match(card, /Language server \(LSP\) MCP/);
  assert.match(card, /const LSP_PLACEHOLDER = '<package>';/);
  assert.match(card, /setArgsLine\(`-y \$\{LSP_PLACEHOLDER\} <args>`\)/);
  assert.match(card, /argsLine\.includes\(LSP_PLACEHOLDER\)/, 'a placeholder left in is refused');
  assert.match(read('docs', 'desktop.md'), /Language servers via MCP/);
});

test('Windows commands reach cmd raw, so quoted arguments survive', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'desktop', 'src-tauri', 'src', 'local.rs'), 'utf8');
  assert.match(src, /cmd\.raw_arg\(format!\("\\"\{\}\\"", command\)\)/, 'one pair of quotes that cmd /s strips');
  assert.ok(!/cmd\.args\(\["\/d", "\/s", "\/c", command\]\)/.test(src), 'never through .args(), which escapes inner quotes as \\"');
});
