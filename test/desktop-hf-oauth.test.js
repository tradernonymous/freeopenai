// One-click Hugging Face sign-in: authorization code + PKCE with a loopback
// redirect. The JS orchestration (hf-auth.js beginOAuth) takes its side
// effects as arguments, so it is driven here with fakes; the shell half
// (hf_oauth.rs) cannot be compiled on every machine, so its load-bearing
// rules are pinned by reading the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const hfAuth = require('../desktop/src/hf-auth.js');

const REDIRECT = 'http://127.0.0.1:47823/hf/callback';
const CLIENT = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

function memoryStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => { rows.set(k, String(v)); },
    removeItem: (k) => { rows.delete(k); },
  };
}

function withStorage(initial, fn) {
  const saved = globalThis.localStorage;
  globalThis.localStorage = memoryStore(initial);
  hfAuth.configureStore(null);
  return Promise.resolve()
    .then(() => fn(globalThis.localStorage))
    .finally(() => {
      hfAuth.configureRefresh(null);
      if (saved === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = saved;
    });
}

const whoamiOk = async (url, init) => {
  assert.match(url, /whoami-v2$/);
  assert.match(init.headers.Authorization, /^Bearer /);
  return { ok: true, status: 200, json: async () => ({ name: 'printezy', auth: { type: 'oauth' } }) };
};

/** A fake shell: records the order of calls, answers like hf_oauth.rs. */
function fakeShell(overrides = {}) {
  const calls = [];
  let state = null;
  const shell = {
    calls,
    opened: null,
    listen: async (s, secs) => {
      calls.push('listen');
      state = s;
      shell.timeoutSecs = secs;
      return overrides.listenAnswer ? overrides.listenAnswer(s) : 'the-code';
    },
    openUrl: async (url) => { calls.push('open'); shell.opened = url; },
    exchange: async (code, verifier, clientId, redirectUri) => {
      calls.push('exchange');
      shell.exchanged = { code, verifier, clientId, redirectUri };
      return overrides.token || { access_token: 'hf_oauth_access', token_type: 'bearer', expires_in: 3600, refresh_token: 'hf_oauth_refresh', scope: hfAuth.SCOPE };
    },
    cancel: async () => { calls.push('cancel'); },
    get state() { return state; },
  };
  return shell;
}

// ---- the authorize URL -----------------------------------------------------------

test('the authorize URL carries the client, the fixed redirect, the scopes and an S256 challenge', () => {
  const url = new URL(hfAuth.authorizeUrl({ clientId: CLIENT, state: 'st', challenge: 'ch' }));
  assert.equal(url.origin + url.pathname, 'https://huggingface.co/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const scopes = url.searchParams.get('scope').split(' ');
  for (const s of ['openid', 'profile', 'inference-api']) assert.ok(scopes.includes(s), `asks for ${s}`);
  assert.equal(hfAuth.REDIRECT_URI, REDIRECT);
  assert.equal(hfAuth.LOOPBACK_PORT, 47823);
});

test('the PKCE pair is a 64-character verifier and its SHA-256, base64url', async () => {
  const { verifier, challenge } = await hfAuth.pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

// ---- the flow --------------------------------------------------------------------

test('beginOAuth listens before it opens the browser, then exchanges and keeps an oauth token', async () => {
  await withStorage({}, async (storage) => {
    const shell = fakeShell();
    const before = Date.now();
    const user = await hfAuth.beginOAuth({ clientId: CLIENT, redirectUri: REDIRECT, fetchImpl: whoamiOk, settleMs: 0, ...shell });
    assert.equal(user.name, 'printezy');
    assert.deepEqual(shell.calls, ['listen', 'open', 'exchange']);
    assert.equal(shell.timeoutSecs, 180, 'the default wait is three minutes');

    const url = new URL(shell.opened);
    assert.equal(url.searchParams.get('state'), shell.state, 'the state listened for is the one sent');
    assert.ok(shell.state.length >= 32);
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(shell.exchanged.verifier).digest('base64url'));
    assert.deepEqual(
      { code: shell.exchanged.code, clientId: shell.exchanged.clientId, redirectUri: shell.exchanged.redirectUri },
      { code: 'the-code', clientId: CLIENT, redirectUri: REDIRECT },
    );

    const kept = JSON.parse(storage.getItem(hfAuth.TOKEN_KEY));
    assert.equal(kept.source, 'oauth');
    assert.equal(kept.access_token, 'hf_oauth_access');
    assert.equal(kept.refresh_token, 'hf_oauth_refresh');
    assert.equal(kept.client_id, CLIENT, 'a refresh must use the same client');
    assert.ok(kept.expires_at >= before + 3600 * 1000 && kept.expires_at <= Date.now() + 3600 * 1000);
    assert.equal(hfAuth.signedIn(), true);
    assert.equal(hfAuth.cachedUser().name, 'printezy');
    hfAuth.signOut();
  });
});

test('an answer for another state is refused, and nothing is kept', async () => {
  await withStorage({}, async (storage) => {
    const shell = fakeShell({ listenAnswer: () => ({ code: 'stolen', state: 'someone-else' }) });
    await assert.rejects(
      hfAuth.beginOAuth({ clientId: CLIENT, fetchImpl: whoamiOk, settleMs: 0, ...shell }),
      /state mismatch/,
    );
    assert.ok(!shell.calls.includes('exchange'), 'the code is never traded');
    assert.equal(storage.getItem(hfAuth.TOKEN_KEY), null);

    // The shell's own refusal (hf_oauth.rs outcome) arrives as a rejection.
    const refused = fakeShell({ listenAnswer: () => { throw new Error('The sign-in answer did not match this request (state mismatch).'); } });
    refused.listen = async (s) => { refused.calls.push('listen'); await new Promise((r) => setTimeout(r, 5)); throw new Error('The sign-in answer did not match this request (state mismatch). ' + s.length); };
    await assert.rejects(hfAuth.beginOAuth({ clientId: CLIENT, fetchImpl: whoamiOk, settleMs: 0, ...refused }), /state mismatch/);
    assert.equal(storage.getItem(hfAuth.TOKEN_KEY), null);
  });
});

test('a busy port fails before a browser tab opens', async () => {
  await withStorage({}, async () => {
    const shell = fakeShell();
    shell.listen = async () => { shell.calls.push('listen'); throw new Error('port 47823 on 127.0.0.1 is busy'); };
    await assert.rejects(hfAuth.beginOAuth({ clientId: CLIENT, fetchImpl: whoamiOk, settleMs: 50, ...shell }), /busy/);
    assert.deepEqual(shell.calls, ['listen']);
  });
});

test('a token HF will not answer for is not kept', async () => {
  await withStorage({}, async (storage) => {
    const shell = fakeShell();
    const refuse = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(hfAuth.beginOAuth({ clientId: CLIENT, fetchImpl: refuse, settleMs: 0, ...shell }), /refused/);
    assert.equal(storage.getItem(hfAuth.TOKEN_KEY), null);
    const empty = fakeShell({ token: { error: 'invalid_grant' } });
    await assert.rejects(hfAuth.beginOAuth({ clientId: CLIENT, fetchImpl: whoamiOk, settleMs: 0, ...empty }), /invalid_grant/);
    assert.equal(storage.getItem(hfAuth.TOKEN_KEY), null);
  });
});

// ---- the client id -----------------------------------------------------------------

test('no client id: one click is not offered, and beginOAuth says so without listening', async () => {
  await withStorage({}, async (storage) => {
    assert.equal(hfAuth.resolveClientId(null), null);
    assert.equal(hfAuth.resolveClientId(''), null);
    assert.equal(hfAuth.resolveClientId('not an id!'), null);
    const shell = fakeShell();
    await assert.rejects(hfAuth.beginOAuth({ clientId: null, ...shell }), /not set up/);
    assert.deepEqual(shell.calls, []);

    // The build's id, then a Settings override on top of it, then cleared.
    assert.equal(hfAuth.resolveClientId(' built-in-id '), 'built-in-id');
    hfAuth.setClientIdOverride(CLIENT);
    assert.equal(storage.getItem(hfAuth.CLIENT_ID_KEY), CLIENT);
    assert.equal(hfAuth.CLIENT_ID_KEY, 'freeai4u.hf_client_id');
    assert.equal(hfAuth.resolveClientId('built-in-id'), CLIENT);
    assert.throws(() => hfAuth.setClientIdOverride('a b'), /letters, digits/);
    hfAuth.setClientIdOverride('');
    assert.equal(storage.getItem(hfAuth.CLIENT_ID_KEY), null);
    assert.equal(hfAuth.resolveClientId('built-in-id'), 'built-in-id');
  });
});

test('the sign-in box: one click with a client id, the token paste always, a setup link without', () => {
  const box = read('desktop', 'src', 'components', 'HfSignIn.tsx');
  assert.match(box, /Sign in with Hugging Face/);
  assert.match(box, /Use an access token instead/);
  assert.match(box, /Set up one-click sign-in/);
  assert.match(box, /Waiting for the browser/);
  assert.match(box, /hfAuth\.beginOAuth\(\{/);
  assert.match(box, /listen: hfOAuthListen/);
  assert.match(box, /hfOAuthCancel\(\)/);
  assert.match(box, /hfAuth\.resolveClientId\(buildId\)/);
  assert.match(box, /hfAuth\.configureRefresh\(hfOAuthRefresh\)/);
  assert.match(read('desktop', 'src', 'components', 'ConnectorsCard.tsx'), /<HfSignIn showClientId \/>/);
  const docs = read('docs', 'desktop.md');
  assert.match(docs, /### One-click Hugging Face sign-in/);
  assert.ok(hfAuth.DOCS_URL.endsWith('#one-click-hugging-face-sign-in'));
  assert.match(docs, /gh variable set NEURAOS_HF_CLIENT_ID --body/);
  assert.ok(docs.includes(REDIRECT));
});

// ---- refresh -------------------------------------------------------------------------

test('an expired oauth token is renewed with its refresh token; a refused one signs out', async () => {
  await withStorage({}, async (storage) => {
    const stale = { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000, source: 'oauth', client_id: CLIENT };
    hfAuth.saveToken(stale);
    let asked = null;
    const next = await hfAuth.refreshAccessToken(async (refreshToken, clientId) => {
      asked = { refreshToken, clientId };
      return { access_token: 'new', expires_in: 3600 };
    });
    assert.deepEqual(asked, { refreshToken: 'r1', clientId: CLIENT });
    assert.equal(next.access_token, 'new');
    assert.equal(next.refresh_token, 'r1', 'the refresh token is kept when HF does not rotate it');
    assert.equal(JSON.parse(storage.getItem(hfAuth.TOKEN_KEY)).source, 'oauth');

    // A network blip keeps the token; invalid_grant clears it.
    hfAuth.saveToken(stale);
    assert.equal(await hfAuth.refreshAccessToken(async () => { throw new Error('could not reach Hugging Face'); }), null);
    assert.equal(hfAuth.loadToken().access_token, 'old');
    assert.equal(await hfAuth.refreshAccessToken(async () => { throw new Error('Hugging Face token request failed (HTTP 400): invalid_grant'); }), null);
    assert.equal(hfAuth.loadToken(), null);
  });
});

test('accessToken starts the configured refresh in the background when the token is due', async () => {
  await withStorage({}, async () => {
    hfAuth.saveToken({ access_token: 'old', refresh_token: 'r1', expires_at: Date.now() + 10_000, source: 'oauth', client_id: CLIENT });
    let calls = 0;
    hfAuth.configureRefresh(async () => { calls += 1; return { access_token: 'fresh', expires_in: 3600 }; });
    assert.equal(hfAuth.accessToken().access_token, 'old', 'the current token is used until the new one lands');
    hfAuth.accessToken();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1, 'one refresh at a time');
    assert.equal(hfAuth.accessToken().access_token, 'fresh');
    hfAuth.signOut();
  });
});

// ---- the shell half (hf_oauth.rs), by source --------------------------------------------

test('the shell listens on the fixed redirect and checks the state before anything else', () => {
  const rust = read('desktop', 'src-tauri', 'src', 'hf_oauth.rs');
  assert.match(rust, /pub const REDIRECT_URI: &str = "http:\/\/127\.0\.0\.1:47823\/hf\/callback";/);
  assert.match(rust, /pub const PORT: u16 = 47823;/);
  assert.match(rust, /TcpListener::bind\(\("127\.0\.0\.1", PORT\)\)/, 'loopback only, the fixed port');
  assert.match(rust, /is busy/, 'a busy port is a clear error, not another port');
  assert.match(rust, /s\.as_str\(\) == expected_state/);
  const outcome = rust.slice(rust.indexOf('pub fn outcome'), rust.indexOf('fn hex_value'));
  assert.ok(outcome.indexOf('state_matches') < outcome.indexOf('callback.error'), 'state first');
  assert.match(outcome, /state mismatch/);
  assert.match(rust, /if redirect_uri != REDIRECT_URI \{/, 'the exchange only uses the registered redirect');
  assert.match(rust, /option_env!\("NEURAOS_HF_CLIENT_ID"\)/);
  assert.match(rust, /const TOKEN_URL: &str = "https:\/\/huggingface\.co\/oauth\/token";/);
  assert.match(rust, /\("grant_type", "authorization_code"\)/);
  assert.match(rust, /\("code_verifier", verifier\.as_str\(\)\)/);
  assert.match(rust, /\("grant_type", "refresh_token"\)/);
  assert.match(rust, /spawn_blocking/, 'the wait is off the main thread');
  assert.match(rust, /DEFAULT_TIMEOUT_SECS: u64 = 180/);

  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /^mod hf_oauth;$/m);
  for (const cmd of ['hf_oauth_config', 'hf_oauth_listen', 'hf_oauth_cancel', 'hf_oauth_exchange', 'hf_oauth_refresh']) {
    assert.match(main, new RegExp(`hf_oauth::${cmd},`), `${cmd} is registered`);
    assert.match(read('desktop', 'src', 'bridge.ts'), new RegExp(`'${cmd}'`), `${cmd} has a bridge wrapper`);
  }
  const ci = read('.github', 'workflows', 'desktop.yml');
  const build = ci.slice(ci.indexOf('- name: Build Tauri app'), ci.indexOf('- name:', ci.indexOf('- name: Build Tauri app') + 10));
  assert.match(build, /NEURAOS_HF_CLIENT_ID: \$\{\{ vars\.NEURAOS_HF_CLIENT_ID \}\}/);
});
