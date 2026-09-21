const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Load the UMD modules the way the bundle does — a `module` in scope, no
// `require` of the file. The traditional UMD fallback-branch skips the
// global publish, so test/desktop-umd.test.js catches that. Here we test
// the API surface.

const hfAuth = require('../desktop/src/hf-auth.js');
const hfModels = require('../desktop/src/hf-models.js');

// ---- hf-auth -------------------------------------------------------------

describe('hf-auth', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof hfAuth.signedIn, 'function');
    assert.equal(typeof hfAuth.accessToken, 'function');
    assert.equal(typeof hfAuth.authHeaders, 'function');
    assert.equal(typeof hfAuth.signInPKCE, 'function');
    assert.equal(typeof hfAuth.startDeviceCode, 'function');
    assert.equal(typeof hfAuth.pollDeviceCode, 'function');
    assert.equal(typeof hfAuth.refreshAccessToken, 'function');
    assert.equal(typeof hfAuth.fetchUser, 'function');
    assert.equal(typeof hfAuth.signOut, 'function');
    assert.equal(typeof hfAuth.saveToken, 'function');
    assert.equal(typeof hfAuth.loadToken, 'function');
    assert.equal(typeof hfAuth.clearToken, 'function');
    assert.equal(typeof hfAuth.cachedUser, 'function');
  });

  it('has a TOKEN_KEY that matches the localStorage convention', () => {
    assert.equal(hfAuth.TOKEN_KEY, 'freeai4u.hf_token');
  });

  it('has a CLIENT_ID', () => {
    assert.ok(hfAuth.CLIENT_ID.length > 0);
  });

  it('signedIn returns false when no token is stored', () => {
    // In a real browser, localStorage would be empty. In node:test, there is
    // no localStorage, so the module catches the error and returns false.
    assert.equal(hfAuth.signedIn(), false);
  });

  it('authHeaders returns empty object when not signed in', () => {
    const h = hfAuth.authHeaders();
    assert.deepEqual(h, {});
  });

  it('startDeviceCode returns a function', () => {
    // The function itself exists; calling it would hit the network.
    assert.equal(typeof hfAuth.startDeviceCode, 'function');
  });
});

// ---- hf-models -----------------------------------------------------------

describe('hf-models', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof hfModels.searchModels, 'function');
    assert.equal(typeof hfModels.getModel, 'function');
    assert.equal(typeof hfModels.ggufFiles, 'function');
    assert.equal(typeof hfModels.parseQuant, 'function');
    assert.equal(typeof hfModels.estimateFitsRam, 'function');
    assert.equal(typeof hfModels.fileUrl, 'function');
    assert.equal(typeof hfModels.formatSize, 'function');
    assert.equal(typeof hfModels.licenseShort, 'function');
    assert.equal(typeof hfModels.isGated, 'function');
  });

  it('HF_API points to huggingface.co', () => {
    assert.ok(hfModels.HF_API.includes('huggingface.co'));
  });

  it('parseQuant extracts quant from filename', () => {
    assert.equal(hfModels.parseQuant('Qwen3-Coder-1.5B-Q4_K_M.gguf'), 'Q4_K_M');
    assert.equal(hfModels.parseQuant('model-Q5_K_S.gguf'), 'Q5_K_S');
    assert.equal(hfModels.parseQuant('model-Q8_0.gguf'), 'Q8_0');
    assert.equal(hfModels.parseQuant('model-F16.gguf'), 'F16');
    assert.equal(hfModels.parseQuant('model-IQ4_XS.gguf'), 'IQ4_XS');
    assert.equal(hfModels.parseQuant('model-BF16.gguf'), 'BF16');
    assert.equal(hfModels.parseQuant('something.gguf'), '');
    assert.equal(hfModels.parseQuant('no-extension'), '');
  });

  it('estimateFitsRam returns the right tier', () => {
    const gb = 1024 * 1024 * 1024;
    assert.equal(hfModels.estimateFitsRam(3 * gb, 'Q4_K_M'), '8gb');
    assert.equal(hfModels.estimateFitsRam(7 * gb, 'Q4_K_M'), '16gb'); // too big for 8
    assert.equal(hfModels.estimateFitsRam(6 * gb, 'Q5_K_S'), '16gb');
    // Q8 does not match Q[56], so it falls through to the 32 GB tier.
    assert.equal(hfModels.estimateFitsRam(15 * gb, 'Q8_0'), '32gb');
    assert.equal(hfModels.estimateFitsRam(30 * gb, 'F16'), '');
  });

  it('ggufFiles extracts .gguf siblings with parsed metadata', () => {
    const card = {
      id: 'test/model',
      siblings: [
        { rfilename: 'README.md', size: 1000 },
        { rfilename: 'model-Q4_K_M.gguf', size: 2 * 1024 * 1024 * 1024 },
        { rfilename: 'model-Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
        { rfilename: 'config.json', size: 500 },
      ],
    };
    const files = hfModels.ggufFiles(card);
    assert.equal(files.length, 2);
    assert.equal(files[0].name, 'model-Q4_K_M.gguf');
    assert.equal(files[0].quant, 'Q4_K_M');
    assert.ok(files[0].url.includes('test/model'));
    assert.ok(files[0].url.includes('model-Q4_K_M.gguf'));
    assert.equal(files[1].quant, 'Q8_0');
  });

  it('ggufFiles returns empty for a card with no GGUF files', () => {
    const card = { siblings: [{ rfilename: 'README.md' }] };
    assert.deepEqual(hfModels.ggufFiles(card), []);
  });

  it('formatSize formats bytes correctly', () => {
    assert.equal(hfModels.formatSize(0), '');
    assert.equal(hfModels.formatSize(512), '512 B');
    assert.equal(hfModels.formatSize(1024), '1 KB');
    assert.equal(hfModels.formatSize(1024 * 1024), '1.0 MB');
    assert.equal(hfModels.formatSize(2.5 * 1024 * 1024 * 1024), '2.5 GB');
  });

  it('licenseShort extracts the license from tags', () => {
    assert.equal(hfModels.licenseShort({ tags: ['license:apache-2.0', 'gguf'] }), 'apache-2.0');
    assert.equal(hfModels.licenseShort({ cardData: { license: 'mit' } }), 'mit');
    assert.equal(hfModels.licenseShort({ tags: [] }), '');
  });

  it('isGated detects gated models', () => {
    assert.equal(hfModels.isGated({ tags: ['gated'] }), true);
    assert.equal(hfModels.isGated({ tags: ['requires-approval'] }), true);
    assert.equal(hfModels.isGated({ gated: true }), true);
    assert.equal(hfModels.isGated({ tags: ['gguf'] }), false);
    assert.equal(hfModels.isGated({}), false);
  });

  it('fileUrl builds the correct download URL', () => {
    const url = hfModels.fileUrl('test/model', 'file.gguf', 'tok123');
    assert.ok(url.startsWith('https://huggingface.co/test/model/resolve/main/'));
    assert.ok(url.includes('token=tok123'));
  });

  it('fileUrl omits token when not provided', () => {
    const url = hfModels.fileUrl('test/model', 'file.gguf');
    assert.ok(!url.includes('token='));
  });
});
