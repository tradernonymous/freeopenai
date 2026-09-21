// The network edge (src-tauri/src/net.rs) and its frontend mirror
// (src/net-policy.js). The rules that matter are the ones that stop this app
// from becoming an open proxy for anything that can run inside its webview, and
// the ones that decide whether a release asset or a model file can be reached
// at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../desktop/src/net-policy.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---- what may be reached -------------------------------------------------

test('https on the list is allowed; the CDNs the app actually needs are on it', () => {
  assert.equal(policy.isAllowed('https://github.com/x/y'), true);
  assert.equal(policy.isAllowed('https://api.github.com/repos/a/b'), true);
  assert.equal(policy.isAllowed('https://huggingface.co/unsloth/x'), true);
  // Release assets: github.com redirects here, so the update download works.
  assert.equal(policy.isAllowed('https://objects.githubusercontent.com/x'), true);
  // Model weights: cdn-lfs (wildcard subdomain) and the Xet bridge.
  assert.equal(policy.isAllowed('https://cdn-lfs-us-1.huggingface.co/x'), true);
  assert.equal(policy.isAllowed('https://cas-bridge.xethub.hf.co/x'), true);
});

test('http is allowed only for a server on this machine', () => {
  assert.equal(policy.isAllowed('http://127.0.0.1:8080/v1/models'), true);
  assert.equal(policy.isAllowed('http://localhost:8080/health'), true);
  assert.equal(policy.isAllowed('http://example.com/'), false);
  assert.equal(policy.isAllowed('http://huggingface.co/'), false);
});

test('unknown hosts and unknown schemes are refused', () => {
  assert.equal(policy.isAllowed('https://example.com/'), false);
  assert.equal(policy.isAllowed('file:///C:/Windows/win.ini'), false);
  assert.equal(policy.isAllowed('ftp://github.com/'), false);
  assert.equal(policy.isAllowed(''), false);
  assert.equal(policy.isAllowed('not a url'), false);
  // A lookalike suffix must not pass a wildcard entry.
  assert.equal(policy.isAllowed('https://nothuggingface.co/x'), false);
  assert.equal(policy.isAllowed('https://huggingface.co.evil.com/x'), false);
});

test('a refusal explains itself in the user\'s terms', () => {
  assert.equal(policy.refusalReason('https://github.com/a/b'), '');
  assert.match(policy.refusalReason('http://example.com/'), /only allowed for a server on this machine/);
  assert.match(policy.refusalReason('https://example.com/'), /not on the list/);
  assert.match(policy.refusalReason('example.com/x'), /missing its https:\/\/ prefix/);
  assert.match(policy.refusalReason(''), /not a web address/);
});

test('hosts are read without ports, credentials or IPv6 confusion', () => {
  assert.equal(policy.hostOf('https://github.com:443/a'), 'github.com');
  assert.equal(policy.hostOf('https://user:pw@GitHub.com/a'), 'github.com');
  assert.equal(policy.hostOf('http://[::1]:8080/x'), '[::1]');
  assert.equal(policy.hostOf('https://huggingface.co?a=b#c'), 'huggingface.co');
  assert.equal(policy.hostOf('nope'), '');
});

test('redirects resolve, including relative ones', () => {
  assert.equal(
    policy.resolveLocation('https://github.com/a/b', 'https://objects.githubusercontent.com/c'),
    'https://objects.githubusercontent.com/c',
  );
  assert.equal(policy.resolveLocation('https://github.com/a/b', '/c/d'), 'https://github.com/c/d');
  assert.equal(policy.resolveLocation('https://github.com/a/b?x=1', 'c'), 'https://github.com/a/c');
  assert.equal(
    policy.resolveLocation('https://github.com/a/b', '//objects.githubusercontent.com/c'),
    'https://objects.githubusercontent.com/c',
  );
  assert.equal(policy.resolveLocation('https://github.com/a/b', '#frag'), null);
  assert.equal(policy.resolveLocation('https://github.com/a/b', ''), null);
});

// ---- the frontend and the shell must agree ------------------------------

function rustHosts() {
  const source = read('desktop', 'src-tauri', 'src', 'net.rs');
  const block = source.match(/DEFAULT_HOSTS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(block, 'net.rs declares DEFAULT_HOSTS');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test('the shell\'s allowlist and the frontend\'s are identical', () => {
  assert.deepEqual(
    rustHosts(),
    policy.HOSTS,
    'a host reachable in Rust but refused in the UI (or the reverse) is a bug nobody would find by hand',
  );
});

test('the shell enforces the rules, in the shape the tests describe', () => {
  const net = read('desktop', 'src-tauri', 'src', 'net.rs');
  // Redirects are followed by hand so each hop is checked; reqwest's own policy
  // would follow one to a host the allowlist never saw.
  assert.match(net, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(net, /fn is_allowed\(url: &str, extra: &\[String\]\) -> bool/);
  assert.match(net, /if !is_allowed\(&current, extra\)/, 'every hop is checked');
  assert.match(net, /scheme == "http"[\s\S]{0,80}is_loopback/, 'http is loopback-only in the shell too');
  // Integrity: hashed while streaming, and the file is removed on a mismatch.
  assert.match(net, /Sha256::new\(\)/);
  assert.match(net, /let _ = std::fs::remove_file\(&dest\);/);
  assert.match(net, /"verified": had_expectation/, 'a download with no published digest is never claimed as verified');
  // A download name cannot choose its own path.
  assert.match(net, /pub fn sanitize_name\(name: &str\) -> Result<String, String>/);
  // Only an installer we downloaded may be executed.
  assert.match(net, /only a downloaded installer can be run/);
  assert.match(net, /if !target.starts_with\(&allowed\)/);
});

test('the shell registers the commands the frontend calls', () => {
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  for (const command of ['net::remote_get', 'net::remote_download', 'net::run_installer', 'diag::diagnostics']) {
    assert.ok(main.includes(command), `${command} must be in the invoke handler`);
  }
  // A second launch must focus the window that exists, not build another app.
  assert.match(main, /tauri_plugin_single_instance::init/);
  assert.match(main, /mod net;|mod net;/);
});

test('the frontend talks to the shell through one module', () => {
  const bridge = read('desktop', 'src', 'bridge.ts');
  assert.match(bridge, /__TAURI_INTERNALS__/);
  // Nothing else should be reaching for the runtime bridge directly.
  const others = ['App.tsx', 'screens/SettingsScreen.tsx'];
  for (const file of others) {
    assert.ok(!read('desktop', 'src', file).includes('__TAURI_INTERNALS__'), `${file} should use bridge.ts`);
  }
});

test('a boot failure cannot be a blank window', () => {
  const main = read('desktop', 'src', 'main.tsx');
  assert.match(main, /paintFailure/, 'the mount is guarded');
  assert.match(main, /rootIsEmpty\(\)/, 'an error in a working app must not replace the UI');
  assert.match(main, /addEventListener\('unhandledrejection'/);
  assert.match(read('desktop', 'src', 'index.css'), /\.boot-failure/, 'the failure has styling, not raw text');
});
