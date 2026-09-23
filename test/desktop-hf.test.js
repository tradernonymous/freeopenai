const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Load the UMD modules the way the bundle does — a `module` in scope, no
// `require` of the file. The traditional UMD fallback-branch skips the
// global publish, so test/desktop-umd.test.js catches that. Here we test
// the API surface.

const hfAuth = require('../desktop/src/hf-auth.js');
const fs = require('node:fs');
const path = require('node:path');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const hfModels = require('../desktop/src/hf-models.js');

// ---- hf-auth -------------------------------------------------------------

describe('hf-auth', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof hfAuth.signedIn, 'function');
    assert.equal(typeof hfAuth.accessToken, 'function');
    assert.equal(typeof hfAuth.authHeaders, 'function');
    assert.equal(typeof hfAuth.beginOAuth, 'function');
    assert.equal(typeof hfAuth.resolveClientId, 'function');
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

  it('has no hard-coded OAuth client id and no device-code flow', () => {
    // The old id was never a registered app (invalid_client); the id now
    // comes from the build or Settings (test/desktop-hf-oauth.test.js).
    assert.equal(hfAuth.CLIENT_ID, undefined);
    assert.equal(hfAuth.startDeviceCode, undefined);
    assert.equal(hfAuth.pollDeviceCode, undefined);
    assert.ok(!/3087aa/.test(read('desktop', 'src', 'hf-auth.js')));
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
    const url = hfModels.fileUrl('test/model', 'file.gguf');
    assert.equal(url, 'https://huggingface.co/test/model/resolve/main/file.gguf');
  });

  it('fileUrl never carries a token, whatever it is handed', () => {
    // It used to append ?token=: a URL reaches proxy logs, browser history and
    // pasted bug reports, and HF deprecated the parameter. A gated repo is
    // unlocked with an Authorization header at download time instead.
    const url = hfModels.fileUrl('test/model', 'file.gguf', 'tok123');
    assert.ok(!url.includes('token'), 'no token in the URL');
    assert.ok(!url.includes('tok123'), 'not even a stray extra argument');
  });

  it('a repo id and a nested path keep their slashes', () => {
    // encodeURIComponent on the whole id made it test%2Fmodel, and Hugging
    // Face answers 400 "repo name includes an url-encoded slash" -- the bug
    // that made every Add-from-Hugging-Face lookup fail.
    const url = hfModels.fileUrl('Shar514/Flux', 'sub dir/f.gguf');
    assert.ok(!url.includes('%2F'), 'separators stay real slashes');
    assert.ok(url.includes('/Shar514/Flux/resolve/main/sub%20dir/f.gguf'), 'segments are still encoded');
  });
});

// ---- hf-inference --------------------------------------------------------
//
// The provider used to build https://api.huggingface.co/models/<m>/v1/... which
// is not a documented Hugging Face endpoint; every turn failed before the
// token was checked. The router is the one OpenAI-compatible base HF documents.

const hfInference = require('../desktop/src/hf-inference.js');

describe('hf-inference', () => {
  it('talks to the documented router, and only to it', () => {
    assert.equal(hfInference.API_BASE, 'https://router.huggingface.co/v1');
    assert.equal(hfInference.chatUrl(), 'https://router.huggingface.co/v1/chat/completions');
    const source = require('node:fs').readFileSync(require.resolve('../desktop/src/hf-inference.js'), 'utf8');
    assert.ok(!source.includes('api.huggingface.co'), 'the undocumented host must be gone');
  });

  it('asks the router for the cheapest provider unless the user chose one', () => {
    assert.equal(hfInference.modelId('Qwen/Qwen3.8-27B'), 'Qwen/Qwen3.8-27B:cheapest');
    assert.equal(hfInference.modelId('Qwen/Qwen3.8-27B:fastest'), 'Qwen/Qwen3.8-27B:fastest');
    assert.equal(hfInference.modelId('Qwen/Qwen3.8-27B:novita'), 'Qwen/Qwen3.8-27B:novita');
    assert.equal(hfInference.modelId('  '), '');
  });

  it('the sign-in scope includes inference-api, or the router refuses the token', () => {
    assert.ok(hfAuth.SCOPE.split(' ').includes('inference-api'));
  });

  it('turns a 401 into the permission the token is missing', () => {
    assert.match(hfInference.explain(401, ''), /Make calls to Inference Providers/);
    assert.match(hfInference.explain(403, ''), /Make calls to Inference Providers/);
    assert.match(hfInference.explain(402, ''), /credits/);
    assert.match(hfInference.explain(500, 'boom'), /500: boom/);
  });

  it('lists live models from GET /v1/models and falls back to the curated list', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return {
        ok: true,
        json: async () => ({ data: [
          { id: 'a/b', providers: [{ provider: 'novita' }, { provider: 'together' }] },
          { id: 'c/d', providers: [] },
          { nope: true },
        ] }),
      };
    };
    const live = await hfInference.fetchModels('tok', fakeFetch);
    assert.equal(calls[0].url, 'https://router.huggingface.co/v1/models');
    assert.equal(calls[0].auth, 'Bearer tok');
    assert.deepEqual(live, [{ id: 'a/b', free: '2 providers' }, { id: 'c/d', free: 'HF router' }]);

    const down = await hfInference.fetchModels('tok', async () => ({ ok: false }));
    assert.equal(down, hfInference.FREE_MODELS);
    const threw = await hfInference.fetchModels('tok', async () => { throw new Error('offline'); });
    assert.equal(threw, hfInference.FREE_MODELS);
    assert.deepEqual(await hfInference.fetchModels(null, fakeFetch), []);
  });

  it('streams through the router with the token and the policy suffix', async () => {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      const text = 'data: {"choices":[{"delta":{"content":"hi"}}],"model":"m"}\n\ndata: [DONE]\n';
      return new globalThis.Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const frames = [];
      await hfInference.streamChat('a/b', [{ role: 'user', content: 'x' }], (f) => frames.push(f), undefined, 'tok');
      assert.equal(seen[0].url, hfInference.chatUrl());
      assert.equal(seen[0].auth, 'Bearer tok');
      assert.equal(seen[0].body.model, 'a/b:cheapest');
      assert.equal(seen[0].body.stream, true);
      assert.deepEqual(frames, [{ content: 'hi', model: 'm' }, { done: true }]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---- the token's home ----------------------------------------------------
//
// Under the shell the token lives in the OS credential store (secrets.rs),
// mirrored in memory; a token found in localStorage is moved there once.

describe('hf-auth secret store', () => {
  function fakeStore() {
    const rows = new Map();
    return {
      rows,
      get: async (k) => (rows.has(k) ? rows.get(k) : null),
      set: async (k, v) => { rows.set(k, v); },
      remove: async (k) => { rows.delete(k); },
    };
  }
  function fakeLocalStorage(initial = {}) {
    const rows = new Map(Object.entries(initial));
    return {
      getItem: (k) => (rows.has(k) ? rows.get(k) : null),
      setItem: (k, v) => rows.set(k, String(v)),
      removeItem: (k) => rows.delete(k),
      rows,
    };
  }

  it('hydrate moves a localStorage token into the store and removes the plain-text copy', async () => {
    const store = fakeStore();
    const token = { access_token: 'abc', expires_at: Date.now() + 60_000 };
    globalThis.localStorage = fakeLocalStorage({ [hfAuth.TOKEN_KEY]: JSON.stringify(token), [hfAuth.USER_KEY || 'freeai4u.hf_user']: '{"name":"me"}' });
    try {
      hfAuth.configureStore(store);
      assert.equal(hfAuth.signedIn(), false, 'nothing is read from localStorage while a store is configured');
      assert.equal(await hfAuth.hydrate(), true);
      assert.equal(hfAuth.signedIn(), true);
      assert.equal(hfAuth.accessToken().access_token, 'abc');
      assert.equal(store.rows.get(hfAuth.SECRET_TOKEN), JSON.stringify(token));
      assert.equal(globalThis.localStorage.getItem(hfAuth.TOKEN_KEY), null, 'the plain-text copy is gone');
      assert.deepEqual(hfAuth.cachedUser(), { name: 'me' });
    } finally {
      hfAuth.configureStore(null);
      delete globalThis.localStorage;
    }
  });

  it('save and clear go to the store, never to localStorage, and announce themselves', async () => {
    const store = fakeStore();
    globalThis.localStorage = fakeLocalStorage();
    let announced = 0;
    const scope = globalThis;
    const hadDispatch = typeof scope.dispatchEvent === 'function';
    scope.dispatchEvent = () => { announced += 1; return true; };
    scope.Event = scope.Event || function Event(name) { this.type = name; };
    try {
      hfAuth.configureStore(store);
      await hfAuth.hydrate();
      hfAuth.saveToken({ access_token: 'new', expires_at: Date.now() + 60_000 });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(JSON.parse(store.rows.get(hfAuth.SECRET_TOKEN)).access_token, 'new');
      assert.equal(globalThis.localStorage.rows.size, 0, 'localStorage stays empty');
      assert.equal(hfAuth.signedIn(), true);
      hfAuth.clearToken();
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(store.rows.has(hfAuth.SECRET_TOKEN), false);
      assert.equal(hfAuth.signedIn(), false);
      assert.ok(announced >= 3, `hydrate, save and clear each announce (${announced})`);
    } finally {
      hfAuth.configureStore(null);
      delete globalThis.localStorage;
      if (!hadDispatch) delete scope.dispatchEvent;
    }
  });

  it('the app configures the store under the shell and the screens listen', () => {
    const app = read('desktop', 'src', 'App.tsx');
    assert.match(app, /hfAuth\.configureStore\(\{/);
    assert.match(app, /hfAuth\.hydrate\(\)/);
    assert.match(read('desktop', 'src', 'screens', 'ChatScreen.tsx'), /hfAuth\.AUTH_CHANGED_EVENT/);
    assert.match(read('desktop', 'src', 'screens', 'LibraryScreen.tsx'), /hfAuth\.AUTH_CHANGED_EVENT/);
    const secrets = read('desktop', 'src-tauri', 'src', 'secrets.rs');
    assert.match(secrets, /use keyring::Entry;/);
    assert.match(secrets, /KEYS: &\[&str\] = &\["hf_token", "hf_user"\]/, 'only the app\'s own keys');
  });
});
