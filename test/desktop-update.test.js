// The desktop update check. What used to be wrong: the version came from a
// regex over the joined asset names (so a build-numbered or renamed file
// misreported it), any difference counted as an update (so a DOWN-dated tag
// raised the banner), the GitHub API call was subject to a 60/hour limit that
// silently 403'd, and there was no retry. All four rules are exercised here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const update = require('../desktop/src/update.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---- version ordering ---------------------------------------------------

test('only a strictly newer release is an update', () => {
  assert.equal(update.isNewer('2.2.1', '2.2.0'), true);
  assert.equal(update.isNewer('2.2.0', '2.2.0'), false);
  // The old string comparison flagged a down-dated release as an update.
  assert.equal(update.isNewer('2.1.9', '2.2.0'), false);
  assert.equal(update.isNewer('3.0.0', '2.99.99'), true);
  assert.equal(update.isNewer('2.10.0', '2.9.0'), true);
  assert.equal(update.isNewer('v2.2.1', '2.2.0'), true);
});

test('a version that is not a version is never an update', () => {
  // An artifact FILE NAME is not a version: this is the input the old regex
  // ran over, and why a build-numbered file could misreport.
  assert.equal(update.parseVersion('FreeAI4U.Desktop_2.2.1_x64-setup.exe'), null);
  // A four-part version is still a version, and still ordered.
  assert.deepEqual(update.parseVersion('2.2.0.150'), [2, 2, 0, 150]);
  assert.equal(update.isNewer('2.2.0.150', '2.2.0'), true);
  assert.equal(update.isNewer('2.2.0.150', '2.2.0.151'), false);
  assert.deepEqual(update.parseVersion('v2.2.0'), [2, 2, 0]);
  assert.deepEqual(update.parseVersion('2.2'), [2, 2]);
  assert.deepEqual(update.parseVersion('2.2.0-rc1'), [2, 2, 0]);
  assert.deepEqual(update.parseVersion('2.2.0+build.7'), [2, 2, 0]);
  for (const junk of ['', null, undefined, 'latest', 'x.y.z']) {
    assert.equal(update.isNewer(junk, '2.2.0'), false, `junk: ${String(junk)}`);
  }
  // "2.2" equals "2.2.0": a missing part is zero.
  assert.equal(update.compareVersions('2.2', '2.2.0'), 0);
});

// ---- the release payload ------------------------------------------------

const PAYLOAD = {
  version: '2.3.0',
  builtAt: '2026-09-20T00:00:00Z',
  commit: 'abc1234',
  artifacts: [
    { name: 'FreeAI4U.Desktop_2.3.0_x64-setup.exe', sha256: 'AA11', size: 5_400_000 },
    { name: 'FreeAI4U.Desktop_2.3.0_x64_en-US.msi', sha256: 'BB22', size: 6_100_000 },
    { name: 'freeai4u-desktop.exe', sha256: 'CC33', size: 12_000_000 },
  ],
};

test('the release metadata is read from its own fields, not from file names', () => {
  const parsed = update.readVersionPayload(PAYLOAD);
  assert.equal(parsed.version, '2.3.0');
  assert.equal(parsed.artifacts.length, 3);
  assert.equal(parsed.artifacts[0].sha256, 'AA11', 'integrity data is carried through');
  assert.equal(parsed.artifacts[0].size, 5_400_000);
});

test('the installer is picked by name and sized for the user', () => {
  const installer = update.installerFor(update.readVersionPayload(PAYLOAD));
  assert.equal(installer.name, 'FreeAI4U.Desktop_2.3.0_x64-setup.exe');
  assert.equal(update.humanSize(installer.size), '5.1 MB');
  assert.equal(update.humanSize(0), '');
  assert.equal(update.installerFor(null), null);
});

test('a payload without a usable version is refused, other shapes still work', () => {
  assert.equal(update.readVersionPayload({ version: 'nightly', artifacts: [] }), null);
  assert.equal(update.readVersionPayload(null), null);
  // A plain version string is enough.
  assert.equal(update.readVersionPayload('2.4.0').version, '2.4.0');
  // GitHub's own release shape: a real version tag, assets carrying digests.
  const fromRelease = update.readVersionPayload({
    tag_name: 'v2.3.0',
    assets: [{ name: 'freeai4u-desktop.exe', digest: 'sha256:DD44', size: 9 }],
  });
  assert.equal(fromRelease.version, '2.3.0');
  assert.equal(fromRelease.artifacts[0].sha256, 'DD44');
  // Our moving tag carries no version at all: nothing to compare, so nothing
  // is offered -- rather than the old "different string, show a banner".
  assert.equal(update.readVersionPayload({ tag_name: 'desktop-latest', assets: [] }), null);
});

// ---- retry / backoff ----------------------------------------------------

test('a transient failure is retried with growing backoff', async () => {
  const delays = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => PAYLOAD };
  };
  const result = await update.fetchVersion({
    url: 'https://example.test/desktop-version.json',
    fetchImpl,
    sleep: async (ms) => { delays.push(ms); },
    baseDelayMs: 1000,
    attempts: 4,
  });
  assert.equal(result.version, '2.3.0');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000], 'exponential backoff, not a tight loop');
  assert.ok(update.delayFor(10, 1000) <= update.MAX_DELAY_MS, 'the delay is capped');
});

test('a network that never answers ends as "no update", not a crash', async () => {
  let calls = 0;
  const result = await update.fetchVersion({
    fetchImpl: async () => { calls += 1; throw new Error('offline'); },
    sleep: async () => {},
    attempts: 3,
  });
  assert.equal(result, null);
  assert.equal(calls, 3);
});

test('a missing release is not retried: waiting cannot create it', async () => {
  let calls = 0;
  const result = await update.fetchVersion({
    fetchImpl: async () => { calls += 1; return { ok: false, status: 404, json: async () => ({}) }; },
    sleep: async () => {},
    attempts: 4,
  });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test('the check reads a release asset, not the rate-limited API', () => {
  const url = update.versionUrl();
  assert.match(url, /releases\/download\/desktop-latest\/desktop-version\.json$/);
  assert.doesNotMatch(url, /api\.github\.com/, 'the API limit is what could silently 403 it');
});

// ---- CI publishes what the app reads ------------------------------------

test('CI writes desktop-version.json with sha256 + size into the release', () => {
  const workflow = read('.github', 'workflows', 'desktop.yml');
  assert.match(workflow, /desktop-version\.json/, 'the metadata file is built');
  assert.match(workflow, /Get-FileHash/, 'the hash comes from the artifact CI just built');
  assert.match(workflow, /sha256/, 'the payload carries the hash');
  assert.match(workflow, /size/, 'and the size');
  assert.match(workflow, /artifacts/, 'per artifact');
  const files = workflow.slice(workflow.indexOf('files: |'));
  assert.match(files, /desktop-version\.json/, 'and it ships with the release');
});

test('the app fetches that file instead of regexing asset names', () => {
  // The check is the hook's job now (useUpdateCheck), so the shell composes it
  // and the rules stay in the module.
  const hook = read('desktop', 'src', 'useUpdateCheck.ts');
  assert.match(hook, /update\.fetchVersion/);
  assert.match(hook, /update\.isNewer/);
  assert.match(hook, /APP_VERSION/);
  const shell = read('desktop', 'src', 'App.tsx');
  assert.doesNotMatch(hook + shell, /assets\.join\(' '\)\.match/, 'the asset-name regex is gone');
  assert.doesNotMatch(hook + shell, /api\.github\.com/,
    'and so is the rate-limited API call');
  assert.match(shell, /useUpdateCheck\(\)/, 'App composes it');
});

// ---- installing an update, not just linking to one ----------------------

test('the artifact URL is the release CDN, on a host the shell allows', () => {
  const url = update.artifactUrl(undefined, 'FreeAI4U.Desktop_2.4.0_x64-setup.exe');
  assert.equal(
    url,
    'https://github.com/tradernonymous/freeopenai/releases/download/desktop-latest/FreeAI4U.Desktop_2.4.0_x64-setup.exe',
  );
  const policy = require('../desktop/src/net-policy.js');
  assert.equal(policy.isAllowed(url), true, 'the shell must be able to fetch it');
  assert.equal(update.artifactUrl(undefined, ''), '');
});

test('an install plan checks the digest only when the release published one', () => {
  const digest = 'a'.repeat(64);
  const verified = update.installPlan({
    installer: { name: 'setup.exe', sha256: digest.toUpperCase(), size: 5_400_000 },
  });
  assert.equal(verified.sha256, digest, 'the digest is normalised to lowercase hex');
  assert.equal(verified.verified, true);
  assert.equal(verified.size, 5_400_000);

  const unverifiable = update.installPlan({ installer: { name: 'setup.exe', sha256: '', size: 10 } });
  assert.equal(unverifiable.sha256, '', 'nothing to check against');
  assert.equal(unverifiable.verified, false, 'and it is never CLAIMED as verified');

  const short = update.installPlan({ installer: { name: 'setup.exe', sha256: 'abc123', size: 10 } });
  assert.equal(short.verified, false, 'a truncated hash is not a hash');

  assert.equal(update.installPlan({ installer: null }), null);
  assert.equal(update.installPlan({}), null);
});

test('the download runs through the shell, so CORS cannot block it', () => {
  const hook = read('desktop', 'src', 'useUpdateCheck.ts');
  assert.match(hook, /hasShell\(\)/, 'the hook knows whether a shell is present');
  assert.match(hook, /updateManifest\(url\)/, 'the metadata fetch goes through the shell, which checks its signature');
  assert.match(hook, /downloadVerified/, 'so does the download, which is hashed as it streams');
  assert.match(hook, /netPolicy\.refusalReason/, 'a URL is refused before it is handed to the shell');
  assert.match(hook, /runInstaller/, 'and the installer is started by the shell');
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /'remote_download'/);
  assert.match(bridge, /'remote_get'/);
  assert.match(bridge, /'run_installer'/);
});

test('the banner offers the install, not only a link', () => {
  const shell = read('desktop', 'src', 'App.tsx');
  assert.match(shell, /installUpdate/, 'the banner calls it');
  assert.match(shell, /installing/, 'and shows which phase it is in');
  assert.match(shell, /verified/, 'and whether the digest was checked');
});

// ---- NEURA-076: one update button, the right installer, a rising version --
//
// The release carries three builds of the same version. Running the NSIS
// setup over an MSI install (or the MSI over an NSIS one) leaves two copies
// registered with Windows, and a portable exe is not an installer at all -- so
// the artifact is chosen by how THIS copy was installed.

const RELEASE = update.readVersionPayload({
  version: '2.11.140',
  artifacts: [
    { name: 'NeuraOS Desktop_2.11.140_x64-setup.exe', sha256: 'a'.repeat(64), size: 5_000_000 },
    { name: 'NeuraOS Desktop_2.11.140_x64_en-US.msi', sha256: 'b'.repeat(64), size: 6_000_000 },
    { name: 'freeai4u-desktop.exe', sha256: 'c'.repeat(64), size: 12_000_000 },
  ],
});

test('an MSI install is updated with the .msi', () => {
  assert.equal(update.installerFor(RELEASE, 'msi').name, 'NeuraOS Desktop_2.11.140_x64_en-US.msi');
});

test('an NSIS install is updated with the -setup.exe', () => {
  assert.equal(update.installerFor(RELEASE, 'nsis').name, 'NeuraOS Desktop_2.11.140_x64-setup.exe');
});

test('a portable copy gets the portable exe, never an installer', () => {
  assert.equal(update.installerFor(RELEASE, 'portable').name, 'freeai4u-desktop.exe');
});

test('an unknown install kind keeps the old choice (the first installer)', () => {
  assert.equal(update.installerFor(RELEASE).name, 'NeuraOS Desktop_2.11.140_x64-setup.exe');
  assert.equal(update.installerFor(RELEASE, 'weird').name, 'NeuraOS Desktop_2.11.140_x64-setup.exe');
});

test('a release missing the matching artifact falls back instead of offering nothing', () => {
  const onlySetup = update.readVersionPayload({
    version: '2.11.141',
    artifacts: [{ name: 'NeuraOS Desktop_2.11.141_x64-setup.exe', sha256: '', size: 1 }],
  });
  assert.equal(update.installerFor(onlySetup, 'msi').name, 'NeuraOS Desktop_2.11.141_x64-setup.exe');
  // A portable copy must not be handed an installer to "run": no portable
  // artifact means nothing to fetch for it.
  assert.equal(update.installerFor(onlySetup, 'portable'), null);
  assert.equal(update.installerFor(null, 'msi'), null);
});

test('the hook asks the shell how this copy was installed and never runs a portable exe', () => {
  const hook = read('desktop', 'src', 'useUpdateCheck.ts');
  assert.match(hook, /installKind\(\)/, 'the install kind comes from the shell');
  assert.match(hook, /update\.installerFor\(info, kind\)/, 'and picks the artifact');
  assert.match(hook, /kind === 'portable'/, 'a portable copy takes its own path');
  assert.match(hook, /This copy is portable: the new version was saved to/);
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /'install_kind'/);
  const net = read('desktop', 'src-tauri', 'src', 'net.rs');
  assert.match(net, /pub fn install_kind\(\) -> String/);
  assert.match(net, /fn kind_of\(exe_dir: &Path, has_uninstaller: bool, program_dirs: &\[PathBuf\]\) -> &'static str/);
  assert.match(net, /uninstall\.exe/);
  assert.match(net, /ProgramW6432/);
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /net::install_kind/, 'the command is registered');
});

test('a manual check ignores a dismissed version; the hourly poll still respects it', () => {
  const hook = read('desktop', 'src', 'useUpdateCheck.ts');
  assert.match(hook, /manual/, 'checkNow knows who asked');
  assert.match(hook, /!manual && dismissedVersion\(\) === found\.version/);
});

test('the status bar has one always-visible update button', () => {
  const bar = read('desktop', 'src', 'components', 'StatusBar.tsx');
  for (const label of ['Check for updates', 'Checking…', 'Up to date', "Couldn't check", 'Update to v', 'Downloading…', 'Installing…']) {
    assert.ok(bar.includes(label), `label: ${label}`);
  }
  assert.match(bar, /onCheckUpdates\(\)/, 'a click checks');
  assert.match(bar, /onInstallUpdate\(\)/, 'and, with an update found, installs');
  const shell = read('desktop', 'src', 'App.tsx');
  assert.match(shell, /onCheckUpdates=\{/, 'App lifts checkNow into the bar');
  assert.match(shell, /onInstallUpdate=\{installUpdate\}/, 'and the same install flow the banner uses');
});

test('CI stamps the run number into every version file, after the tests and before the build', () => {
  const workflow = read('.github', 'workflows', 'desktop.yml');
  const stamp = workflow.indexOf('name: Stamp the build version');
  assert.ok(stamp > 0, 'the stamp step exists');
  const tests = workflow.indexOf('name: Desktop tests');
  const frontend = workflow.indexOf('name: Build the frontend');
  const tauri = workflow.indexOf('name: Build Tauri app');
  assert.ok(tests < stamp, 'after the node tests, which check the repo files agree');
  assert.ok(stamp < frontend && stamp < tauri, 'before anything is built');
  const step = workflow.slice(stamp, frontend);
  assert.match(step, /github\.run_number/);
  for (const file of ['desktop/package.json', 'desktop/src-tauri/tauri.conf.json', 'desktop/src-tauri/Cargo.toml', 'desktop/src/version.ts']) {
    assert.ok(step.includes(file), `stamps ${file}`);
  }
  // The update manifest reads the version from package.json, after the stamp.
  assert.ok(workflow.indexOf('name: Write update metadata') > stamp);
});
