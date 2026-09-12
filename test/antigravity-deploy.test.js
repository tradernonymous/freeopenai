const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The Railway service starts through this script, and its whole job is to put
// the accounts file in place before the proxy reads it. A silent failure here
// is the worst kind: the proxy starts happily with no accounts and answers
// every request "Quota Exhausted", which reads as a quota problem rather than a
// deployment one.
const ENTRYPOINT = path.join(__dirname, '..', 'deploy', 'antigravity-proxy', 'entrypoint.sh');

const shWorks = (() => {
  try {
    execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// A stand-in for `bun`: records the arguments it was handed, so the test can
// prove the proxy is still the thing that ends up running (exec, not a
// swallowed command).
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-entrypoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'bun-args.txt');
  const bun = path.join(dir, 'bun');
  fs.writeFileSync(bun, `#!/bin/sh\nprintf '%s' "$*" > "${marker.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(bun, 0o755);
  return {
    dir,
    marker,
    accounts: path.join(dir, 'data', 'antigravity-accounts.json'),
    run(env) {
      const output = execFileSync('sh', [ENTRYPOINT], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, ...env },
      });
      return output;
    },
    bunArgs() {
      return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
    },
  };
}

test('accounts are written before the proxy starts, byte for byte', { skip: shWorks ? false : 'no sh on this machine' }, (t) => {
  const h = harness(t);
  // Characters that survive a shell round-trip only if the value is passed as a
  // value: quotes, spaces, and the punctuation Google's tokens are made of.
  const json = '{"accounts":[{"email":"a.b+c@example.com","refreshToken":"1//0g-x_y~z.AAAA BBB","projectId":"aicode-consumers"}],"strategy":"hybrid"}';

  const out = h.run({ ACCOUNTS_FILE: h.accounts, AG_ACCOUNTS_JSON: json });

  assert.equal(fs.readFileSync(h.accounts, 'utf8'), json, 'the file must be exactly what the variable held');
  assert.match(out, /seeded/, 'and say so, because the log is the only way to see it worked');
  assert.equal(h.bunArgs(), 'run src/server.ts', 'the proxy is what ends up running');
});

test('a fresh container is the point: the data directory may not exist yet', { skip: shWorks ? false : 'no sh on this machine' }, (t) => {
  const h = harness(t);
  assert.equal(fs.existsSync(path.dirname(h.accounts)), false, 'precondition: no data directory');

  h.run({ ACCOUNTS_FILE: h.accounts, AG_ACCOUNTS_JSON: '{"accounts":[]}' });

  assert.equal(fs.readFileSync(h.accounts, 'utf8'), '{"accounts":[]}');
});

test('a missing seed variable is survivable, not fatal', { skip: shWorks ? false : 'no sh on this machine' }, (t) => {
  const h = harness(t);
  // The proxy still starts: it answers "Quota Exhausted ... All accounts
  // failed", which is a recognisable symptom. A crash loop here would be worse,
  // and would look like a broken image rather than a missing variable.
  const out = h.run({ ACCOUNTS_FILE: h.accounts, AG_ACCOUNTS_JSON: '' });

  assert.equal(h.bunArgs(), 'run src/server.ts', 'it must still run the proxy');
  assert.match(out, /AG_ACCOUNTS_JSON is empty/, 'and say what is missing');
  assert.equal(fs.existsSync(h.accounts), false, 'and not invent an empty file');
});

test('with no ACCOUNTS_FILE the script stays out of the way', { skip: shWorks ? false : 'no sh on this machine' }, (t) => {
  const h = harness(t);

  const out = h.run({ ACCOUNTS_FILE: '', AG_ACCOUNTS_JSON: '{"accounts":[]}' });

  assert.equal(h.bunArgs(), 'run src/server.ts');
  assert.doesNotMatch(out, /seeded/, 'nothing to seed, nothing to report');
});
