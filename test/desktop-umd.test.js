// Every shared module is UMD so node:test can `require` it and the bundled app
// can read it off globalThis.
//
// That second path broke in the production build: Vite's CommonJS interop
// leaves a `module` object in scope, the wrapper's `typeof module === 'object'`
// check was therefore true, it took the CommonJS branch, and the global was
// never published. The app died on its first read of one -- a window painted in
// the app's background colour with nothing in it -- while `vite dev` (one ES
// module per file, no interop `module` in scope) worked perfectly.
//
// So these tests run each module the way the BUNDLE runs it: a global object, a
// `module` left in scope, and no `require`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'desktop', 'src');

// [files to evaluate in order, the global it must publish]
const MODULES = [
  [['chats.js'], 'FreeAI4UChats'],
  [['connection.js'], 'FreeAI4UConnection'],
  [['onboarding.js'], 'FreeAI4UOnboarding'],
  [['update.js'], 'FreeAI4UUpdate'],
  [['run-result.js'], 'FreeAI4URunResult'],
  [['net-policy.js'], 'FreeAI4UNetPolicy'],
  [['design/brand.js'], 'FreeAI4UBrand'],
  [['design/slop.js'], 'FreeAI4USlop'],
  [['design/systems.js'], 'FreeAI4UDesignSystems'],
  [['design/systems.js', 'design/prompt.js'], 'FreeAI4UDesignPrompt'],
  [['design/artifact.js'], 'FreeAI4UArtifact'],
  [['design/versions.js'], 'FreeAI4UDesignVersions'],
  [['keymap.js'], 'FreeAI4UKeymap'],
  [['composer.js'], 'FreeAI4UComposer'],
  [['files/zip.js'], 'FreeZip'],
  // office/pdf take deflate from the global zip.js publishes, so zip runs first
  // in the same context -- exactly as FilesScreen imports them.
  [['files/zip.js', 'files/office.js'], 'FreeOffice'],
  [['files/zip.js', 'files/pdf.js'], 'FreePdf'],
];

function evaluateLikeTheBundle(files) {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(source, sandbox, { filename: file });
  }
  return sandbox;
}

test('every shared module publishes its global even when a bundle leaves `module` in scope', () => {
  for (const [files, globalName] of MODULES) {
    const sandbox = evaluateLikeTheBundle(files);
    const api = sandbox[globalName];
    assert.ok(api, `${globalName} was not published (this is the blank-window bug)`);
    assert.equal(typeof api, 'object', `${globalName} should be the module's API object`);
    assert.ok(Object.keys(api).length > 0, `${globalName} published nothing`);
  }
});

test('the UMD wrappers still export for node, which is what the tests require', () => {
  const chats = require('../desktop/src/chats.js');
  assert.equal(typeof chats.readStore, 'function');
  const update = require('../desktop/src/update.js');
  assert.equal(typeof update.isNewer, 'function');
  const netPolicy = require('../desktop/src/net-policy.js');
  assert.equal(typeof netPolicy.isAllowed, 'function');
});

test('no shared module assigns its API only in an else branch', () => {
  for (const [files] of MODULES) {
    for (const file of files) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      // `else root.X = ...` is the shape that silently stopped working.
      assert.ok(
        !/else\s+root\.[A-Za-z]/.test(source),
        `${file} publishes its API only in an else branch -- a bundled build will not see it`,
      );
      assert.match(
        source,
        /if \(root\) root\.[A-Za-z0-9]+ = api;/,
        `${file} must publish its API to the global unconditionally`,
      );
    }
  }
});
