// Phase 10 (platform): opening NeuraOS with a .gguf or a folder (5.4), and
// update manifests signed with `tauri signer` and checked in the shell (5.9).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('.gguf is associated with the app and folders get "Open in NeuraOS"', () => {
  const conf = JSON.parse(read('desktop', 'src-tauri', 'tauri.conf.json'));
  assert.deepEqual(conf.bundle.fileAssociations.map((a) => a.ext).flat(), ['gguf']);
  assert.equal(conf.bundle.windows.nsis.installerHooks, './windows/hooks.nsh');
  const hooks = read('desktop', 'src-tauri', 'windows', 'hooks.nsh');
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL/);
  assert.match(hooks, /HKCU "Software\\Classes\\Directory\\shell\\NeuraOS\\command"/, 'per user, no elevation');
  assert.match(hooks, /!macro NSIS_HOOK_POSTUNINSTALL[\s\S]*DeleteRegKey HKCU "Software\\Classes\\Directory\\shell\\NeuraOS"/, 'removed on uninstall');
});

test('a launch path is taken once on start, or sent as an event to the running app', () => {
  const launch = read('desktop', 'src-tauri', 'src', 'launch.rs');
  assert.match(launch, /eq_ignore_ascii_case\("gguf"\)/);
  assert.match(launch, /starts_with\("neuraos:"\)/, 'deep links stay the deep-link plugin\'s');
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /launch::path_arg\(&args\)/);
  assert.match(main, /app\.emit\("open-path", path\)/);
  assert.match(main, /launch::launch_take_path/);
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /launchTakePath\(\)/);
  assert.match(app, /onOpenPath\(open\)/);
  assert.match(app, /add\(\{ kind: 'unsloth', path \}\)/, 'a model file joins My models');
});

test('the update manifest is signature-checked in the shell when a key is compiled in', () => {
  const net = read('desktop', 'src-tauri', 'src', 'net.rs');
  assert.match(net, /option_env!\("NEURAOS_UPDATER_PUBKEY"\)/);
  assert.match(net, /minisign_verify::PublicKey::decode/);
  assert.match(net, /format!\("\{\}\.sig", url\)/);
  assert.match(net, /refusing to update from it/, 'a keyed build never falls back to unsigned');
  const cargo = read('desktop', 'src-tauri', 'Cargo.toml');
  assert.match(cargo, /minisign-verify = "0\.2"/);
  const hook = read('desktop', 'src', 'useUpdateCheck.ts');
  assert.match(hook, /hasShell\(\) \? signedFetch : fetch/);
  const wf = read('.github', 'workflows', 'desktop.yml');
  assert.match(wf, /npx tauri signer sign \$manifest/);
  assert.match(wf, /desktop-version\.json\.sig/);
  assert.match(wf, /this build would refuse its own updates/, 'a key without its private half fails the job');
});
