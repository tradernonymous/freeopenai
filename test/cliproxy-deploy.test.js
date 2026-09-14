const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The Railway service starts through this script, and its whole job is to put
// the config file and one credential file per Google account in place before
// CLIProxyAPI reads them. A silent failure here is the worst kind: the proxy
// starts happily with no accounts and answers every Antigravity model
// "unknown provider for model", which reads as a routing problem rather than
// a deployment one.
const ENTRYPOINT = path.join(__dirname, '..', 'deploy', 'cliproxyapi', 'entrypoint.sh');

const shWorks = (() => {
  try {
    execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const pythonWorks = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const canRun = shWorks && pythonWorks;

// A stand-in for `cliproxy-api`: records the arguments it was handed, so the
// test can prove the proxy is still the thing that ends up running (exec, not
// a swallowed command).
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-entrypoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'cliproxy-args.txt');
  const bin = path.join(dir, 'cliproxy-api');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$*" > "${marker.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(bin, 0o755);
  return {
    dir,
    marker,
    config: path.join(dir, 'data', 'config.yaml'),
    authDir: path.join(dir, 'data', 'auth'),
    run(env) {
      const output = execFileSync('sh', [ENTRYPOINT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          CPA_CONFIG_FILE: this.config,
          CPA_AUTH_DIR: this.authDir,
          ...env,
        },
      });
      return output;
    },
    binArgs() {
      return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
    },
  };
}

const SEED = JSON.stringify([
  { email: 'a.b+c@example.com', refreshToken: '1//0g-x_y~z', projectId: 'aicode-consumers' },
  { email: 'second@example.com', refresh_token: '1//0g-second', project_id: 'other-project' },
]);

test('accounts are seeded as one flat file each before the proxy starts', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  const h = harness(t);

  const out = h.run({ PORT: '8317', CPA_API_KEYS: 'k1', CPA_ACCOUNTS_JSON: SEED });

  // Characters that survive only if values pass through untouched: plus
  // signs, tildes, slashes and spaces are all legal in Google's tokens.
  for (const email of ['a.b+c@example.com', 'second@example.com']) {
    const doc = JSON.parse(fs.readFileSync(path.join(h.authDir, `antigravity-${email}.json`), 'utf8'));
    assert.equal(doc.type, 'antigravity');
    assert.equal(doc.email, email);
  }
  const first = JSON.parse(fs.readFileSync(path.join(h.authDir, 'antigravity-a.b+c@example.com.json'), 'utf8'));
  assert.equal(first.refresh_token, '1//0g-x_y~z');
  assert.equal(first.project_id, 'aicode-consumers');
  // An empty access token with an expired stamp is the honest "needs
  // refresh" state -- the proxy refreshes from the refresh token itself.
  assert.equal(first.access_token, '');
  const second = JSON.parse(fs.readFileSync(path.join(h.authDir, 'antigravity-second@example.com.json'), 'utf8'));
  assert.equal(second.refresh_token, '1//0g-second');
  assert.match(out, /seeded 2 Google account/, 'and say so, because the log is the only way to see it worked');
  assert.equal(h.binArgs(), `-config ${h.config}`, 'the proxy is what ends up running');
});

test('the old seed shape (an object with an accounts array) is accepted too', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  const h = harness(t);
  const old = JSON.stringify({ accounts: [{ email: 'old@example.com', refreshToken: '1//0g-old' }], strategy: 'hybrid' });

  h.run({ PORT: '8317', CPA_API_KEYS: 'k1', CPA_ACCOUNTS_JSON: old });

  const doc = JSON.parse(fs.readFileSync(path.join(h.authDir, 'antigravity-old@example.com.json'), 'utf8'));
  assert.equal(doc.refresh_token, '1//0g-old');
});

test('the generated config pins host, port, auth dir and key', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  const h = harness(t);

  h.run({ PORT: '9999', CPA_HOST: '127.0.0.1', CPA_API_KEYS: 'k1,k2', CPA_ACCOUNTS_JSON: '[]' });

  const cfg = fs.readFileSync(h.config, 'utf8');
  assert.match(cfg, /host: "127\.0\.0\.1"/, 'an explicit bind override is honoured verbatim');
  assert.match(cfg, /port: 9999/, 'Railway injects PORT and it must be honoured');
  assert.match(cfg, new RegExp(h.authDir.replace(/\\/g, '\\\\')));
  assert.match(cfg, /- "k1"/);
  assert.match(cfg, /- "k2"/);
});

test('the default bind is empty (Go dual-stack), never a bare ::', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  // A bare "::" is concatenated with the port into the invalid ":::8317"
  // and the server never starts (caught by the local Docker boot test), so
  // the default must stay empty, which Go binds dual-stack.
  const h = harness(t);

  h.run({ PORT: '8317', CPA_API_KEYS: 'k1', CPA_ACCOUNTS_JSON: '[]' });

  const cfg = fs.readFileSync(h.config, 'utf8');
  assert.match(cfg, /host: ""/);
});

test('a missing seed variable is survivable, not fatal', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  const h = harness(t);
  // The proxy still starts: Antigravity models answer "unknown provider",
  // which is a recognisable symptom. A crash loop here would be worse, and
  // would look like a broken image rather than a missing variable.
  const out = h.run({ PORT: '8317', CPA_API_KEYS: 'k1', CPA_ACCOUNTS_JSON: '' });

  assert.equal(h.binArgs(), `-config ${h.config}`, 'it must still run the proxy');
  assert.match(out, /CPA_ACCOUNTS_JSON is empty/, 'and say what is missing');
});

test('a mangled seed value warns and still starts, instead of crash-looping', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  const h = harness(t);
  // The Railway dashboard keeps pasted wrapping (stray quotes, editors add
  // newlines). That must never take the service down: warn with the head of
  // the value -- structure, never tokens -- and start with zero accounts.
  const out = h.run({ PORT: '8317', CPA_API_KEYS: 'k1', CPA_ACCOUNTS_JSON: '"[{\\"email\\":\\"a\\"}"' });

  assert.equal(h.binArgs(), `-config ${h.config}`, 'it must still run the proxy');
  assert.match(out, /not valid JSON/, 'and name the paste problem');
  assert.match(out, /0 Google account/, 'with the same zero-account warning as a missing seed');
});

test('a seed wrapped in one layer of quotes is unwrapped, not rejected', { skip: canRun ? false : 'no sh/python3 on this machine' }, (t) => {
  const h = harness(t);
  const inner = JSON.stringify([{ email: 'q@example.com', refreshToken: '1//0g-q' }]);

  h.run({ PORT: '8317', CPA_API_KEYS: 'k1', CPA_ACCOUNTS_JSON: `"${inner}"` });

  const doc = JSON.parse(fs.readFileSync(path.join(h.authDir, 'antigravity-q@example.com.json'), 'utf8'));
  assert.equal(doc.refresh_token, '1//0g-q');
});
