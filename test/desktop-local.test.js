// The local folder: the rules the shell enforces (src-tauri/src/local.rs) and
// the frontend's copy of them (src/local-fs.js).
//
// The point of the mirror is that both surfaces must agree. If the shell
// protects one set of paths and the UI warns about a different set, the app is
// lying about what it will do -- so the lists are read out of the Rust source
// and asserted equal here, the same way test/desktop-net.test.js pins the host
// allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const localFs = require('../desktop/src/local-fs.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const rust = () => read('desktop', 'src-tauri', 'src', 'local.rs');

function rustStrings(source, name) {
  const block = source.match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
  assert.ok(block, `${name} must exist in local.rs`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function rustRisky(source) {
  const block = source.match(/pub const RISKY: &\[\(&str, &str\)\] = &\[([\s\S]*?)\n\];/);
  assert.ok(block, 'RISKY must exist in local.rs');
  return [...block[1].matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
}

// ---- the two copies cannot drift -----------------------------------------

test('the protected list is the same in the shell and the frontend', () => {
  const source = rust();
  assert.deepEqual(localFs.PROTECTED_DIRS, rustStrings(source, 'PROTECTED_DIRS'));
  assert.deepEqual(localFs.PROTECTED_FILES, rustStrings(source, 'PROTECTED_FILES'));
});

test('the commands that need approval are the same in both', () => {
  assert.deepEqual(localFs.RISKY, rustRisky(rust()));
});

test('the shell enforces the climb, the link and the protected path', () => {
  const source = rust();
  // `..` is walked, not string-matched, and the walk is bounded by the root.
  assert.match(source, /if !out\.pop\(\) \|\| !under\(&out, root\)/);
  // The nearest existing ancestor is canonicalised: a junction cannot escape.
  assert.match(source, /let real_root = std::fs::canonicalize\(root\)/);
  assert.match(source, /let real_probe = std::fs::canonicalize\(probe\)/);
  assert.match(source, /if !under\(&real_probe, &real_root\)/);
  // Writes check the protected path; reads do not (reading .env is allowed).
  assert.match(source, /fn write_text\(root: &Path, rel: &str, text: &str\)/);
  assert.match(source, /let protected = protected_path\(&relative\);/);
  // A risky command is refused unless the caller says a human approved it.
  assert.match(source, /if !approve_risky\.unwrap_or\(false\)/);
  // Output is capped, and a long run is killed rather than left forever.
  assert.match(source, /child\.kill\(\)/);
  assert.match(source, /MAX_RUN_OUTPUT/);
  // No console window flashes when a command runs (the old launch complaint).
  assert.match(source, /CREATE_NO_WINDOW/);
});

test('the shell registers every local command the frontend calls', () => {
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /mod local;/);
  for (const command of [
    'local::local_pick_folder',
    'local::local_list_dir',
    'local::local_read_file',
    'local::local_write_file',
    'local::local_edit_file',
    'local::local_run',
  ]) {
    assert.ok(main.includes(command), `${command} must be in the invoke handler`);
  }
});

test('a run that is stopped stops what it started', () => {
  const source = rust();
  // `cmd /C npm test` is two processes. Killing the shell leaves the test
  // runner writing into a folder the app has stopped watching -- the resource
  // leak the plan called "automatic cleanup", and on Windows the only honest
  // way to be sure is to kill the tree by its root pid.
  assert.ok(source.includes('fn kill_tree(child: &mut std::process::Child)'));
  assert.ok(source.includes('args(["/T", "/F", "/PID"'), 'the tree is killed by its root pid');
  assert.ok(source.includes('creation_flags(CREATE_NO_WINDOW)'), 'and without a console flashing over the panel');
  assert.ok(source.includes('child.wait()'), 'the root is reaped even if the tree kill failed');
  assert.ok(source.includes('kill_tree(&mut child)'), 'the timeout goes through it');
  assert.ok(!/child\.kill\(\);\s*\n\s*let _ = child\.wait\(\);\s*\n\s*timed_out/.test(source),
    'the timeout path no longer kills the shell alone');
});

test('the refusal wording the engine recognises is kept verbatim', () => {
  const source = rust();
  // agent-sessions.js classifies a failed tool call by these opening words.
  for (const phrase of ['Refused:', 'old_text was not found', 'run_command needs a command']) {
    assert.ok(source.includes(phrase), `${phrase} must survive the port`);
  }
  assert.ok(localFs.protectedPath('.git/config').startsWith('Refused:'));
  assert.ok(localFs.protectedPath('.env').startsWith('Refused:'));
});

// ---- the rules, exercised ------------------------------------------------

test('a path stays inside the open folder', () => {
  const root = 'C:/work/app';
  assert.equal(localFs.joinInside(root, 'src/main.rs'), 'C:/work/app/src/main.rs');
  assert.equal(localFs.joinInside(root, './a/../b.txt'), 'C:/work/app/b.txt');
  assert.equal(localFs.joinInside(root, ''), 'C:/work/app');
  assert.equal(localFs.joinInside(root, 'src\\lib\\x.ts'), 'C:/work/app/src/lib/x.ts');
  assert.equal(localFs.joinInside(root, 'a/b/../..'), 'C:/work/app');
});

test('a path that climbs out is refused, however it is spelled', () => {
  const root = 'C:/work/app';
  for (const bad of [
    '..',
    '../secrets.txt',
    'a/../../secrets.txt',
    '/etc/passwd',
    'C:/Windows/System32/cmd.exe',
    'dir:stream',
    'a\0b',
    '',
  ].filter((value) => value !== '')) {
    assert.equal(localFs.joinInside(root, bad), null, `${bad} must be refused`);
  }
});

test('the folder boundary is not a string prefix', () => {
  assert.equal(localFs.relativeWithin('C:/work/app', 'C:/work/app/x/y.ts'), 'x/y.ts');
  assert.equal(localFs.relativeWithin('C:/work/app', 'C:/work/app'), '');
  assert.equal(localFs.joinInside('C:/work/app', ''), 'C:/work/app');
});

test('secrets and git internals are writable by nobody', () => {
  assert.equal(localFs.protectedPath('src/main.rs'), '');
  assert.equal(localFs.protectedPath('.env.example'), '');
  assert.match(localFs.protectedPath('.env'), /never written/);
  assert.match(localFs.protectedPath('app/.env.local'), /never written/);
  assert.match(localFs.protectedPath('.git/HEAD'), /managed by git/);
  assert.match(localFs.protectedPath('nested/.git/objects/x'), /managed by git/);
});

test('a destructive command names itself and its danger', () => {
  for (const safe of ['git status', 'npm test', 'ls -la', 'npm run build', 'git commit -m x']) {
    assert.equal(localFs.riskOf(safe), null, `${safe} should not need approval`);
  }
  assert.match(localFs.riskOf('git push origin main'), /pushes commits/);
  assert.match(localFs.riskOf('git status && git push'), /pushes commits/);
  assert.match(localFs.riskOf('rm -rf node_modules'), /deletes a tree/);
  assert.match(localFs.riskOf('Remove-Item -Recurse -Force .'), /deletes a tree/);
  assert.match(localFs.riskOf('SHUTDOWN /s'), /powers the machine off/);
});

// ---- the decision that makes it a terminal -------------------------------

test('cd is handled here, so the next command starts where the last one ended', () => {
  const root = 'C:/work/app';
  const into = localFs.applyCd(root, '', 'cd src');
  assert.equal(into.handled, true);
  assert.equal(into.cwd, 'src');
  assert.equal(into.run, null);

  const up = localFs.applyCd(root, 'src/lib', 'cd ..');
  assert.equal(up.cwd, 'src');

  const back = localFs.applyCd(root, 'src/lib', 'cd ../..');
  assert.equal(back.cwd, '');

  // '' is the open folder itself -- what local_run reads as "the root".
  const home = localFs.applyCd(root, 'src', 'cd');
  assert.equal(home.cwd, '');
  assert.equal(localFs.applyCd(root, 'src', 'cd /').cwd, '');
  assert.equal(localFs.applyCd(root, 'src', 'cd ..').cwd, '');
  assert.equal(localFs.applyCd(root, '', 'cd ..').cwd, '');
});

test('cd cannot leave the folder either', () => {
  const out = localFs.applyCd('C:/work/app', '', 'cd ../../Windows');
  assert.equal(out.handled, true);
  assert.match(out.err, /climbs out of the open folder/);
  assert.equal(out.run, null);
});

test('cd with a command after it runs there in one line', () => {
  const chained = localFs.applyCd('C:/work/app', '', 'cd desktop && npm test');
  assert.equal(chained.cwd, 'desktop');
  assert.equal(chained.run, 'npm test');
  // cmd.exe spells "change drive too" as /d; there is only one folder here.
  assert.equal(localFs.applyCd('C:/work/app', '', 'cd /d src').cwd, 'src');
  assert.equal(localFs.applyCd('C:/work/app', 'src', 'cd "my folder"').cwd, 'src/my folder');
});

test('pwd is answered from the tracked cwd, and other commands are left alone', () => {
  const shown = localFs.applyCd('C:/work/app', 'src/lib', 'pwd');
  assert.equal(shown.handled, true);
  assert.equal(shown.out, 'C:/work/app/src/lib');
  assert.equal(localFs.applyCd('C:/work/app', 'src', 'npm test').handled, false);
  assert.equal(localFs.applyCd('C:/work/app', 'src', 'echo cd').handled, false);
});

// ---- how a row reads -----------------------------------------------------

test('a file row knows what it is', () => {
  assert.equal(localFs.kindOf({ dir: true, name: 'src' }), 'folder');
  assert.equal(localFs.kindOf({ ext: 'ts' }), 'code');
  assert.equal(localFs.kindOf({ ext: 'RS' }), 'code');
  assert.equal(localFs.kindOf({ ext: 'md' }), 'doc');
  assert.equal(localFs.kindOf({ ext: 'png' }), 'image');
  assert.equal(localFs.kindOf({ ext: 'json' }), 'data');
  assert.equal(localFs.kindOf({ ext: 'gguf' }), 'unknown');
  assert.equal(localFs.kindOf({}), 'unknown');
});

// ---- the screens that use it ---------------------------------------------

test('the sidebar offers the local surfaces, not the engine ones', () => {
  const sidebar = read('desktop', 'src', 'Sidebar.tsx');
  assert.match(sidebar, /id: 'local', label: 'Local'/);
  assert.match(sidebar, /key: 'folder', label: 'Folder'/);
  // The engine's tree and terminal are no longer a sidebar row: they only
  // answer with WORKSPACE_RUN=1 on a signed-in engine.
  assert.ok(!/label: 'Workspace'/.test(sidebar), 'the engine workspace is not a main panel');
  const settings = read('desktop', 'src', 'screens', 'SettingsScreen.tsx');
  assert.match(settings, /Engine shell \(needs WORKSPACE_RUN=1 on the server\)/);
  assert.match(settings, /<FileTree \/>/);
  assert.match(settings, /<Terminal \/>/);
});

test('the dock stays mounted while hidden, and the folder has one owner', () => {
  const app = read('desktop', 'src', 'App.tsx');
  // A terminal that unmounts loses its scrollback; hiding it must not.
  assert.match(app, /dock-slot dock-hidden/);
  // One state owns the folder, and it is remembered between launches.
  assert.match(app, /freeai4u\.localRoot/);
  assert.match(app, /const \[localRoot, setLocalRoot\]/);
  assert.match(app, /<LocalScreen[\s\S]{0,120}root=\{localRoot\}/);
  assert.match(app, /<LocalTerminal[\s\S]{0,160}root=\{localRoot\}/);
  // Choosing a folder goes through the shell's native dialog.
  assert.match(app, /pickFolder\(\)/);
});

test('the local terminal streams, and settles on the result either way', () => {
  const dock = read('desktop', 'src', 'components', 'LocalTerminal.tsx');
  // Live chunks are routed by the run's id, never by the command text.
  assert.match(dock, /h\.runId !== chunk\.runId/);
  assert.match(dock, /useLocalRun\(/);
  // The settled result replaces the live preview, so exit codes and timings
  // show even if no event ever arrived.
  assert.match(dock, /runResult\.formatRun\(res\)/);
  assert.match(dock, /localFs\.applyCd\(root, cwd, command\)/);
  assert.match(dock, /localFs\.riskOf\(command\)/);
  // Subscribing is best-effort; the run result is the mechanism.
  const hook = read('desktop', 'src', 'useLocalRun.ts');
  assert.match(hook, /onLocalRun\(/);
  assert.match(hook, /latest\.current\(chunk\)/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /plugin:event\|listen/);
  assert.match(bridge, /plugin:event\|unlisten/);
});

test('the viewer is read-only, and the write path is the agent\'s', () => {
  const screen = read('desktop', 'src', 'screens', 'LocalScreen.tsx');
  assert.match(screen, /readLocalFile/);
  assert.ok(!/writeLocalFile|editLocalFile/.test(screen), 'the viewer never writes');
  assert.match(screen, /read-only/);
  // Both write paths exist in the shell, for the agent that asks first.
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /local::local_write_file/);
  assert.match(main, /local::local_edit_file/);
});

// ---- the throwaway folder -------------------------------------------------
//
// The plan calls this the build sandbox. It is not a security boundary and the
// shell says so in its own comment; what it is is a promise that a run asked
// for in scratch mode cannot write into the folder being worked on. These tests
// hold the promise to the parts that can be checked without running the app.

test('a scratch run is given its own folder, outside the project', () => {
  const source = rust();
  const body = source.match(/fn scratch_dir\([\s\S]*?\n\}/);
  assert.ok(body, 'scratch_dir must exist');
  // Somewhere the app owns, never inside the open folder: a scratch run that
  // started in the project would be the thing this mode exists to avoid.
  assert.match(body[0], /app_cache_dir/);
  assert.doesNotMatch(body[0], /root/);
});

test('the scratch folder is deleted whatever the run did', () => {
  // Line endings are whatever the checkout says; the rule is about order.
  const source = rust().replace(/\r\n/g, '\n');
  // Removed once, after the streams are joined and before the result is built,
  // so the success, failure and timeout paths all leave nothing behind.
  const cleanup = source.match(/let in_sandbox = scratch\.is_some\(\);\n\s*if let Some\(dir\) = &scratch \{\n\s*let _ = std::fs::remove_dir_all\(dir\);/);
  assert.ok(cleanup, 'the scratch folder must be removed on the way out');
  assert.ok(
    source.indexOf('let in_sandbox') < source.indexOf('"runId": run_id'),
    'cleanup happens before the result is returned',
  );
});

test('a run id from the frontend cannot climb out of the sandbox', () => {
  const source = rust();
  assert.match(source, /fn safe_segment\(raw: &str\) -> String/);
  assert.match(source, /c\.is_ascii_alphanumeric\(\) \|\| \*c == '-' \|\| \*c == '_'/);
  assert.match(source, /a_scratch_name_cannot_climb_out_of_its_folder/);
});

test('a sandbox run cannot also be given a cwd', () => {
  const source = rust();
  // Two answers to "where does this run" is one answer too many, and silently
  // preferring one of them is how a caller ends up running somewhere it did
  // not ask for.
  assert.match(source, /a sandbox run starts in its own empty folder/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /sandbox: args\.sandbox \?\? false/);
  assert.match(bridge, /cwd: args\.cwd \?\? ''/);
});

test('the terminal offers scratch mode and says where the run went', () => {
  const dock = read('desktop', 'src', 'components', 'LocalTerminal.tsx');
  assert.match(dock, /dock-toggle \$\{scratch \? 'on' : ''\}/);
  assert.match(dock, /sandbox: inScratch/);
  // Scratch mode has no folders to move between, so `cd` is answered rather
  // than silently ignored.
  assert.match(dock, /Scratch mode has no folders to move between/);
  // A run that reaches a prompt carries its mode with it, or approving it would
  // quietly run it somewhere else.
  assert.match(dock, /pending: \{ command, cwd: runCwd, reason, scratch \}/);
  assert.match(dock, /entry\.pending\.scratch/);
  assert.match(dock, /scratch \? 'scratch' : cwdPath/);
});

test('the result says it ran in a throwaway folder', () => {
  const runResult = require('../desktop/src/run-result.js');
  const plain = runResult.formatRun({ stdout: 'hi', exitCode: 0, durationMs: 5 });
  assert.doesNotMatch(plain.out, /throwaway/);
  const scratch = runResult.formatRun({ stdout: 'hi', exitCode: 0, durationMs: 5, sandbox: true });
  assert.match(scratch.out, /in a throwaway folder/);
});

test('sizes and folder names read the way a person would say them', () => {
  assert.equal(localFs.formatBytes(0), '');
  assert.equal(localFs.formatBytes(512), '512 B');
  assert.equal(localFs.formatBytes(2048), '2 KB');
  assert.equal(localFs.formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(localFs.rootLabel('C:/work/my-app'), 'my-app');
  assert.equal(localFs.rootLabel(''), '');
  assert.equal(localFs.parentOf('src/lib/x.ts'), 'src/lib');
  assert.equal(localFs.parentOf('src'), '');
});
