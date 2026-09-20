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
