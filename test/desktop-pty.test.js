// NEURA-058: the real terminal -- a PTY in the shell (desktop/src-tauri/src/pty.rs)
// driving xterm.js in the page (desktop/src/components/PtyTerminal.tsx).
//
// There is no PTY to open here: this suite runs under plain node, the Rust side
// compiles only on CI, and a pseudo-terminal needs an OS handle nothing in this
// process holds. So these are the assertions that can be made honestly without
// one, and they are the ones that matter for review:
//
//   * the bridge surface exists and is typed the way the shell's commands read;
//   * the gate that a destructive AGENT command passes today has not quietly
//     been dropped -- pty_run still asks local::risk_of(), and the user's own
//     keystrokes are the only ungated path;
//   * the output buffer has a ceiling, so a `yes` loop cannot grow memory;
//   * teardown is wired: the screen, a re-open, and the app's own Quit;
//   * Cargo.toml and package.json actually declare the dependencies the code
//     imports, so a green type-check cannot hide a missing crate or package.
//
// test/desktop-local.test.js pins the one-shot runner's rules the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const pty = () => read('desktop', 'src-tauri', 'src', 'pty.rs');
const local = () => read('desktop', 'src-tauri', 'src', 'local.rs');
const main = () => read('desktop', 'src-tauri', 'src', 'main.rs');
const bridge = () => read('desktop', 'src', 'bridge.ts');
const screen = () => read('desktop', 'src', 'components', 'PtyTerminal.tsx');
const dock = () => read('desktop', 'src', 'components', 'LocalTerminal.tsx');

// ---- the dependencies are declared, not just imported ---------------------

test('the shell declares portable-pty, pinned and without default features', () => {
  const cargo = read('desktop', 'src-tauri', 'Cargo.toml');
  const line = cargo.match(/^portable-pty = \{ version = "([^"]+)", default-features = false \}$/m);
  assert.ok(line, 'Cargo.toml must declare portable-pty');
  // 0.9.x is the release that carries ConPTY on Windows and builds on the
  // stable toolchain CI uses. A bare "0.9" would also take 0.9.99; the exact
  // floor is what was read against the docs.
  assert.equal(line[1], '0.9.0');
  // The crate must not be reintroduced elsewhere with different features.
  assert.equal((cargo.match(/portable-pty/g) || []).length, 1);
});

test('the page declares xterm and the fit addon', () => {
  const pkg = JSON.parse(read('desktop', 'package.json'));
  assert.ok(pkg.dependencies['@xterm/xterm'], '@xterm/xterm must be a dependency');
  assert.ok(pkg.dependencies['@xterm/addon-fit'], '@xterm/addon-fit must be a dependency');
  // A dependency that is not in the lock file is a dependency CI will resolve
  // differently from this machine.
  const lock = JSON.parse(read('desktop', 'package-lock.json'));
  assert.ok(lock.packages['node_modules/@xterm/xterm'], 'the lock file must carry @xterm/xterm');
  assert.ok(lock.packages['node_modules/@xterm/addon-fit'], 'the lock file must carry @xterm/addon-fit');
});

test('the shell registers the module and every command it exposes', () => {
  const source = main();
  assert.match(source, /^mod pty;$/m);
  for (const command of ['pty_open', 'pty_write', 'pty_run', 'pty_resize', 'pty_close', 'pty_list']) {
    assert.match(source, new RegExp(`pty::${command},`), `${command} must be registered`);
    assert.match(pty(), new RegExp(`pub fn ${command}\\(`), `${command} must exist`);
  }
});

// ---- the gate ------------------------------------------------------------

test('a command from an agent still passes the same gate as local_run', () => {
  const source = pty();
  const body = source.slice(source.indexOf('pub fn pty_run('));
  assert.ok(body, 'pty_run must exist');
  // The same predicate, from the same module -- not a second copy of the list.
  assert.match(body, /local::risk_of\(trimmed\)/);
  assert.match(body, /if !approve_risky\.unwrap_or\(false\)/);
  // ...and the same words, because agent-sessions.js classifies a failed tool
  // call by how the refusal opens.
  assert.match(body, /Refused: that command \{\} \(\{\}\)\. Approve it to run it anyway\./);
  assert.match(local(), /Refused: that command \{\} \(\{\}\)\. Approve it to run it anyway\./);
  // A second line would reach the shell without having been judged.
  assert.match(body, /trimmed\.contains\('\\n'\) \|\| trimmed\.contains\('\\r'\)/);
});

test('the risky list is not copied into the pty module', () => {
  // One list, in local.rs. A second one here is how two surfaces start
  // disagreeing about what needs a human.
  const source = pty();
  assert.ok(!source.includes('RISKY'), 'pty.rs must not hold its own list');
  assert.ok(!/fn risk_of/.test(source), 'pty.rs must not define its own predicate');
  // Every mention of the rule IN CODE is a call into local.rs (the prose above
  // each command names it too, and prose is not a second implementation).
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const hit of code.match(/[A-Za-z:]*risk_of/g) || []) {
    assert.equal(hit, 'local::risk_of', 'the only risk_of is local.rs own');
  }
});

test('the ungated path is the keyboard, and it is the only one', () => {
  const source = pty();
  // The body only: the doc comment that follows it belongs to pty_run, which
  // does gate.
  const opens = source.indexOf('pub fn pty_write(');
  const write = source.slice(opens, source.indexOf('\n}\n', opens));
  // pty_write does NOT gate: a live shell the user types into is their shell.
  assert.ok(!write.includes('risk_of'), 'pty_write must not pretend to gate keystrokes');
  // And the file has to say why, so the choice is reviewable rather than lost.
  assert.match(source, /THE SAFETY GATE, AND WHY IT MOVED RATHER THAN VANISHED/);

  // In the page, ptyWrite is reachable only from the terminal component: the
  // agent's own tools must not be able to type into the live shell.
  const callers = fs
    .readdirSync(path.join(ROOT, 'desktop', 'src'), { recursive: true })
    .filter((f) => typeof f === 'string' && /\.(ts|tsx|js)$/.test(f))
    .filter((f) => /\bptyWrite\b/.test(read('desktop', 'src', f)))
    .map((f) => f.replace(/\\/g, '/'))
    .sort();
  assert.deepEqual(callers, ['bridge.ts', 'components/PtyTerminal.tsx']);
});

test('the coding agent still runs commands through the gated one-shot runner', () => {
  // NEURA-058 replaced the dock, not the agent's tool. run_command is still
  // local_run, which refuses a destructive command before it is spawned.
  assert.match(read('desktop', 'src', 'coding-agent.js'), /run_command/);
  assert.match(bridge(), /call<LocalRunResult>\('local_run'/);
  assert.ok(!read('desktop', 'src', 'coding-agent.js').includes('ptyRun'));
});

// ---- the buffer ----------------------------------------------------------

test('a flood of output is bounded in memory and in event rate', () => {
  const source = pty();
  const cap = source.match(/const MAX_PENDING: usize = (\d+) \* 1024;/);
  assert.ok(cap, 'MAX_PENDING must exist');
  assert.ok(Number(cap[1]) * 1024 <= 1024 * 1024, 'the buffer ceiling must be small');
  // Past the ceiling the OLDEST bytes go -- a terminal shows the newest screen.
  assert.match(source, /let cut = pending\.len\(\) - MAX_PENDING;/);
  assert.match(source, /pending\.drain\(\.\.cut\);/);
  // And the page is told, rather than being quietly lied to.
  assert.match(source, /"dropped": \*dropped/);
  assert.match(screen(), /chunk\.dropped/);
  // The event rate is throttled too: an unbounded stream of small events is
  // the other half of how `yes` takes the window down.
  assert.match(source, /const FLUSH_EVERY: Duration = Duration::from_millis\(\d+\);/);
  assert.match(source, /last\.elapsed\(\) >= FLUSH_EVERY/);
  assert.match(source, /rx\.recv_timeout\(FLUSH_EVERY\)/);
});

test('bytes reach the page as bytes, not as a lossy string', () => {
  // A pty splits UTF-8 wherever the read ended; String::from_utf8_lossy here
  // would write a permanent replacement mark into the user's scrollback.
  const source = pty();
  assert.ok(!source.includes('from_utf8_lossy'), 'output must not be lossily decoded in Rust');
  assert.match(source, /STANDARD\.encode\(&pending\[\.\.\]\)/);
  assert.match(bridge(), /export function ptyBytes\(data: string\): Uint8Array/);
  assert.match(screen(), /term\.write\(ptyBytes\(chunk\.data\)\)/);
});

// ---- teardown ------------------------------------------------------------

test('a terminal dies with its screen, with a re-open, and with the app', () => {
  const source = pty();
  // The screen: the component closes its session when it unmounts.
  assert.match(screen(), /ptyClose\(id\)\.catch/);
  // A re-open of the same id is a restart, not a second shell.
  assert.match(source, /\/\/ A re-open is a restart\./);
  assert.match(source, /close\(id\.clone\(\)\)\?;/);
  // The app: pty.rs arms its own listener for the event main.rs already emits
  // on tray Quit, so no second place has to remember to call shutdown().
  assert.match(source, /app\.listen\("app-quitting", \|_\| shutdown\(\)\)/);
  assert.match(main(), /app\.emit\("app-quitting", \(\)\)/);
  assert.match(source, /pub fn shutdown\(\)/);
  assert.match(source, /lock\(sessions\(\)\)\.drain\(\)/);
  // The shell AND what it started: cmd /c npm test is two processes.
  assert.match(source, /fn kill_tree\(pid: Option<u32>\)/);
  assert.match(source, /"taskkill"/);
  assert.match(source, /\.args\(\["\/T", "\/F", "\/PID", &pid\.to_string\(\)\]\)/);
  // A child that is never waited for is a zombie, and a session left in the
  // map is a terminal the user can still type into after it has gone.
  assert.match(source, /let status = child\.wait\(\);/);
  assert.match(source, /guard\.remove\(&id\);/);
  // ...and it forgets only its OWN session: a close-then-open of the same id
  // puts a live shell under that key while this thread is parked in wait().
  assert.match(source, /Arc::ptr_eq\(&current\.alive, &alive\)/);
  // Holding the slave end would keep the pty open after the shell exits, so
  // the reader would never see EOF and the threads would never stop.
  assert.match(source, /drop\(slave\);/);
});

test('the id a page makes up cannot become a path or collide on nothing', () => {
  const source = pty();
  assert.match(source, /fn safe_id\(raw: &str\) -> Result<String, String>/);
  assert.match(source, /is_ascii_alphanumeric\(\) \|\| \*c == '-' \|\| \*c == '_'/);
  assert.match(source, /\.take\(64\)/);
  // Every command that takes an id sanitises it, so pty_close cannot miss the
  // session pty_open created.
  for (const command of ['pty_open', 'pty_write', 'pty_run', 'pty_resize', 'pty_close']) {
    const body = source.slice(source.indexOf(`pub fn ${command}(`), source.indexOf(`pub fn ${command}(`) + 900);
    assert.match(body, /let id = safe_id\(&id\)\?;/, `${command} must sanitise its id`);
  }
});

test('the shell starts inside the open folder, by local.rs own resolver', () => {
  const source = pty();
  assert.match(source, /local::resolve_inside\(&root_path, rel\)\?/);
  // A size the page got wrong is clamped rather than handed to the OS.
  assert.match(source, /fn clamp\(value: Option<u16>, fallback: u16, low: u16, high: u16\) -> u16/);
  assert.match(source, /\.clamp\(low, high\)/);
});

// ---- the bridge surface --------------------------------------------------

test('the bridge wraps every pty command and both events', () => {
  const source = bridge();
  const wrappers = [
    ["ptyOpen", "'pty_open'"],
    ["ptyWrite", "'pty_write'"],
    ["ptyRun", "'pty_run'"],
    ["ptyResize", "'pty_resize'"],
    ["ptyClose", "'pty_close'"],
    ["ptyList", "'pty_list'"],
  ];
  for (const [name, command] of wrappers) {
    assert.match(source, new RegExp(`export (async )?function ${name}\\b`), `${name} must be exported`);
    assert.ok(source.includes(command), `${name} must call ${command}`);
  }
  assert.match(source, /subscribe<PtyOutput>\('pty-output', handler\)/);
  assert.match(source, /subscribe<PtyExit>\('pty-exit', handler\)/);
  // The agent's approval flag has to cross the boundary, or the gate can never
  // be satisfied and "Run it anyway" would do nothing.
  assert.match(source, /call\('pty_run', \{ id, command, approveRisky \}\)/);
});

// ---- the dock ------------------------------------------------------------

test('the dock is the PTY, with the one-shot runner kept as a named fallback', () => {
  const source = dock();
  assert.match(source, /import PtyTerminal from '\.\/PtyTerminal'/);
  assert.match(source, /export default function LocalTerminal\(props: LocalTerminalProps\)/);
  assert.match(source, /if \(noPty\) return <OneShotTerminal \{\.\.\.props\} \/>;/);
  // The fallback is one-way: flipping back would restart the shell under a
  // user who is already typing.
  assert.match(source, /onUnavailable=\{onUnavailable\}/);
  // The fallback is a real terminal, not a stub: it keeps the destructive gate
  // this file has always carried.
  assert.match(source, /localFs\.riskOf\(command\)/);
  assert.match(source, /function OneShotTerminal\(/);
  // App.tsx still mounts one component, so nothing outside these files moved.
  assert.match(read('desktop', 'src', 'App.tsx'), /import LocalTerminal from '\.\/components\/LocalTerminal'/);
});

test('the terminal sizes itself and tells the shell', () => {
  const source = screen();
  // A shell that believes the wrong width wraps every line in the wrong place.
  assert.match(source, /new FitAddon\(\)/);
  assert.match(source, /ptyResize\(id, term\.cols, term\.rows\)/);
  assert.match(source, /new ResizeObserver\(refit\)/);
  // Colour: the shell is told it is on a real terminal, or it prints no
  // escapes at all and the whole exercise is pointless.
  assert.match(pty(), /builder\.env\("TERM", "xterm-256color"\)/);
  // Ctrl+C must stay an interrupt, so copy and paste take the shifted chord.
  assert.match(source, /if \(!event\.ctrlKey \|\| !event\.shiftKey/);
  // The stylesheet comes from the package; the dock does not own index.css.
  assert.match(source, /import '@xterm\/xterm\/css\/xterm\.css'/);
});

test('no bare TODO was left behind', () => {
  for (const source of [pty(), screen(), dock(), bridge()]) {
    for (const hit of source.match(/TODO[^(]/g) || []) {
      assert.fail(`a TODO must name an open backlog row: ${hit}`);
    }
  }
});
