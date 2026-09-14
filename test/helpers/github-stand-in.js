// Shared harness for testing the GitHub routes against a stand-in rather than
// against the real API.
//
// Two things live here. The session cookie, because every route behind the
// connector needs one and the shape is the app's own (`fo_gh`, an encrypted
// blob from github.js). And the copy of server.js pointed at a local origin:
// the server hardcodes api.github.com, which is the point -- an operator cannot
// be talked into a different GitHub -- so a test rewrites that one hostname in a
// copy of the source and requires the copy.
//
// The copy's filename carries a caller-supplied suffix. The test runner runs
// files in parallel processes, and two of them writing one path would leave one
// test loading the other's source; the suffix is what keeps them apart.
const fs = require('node:fs');
const path = require('node:path');
const { encryptJson } = require('../../github.js');

const APP_DIR = path.join(__dirname, '..', '..');

// A cookie GitHub's routes accept: one account, unexpired, signed with the
// secret the test process set.
function githubSessionCookie(secret, login = 'octocat', token = 'tok') {
  return 'fo_gh=' + encryptJson(secret, {
    appUser: null,
    exp: Date.now() + 60000,
    accounts: [{ token, login }],
  });
}

// server.js with api.github.com replaced by `origin`.
function loadServerPointedAt(origin, suffix) {
  const source = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8')
    .replace(/https:\/\/api\.github\.com/g, origin);
  const copy = path.join(APP_DIR, '.server-under-test' + (suffix || '') + '.js');
  fs.writeFileSync(copy, source);
  try {
    delete require.cache[require.resolve(copy)];
    return { mod: require(copy), cleanup: () => fs.unlinkSync(copy) };
  } catch (err) {
    fs.unlinkSync(copy);
    throw err;
  }
}

module.exports = { githubSessionCookie, loadServerPointedAt };
