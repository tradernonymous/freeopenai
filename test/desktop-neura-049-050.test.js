// NEURA-049 (`cargo test` runs in the Desktop CI job) and NEURA-050 (the Mica
// material on Windows 11).
//
// Both are wiring that is invisible until it is gone: nothing in the app fails
// if the CI step is deleted, and nothing fails if the Mica declaration is
// dropped from tauri.conf.json -- the build stays green and the window still
// opens. These are the assertions that would notice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const WORKFLOW = read('.github', 'workflows', 'desktop.yml');
const TAURI_CONF = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));
const MAIN_RS = read('desktop', 'src-tauri', 'src', 'main.rs');

// The job's steps in file order, as `- name: ...` lines. Order is the whole
// point of NEURA-049: a test step after the bundle is built is a report, not
// a gate.
const STEP_NAMES = WORKFLOW.split(/\r?\n/)
  .map((line) => /^\s*-\s+name:\s*(.+)$/.exec(line))
  .filter(Boolean)
  .map((m) => m[1].trim());

const stepIndex = (fragment) =>
  STEP_NAMES.findIndex((name) => name.toLowerCase().includes(fragment));

// ---- NEURA-049: a red Rust test fails the Desktop build -------------------

test('the Desktop job runs cargo test against the src-tauri crate', () => {
  const invocation = /cargo test[^\n]*--manifest-path\s+desktop\/src-tauri\/Cargo\.toml/;
  assert.match(
    WORKFLOW,
    invocation,
    'the Desktop workflow must run `cargo test --manifest-path desktop/src-tauri/Cargo.toml`',
  );
  // `continue-on-error` or a trailing `|| true` would keep the job green with
  // a failing test, which is exactly the state NEURA-049 exists to end.
  assert.doesNotMatch(WORKFLOW, /cargo test[^\n]*\|\|/, 'the cargo test step must not swallow failure');
  assert.doesNotMatch(WORKFLOW, /continue-on-error/, 'no step in this job may continue on error');
});

test('cargo test runs after the toolchain and before the bundle is built', () => {
  const rust = stepIndex('install rust');
  const tests = stepIndex('cargo test');
  const build = stepIndex('build tauri app');
  assert.ok(rust >= 0, 'the Rust toolchain step is missing');
  assert.ok(tests >= 0, 'the cargo test step is missing');
  assert.ok(build >= 0, 'the Tauri build step is missing');
  assert.ok(rust < tests, 'cargo test needs the toolchain installed first');
  assert.ok(tests < build, 'a red Rust test must fail the job BEFORE the installer is made');
});

test('the frontend is built before cargo test, because generate_context! embeds it', () => {
  // `cargo test` compiles the binary, and generate_context! refuses to compile
  // when `frontendDist` does not exist. Without this step the Rust tests could
  // not build at all.
  assert.equal(TAURI_CONF.build.frontendDist, '../dist');
  const frontend = stepIndex('build the frontend');
  const tests = stepIndex('cargo test');
  assert.ok(frontend >= 0, 'the frontend build step is missing');
  assert.ok(frontend < tests, 'the frontend must exist before the Rust crate is compiled');
});

test('the Rust unit tests the CI step exists for are really there', () => {
  // A green `cargo test` over a crate with no tests is theatre. These are the
  // modules that carry `#[cfg(test)] mod tests` today; the count is a floor,
  // not a fixture, so adding tests never breaks this.
  const srcDir = path.join(ROOT, 'desktop', 'src-tauri', 'src');
  const withTests = fs
    .readdirSync(srcDir)
    .filter((file) => file.endsWith('.rs'))
    .filter((file) => /#\[cfg\(test\)\]/.test(fs.readFileSync(path.join(srcDir, file), 'utf8')));
  assert.ok(
    withTests.length >= 10,
    `expected the src-tauri crate to carry unit tests in many modules, found ${withTests.length}`,
  );
  for (const required of ['local.rs', 'gguf.rs', 'net.rs', 'main.rs']) {
    assert.ok(withTests.includes(required), `${required} lost its unit tests`);
  }
});

// ---- NEURA-050: Mica, and the machines that must not get it ---------------

test('the main window declares the Mica material', () => {
  const windows = TAURI_CONF.app.windows;
  assert.ok(Array.isArray(windows) && windows.length > 0, 'the app declares no window');
  const main = windows[0];
  assert.ok(main.windowEffects, 'the main window declares no windowEffects');
  assert.deepEqual(
    main.windowEffects.effects,
    ['mica'],
    'the material must be Tauri\'s "mica" effect -- acrylic and blur are a different look and a different cost',
  );
});

test('the page keeps its own background: the shell is not made transparent yet', () => {
  // The material is only visible once the window is transparent AND the page
  // stops painting an opaque body. Both have to land together with the CSS, so
  // until then `transparent` stays off and Mica degrades to today's flat look.
  const main = TAURI_CONF.app.windows[0];
  assert.notEqual(main.transparent, true, 'a transparent window with an opaque page is just the old look plus risk');
});

test('Mica is withdrawn on Windows 10 and when Transparency effects are off', () => {
  // The config asks for the material unconditionally; main.rs is the only
  // thing that takes it back where DWM will not draw it.
  assert.match(MAIN_RS, /mod mica\b/, 'main.rs lost the Mica support check');
  assert.match(MAIN_RS, /22000/, 'the Windows 11 build floor is gone');
  assert.match(MAIN_RS, /EnableTransparency/, 'the Transparency effects setting is no longer read');
  assert.match(
    MAIN_RS,
    /if\s+!mica::supported\(\)/,
    'nothing clears the effect when the system cannot draw it',
  );
  assert.match(
    MAIN_RS,
    /set_effects\(None::<tauri::utils::config::WindowEffectsConfig>\)/,
    'the unsupported case must clear the effect, not set a different one',
  );
});

test('no bare TODO was left in the desktop Rust sources', () => {
  const srcDir = path.join(ROOT, 'desktop', 'src-tauri', 'src');
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.rs'))) {
    const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const match of source.match(/TODO[^\n]*/g) || []) {
      assert.match(match, /^TODO\(NEURA-\d{3}\)/, `${file}: a TODO must name an open backlog row -- ${match}`);
    }
  }
});
