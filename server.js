const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const pkg = require('./package.json');
const {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  getConfiguredAccounts,
  verifyCredentials,
  signSession,
  verifySession,
  parseCookieHeader,
  checkRateLimit,
} = require('./auth.js');
const { matchListEntry, isFreeModelId, selectAllowedModels, isRetryableStatus, isQuotaExhausted, unsafeHeaderChar, SKILL_SOURCES, parseSkillFrontmatter } = require('./chatlib.js');
const {
  encryptJson,
  decryptJson,
  sessionMatchesUser,
  MAX_GITHUB_ACCOUNTS,
  normalizeGithubSession,
  accountsOf,
  pickAccount,
} = require('./github.js');

const port = process.env.PORT || 3000;
const rootDir = __dirname;
// '/api/health' is public on purpose: it reports what the running deploy
// actually is, so a merge can be confirmed live instead of assumed. The
// response is written to carry no secrets — see llmHealth.
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/api/health']);
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();
const GITHUB_COOKIE = 'fo_gh';
const GITHUB_STATE_COOKIE = 'fo_gh_state';
// Marks an "add another account" trip, so the callback can tell the user when
// GitHub silently handed back the account they already had.
const GITHUB_ADD_COOKIE = 'fo_gh_add';
const GITHUB_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_SCOPE = 'public_repo';
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set — using an ephemeral secret; sessions will not survive a restart.');
}

// A transient provider answer — 429 from a free tier, or the 5xx/no-response
// of a busy or overloaded upstream — means the work deserves another try rather
// than an error the user has to act on. Mirrors OpenCode's retry layer: a
// bounded attempt cap, exponential backoff with jitter, and a provider's own
// Retry-After (or retry-after-ms) header taking priority over our schedule
// when they send one, so their requested wait is respected instead of guessed.
// All of it reads at call time so tests can shrink it via env.
function rateLimitMaxAttempts() {
  const n = Number(process.env.RATE_LIMIT_MAX_ATTEMPTS);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 6;
}
const providerCooldownUntil = new Map();

function retryBaseDelayMs() {
  return Number(process.env.RATE_LIMIT_BASE_DELAY_MS) || 2500;
}

// OpenCode's backoff shape: delay = base * 2^attempt, with up to 25% random
// jitter so a burst of retries does not stampede the provider in lockstep.
function retryBackoffMs(attempt) {
  const base = retryBaseDelayMs() * 2 ** attempt;
  return Math.ceil(base + base * 0.25 * Math.random());
}

// Honest Retry-After parsing across the two shapes providers actually use:
// "retry-after-ms" as a millisecond number, then "retry-after" as either
// seconds or an HTTP-date. Anything unreadable returns undefined, which lets
// the caller fall back to its own backoff.
function parseRetryAfterMs(headers) {
  if (!headers) return undefined;
  const get = (name) => {
    try { return headers.get ? headers.get(name) : headers[name]; } catch { return undefined; }
  };
  const ms = get('retry-after-ms');
  if (ms !== undefined && ms !== null && ms !== '' && Number.isFinite(Number(ms))) return Number(ms);
  const sec = get('retry-after');
  if (sec === undefined || sec === null || sec === '') return undefined;
  if (Number.isFinite(Number(sec))) return Number(sec) * 1000;
  const date = Date.parse(sec);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerCooldownRemaining(providerId) {
  const until = providerCooldownUntil.get(providerId) || 0;
  return Math.max(0, until - Date.now());
}

function markProviderCooldown(providerId, durationMs) {
  providerCooldownUntil.set(providerId, Date.now() + durationMs);
}

// The shared retry shell behind both the JSON and streaming chat paths. It
// calls `attempt()` (which makes one provider request and returns either a
// `{ ok, status, data, retryAfterMs }` packet or a raw `Response`), retrying
// only on retryable statuses. A packet carries an optional retryAfterMs; a
// raw Response is read directly so the stream path honours upstream headers.
async function retryProviderRequest(providerId, attempt) {
  const maxAttempts = rateLimitMaxAttempts();
  let result;
  for (let tryNum = 0; tryNum < maxAttempts; tryNum += 1) {
    const wait = providerCooldownRemaining(providerId);
    if (wait > 0) await sleep(wait);
    try {
      result = await attempt();
    } catch (err) {
      // Our own deadline (headers/chat budget, or a client abort) is not a
      // provider "no response" to ride out — retrying it would re-spend the
      // same budget again. A genuine connection failure, though, is worth
      // probing up to the cap before the caller reports the real error.
      if (err.name === 'AbortError') throw err;
      const delay = Math.min(retryBackoffMs(tryNum), 30000);
      markProviderCooldown(providerId, delay + retryBaseDelayMs());
      if (tryNum >= maxAttempts - 1) throw err;
      await sleep(delay);
      continue;
    }
    let status = result && typeof result.status === 'number' ? result.status : 0;
    if (result && typeof result.status !== 'number') status = result.ok ? 200 : 599;
    // A timeout we imposed (providerFetch's own deadline) is a budget spent,
    // not a transient refusal to retry through.
    if (result.selfTimeout) return result;
    // A spent allowance is not a transient refusal — retrying it re-spends the
    // same wait for the same answer. Ollama Cloud's monthly cap and the
    // Antigravity proxy's "Quota Exhausted" both 429 with a body that says so.
    if (result && result.__quotaExhausted) return result;
    if (isQuotaExhausted(packetErrorMessage(result))) return result;
    if (!isRetryableStatus(status)) return result;
    if (tryNum >= maxAttempts - 1) break;
    const retryAfterMs =
      result && typeof result.headers === 'object' && typeof result.headers.get === 'function'
        ? parseRetryAfterMs(result.headers)
        : result && typeof result.retryAfterMs === 'number'
          ? result.retryAfterMs
          : undefined;
    // A provider's own wait wins; otherwise grow our backoff, capped so a long
    // run of refusals never sleeps past the hosting platform's own patience
    // (OpenCode caps its no-header delay at 30s too).
    const delay = retryAfterMs !== undefined ? retryAfterMs : Math.min(retryBackoffMs(tryNum), 30000);
    markProviderCooldown(providerId, delay + retryBaseDelayMs());
    await sleep(delay);
  }
  return result;
}

// Retries an idempotent provider call (chat completions) on retryable statuses.
// The last attempt is always returned as-is, so the caller can describe it.
async function fetchProviderWithRetry(providerId, fetchOnce) {
  return retryProviderRequest(providerId, fetchOnce);
}

// The streaming sibling: each attempt resolves to a raw Response so the caller
// can pipe the upstream body through. The retryable status arrives as the
// initial status before any body is read, so the same retry/cooldown logic
// applies. When the client cancels, `onAbort` aborts the in-flight read.
async function fetchStreamWithRetry(providerId, fetchRaw) {
  return retryProviderRequest(providerId, async () => {
    const response = await fetchRaw();
    if (!response || typeof response.status !== 'number' || !isRetryableStatus(response.status)) return response;
    // Read the refusal so a spent allowance can be reported instead of
    // retried. The body is small (an error message), and the caller only
    // ever reads it on the non-ok path anyway.
    const text = await response.text().catch(() => '');
    if (isQuotaExhausted(text)) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep null */ }
      return { ok: false, status: response.status, __quotaExhausted: true, json: async () => parsed };
    }
    // Drain the body so the socket is reusable before we retry. The raw
    // Response stays raw: its Retry-After is read from the headers by the
    // shared shell, and the caller needs the real `.ok`/`.json()`/`.body`.
    try { await response.body?.cancel(); } catch { /* ignore */ }
    return response;
  });
}

// Model catalogues are read from each provider at runtime so they can't go
// stale, but re-fetching them on every page load and provider switch multiplies
// upstream load and can edge a free tier into its rate limit. Cache the last
// good list per provider for a short window instead.
const modelCache = new Map();

function modelsCacheTtlMs() {
  return Number(process.env.MODELS_CACHE_TTL_MS) || 20 * 60 * 1000;
}

function clearModelCache() {
  modelCache.clear();
}

function readJsonBody(req, maxBytes, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      cb(new Error('Body too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (err) {
      cb(err);
    }
  });
  req.on('error', cb);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function isAuthenticated(req) {
  const accounts = getConfiguredAccounts(process.env);
  if (accounts.length === 0) return true; // auth disabled until vars are set
  const cookies = parseCookieHeader(req.headers.cookie);
  return !!verifySession(sessionSecret, cookies[SESSION_COOKIE_NAME]);
}

// The signed-in app account, or null when the login gate is off. The GitHub
// token is sealed against this so it can't cross accounts on a shared browser.
function currentAppUser(req) {
  if (getConfiguredAccounts(process.env).length === 0) return null;
  const cookies = parseCookieHeader(req.headers.cookie);
  return verifySession(sessionSecret, cookies[SESSION_COOKIE_NAME]);
}

function setSessionCookie(res, username, req) {
  const value = signSession(sessionSecret, username);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  // Drop the GitHub token alongside the session. Leaving it behind is what
  // let a logout hand the next user someone else's repo access.
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${GITHUB_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
}

function handleLogin(req, res) {
  readJsonBody(req, 2048, (err, body) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
      return;
    }
    const ip = clientIp(req);
    if (!checkRateLimit(loginAttempts, ip, Date.now(), LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many attempts — try again later' }));
      return;
    }
    const accounts = getConfiguredAccounts(process.env);
    const { username, password } = body || {};
    if (accounts.length > 0 && verifyCredentials(accounts, username, password)) {
      setSessionCookie(res, username, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid username or password' }));
  });
}

function handleLogout(req, res) {
  clearSessionCookie(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function githubRedirectUri(req) {
  return `${requestOrigin(req)}/api/github/callback`;
}

function getGithubSession(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = decryptJson(sessionSecret, cookies[GITHUB_COOKIE]);
  if (!session || typeof session.exp !== 'number' || session.exp <= Date.now()) return null;
  if (!sessionMatchesUser(session, currentAppUser(req))) return null;
  return normalizeGithubSession(session);
}

// Resolves the account a repo request should run as, answering the caller
// directly when it can't be decided rather than guessing.
function resolveAccount(req, res, repo) {
  const picked = pickAccount(getGithubSession(req), repo, new URL(req.url, 'http://x').searchParams.get('account'));
  if (picked.error) {
    sendJson(res, picked.error === 'GitHub not connected' ? 401 : 400, { error: picked.error });
    return null;
  }
  return picked.account;
}

async function githubApiFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'freeopenai-app',
      ...(options.headers || {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

function githubAuthorize(req, res) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId || !process.env.GITHUB_CLIENT_SECRET) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('GitHub connector is not configured — set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const adding = new URL(req.url, 'http://x').searchParams.get('add') === '1';
  res.setHeader('Set-Cookie', [
    `${GITHUB_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`,
    `${GITHUB_ADD_COOKIE}=${adding ? '1' : ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${adding ? 600 : 0}${secure}`,
  ]);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: githubRedirectUri(req),
    scope: GITHUB_SCOPE,
    state,
  });
  // Without this, GitHub silently reuses whichever account is signed in at
  // github.com and hands back the one already connected, so "add another
  // account" appears to do nothing. prompt=select_account forces the picker.
  // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
  if (adding) params.set('prompt', 'select_account');
  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` });
  res.end();
}

async function githubCallback(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const code = query.get('code');
  const state = query.get('state');
  const cookies = parseCookieHeader(req.headers.cookie);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${GITHUB_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);

  if (!code || !state || state !== cookies[GITHUB_STATE_COOKIE]) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('GitHub sign-in failed (state mismatch) — please try connecting again from Settings.');
    return;
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: githubRedirectUri(req),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('GitHub sign-in failed: ' + (tokenData.error_description || tokenData.error || 'unknown error'));
      return;
    }

    const { data: user } = await githubApiFetch(tokenData.access_token, 'https://api.github.com/user');
    // Keep any accounts already connected. Reconnecting the same GitHub login
    // replaces its entry rather than adding a duplicate.
    const connected = accountsOf(getGithubSession(req));
    const wasAlreadyConnected = connected.some((a) => a.login === (user && user.login));
    const wasAddingAnother = cookies[GITHUB_ADD_COOKIE] === '1';
    const existing = connected.filter((a) => a.login !== (user && user.login));
    const accounts = [
      ...existing,
      { token: tokenData.access_token, login: user && user.login, avatarUrl: user && user.avatar_url },
    ].slice(-MAX_GITHUB_ACCOUNTS);

    const sealed = encryptJson(sessionSecret, {
      appUser: currentAppUser(req),
      accounts,
      exp: Date.now() + GITHUB_TOKEN_TTL_MS,
    });
    res.setHeader('Set-Cookie', [
      `${GITHUB_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
      `${GITHUB_ADD_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
      `${GITHUB_COOKIE}=${sealed}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(GITHUB_TOKEN_TTL_MS / 1000)}${secure}`,
    ]);
    // Asking for another account and getting the same one back is GitHub
    // reusing whoever is signed in at github.com. Say so, or the click looks
    // like it did nothing at all.
    const sameAgain = wasAddingAnother && wasAlreadyConnected;
    res.writeHead(302, {
      Location: '/?view=settings' + (sameAgain ? '&gh=same&login=' + encodeURIComponent(user.login) : ''),
    });
    res.end();
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('GitHub sign-in failed: ' + err.message);
  }
}

function githubStatus(req, res) {
  const accounts = accountsOf(getGithubSession(req));
  sendJson(res, 200, {
    connected: accounts.length > 0,
    accounts: accounts.map((a) => ({ login: a.login, avatarUrl: a.avatarUrl })),
    canAddMore: accounts.length < MAX_GITHUB_ACCOUNTS,
    // Kept so an older cached page still shows the right thing.
    login: accounts.length ? accounts[0].login : undefined,
  });
}

function githubDisconnect(req, res) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const only = new URL(req.url, 'http://x').searchParams.get('account');
  const remaining = only ? accountsOf(getGithubSession(req)).filter((a) => a.login !== only) : [];

  if (remaining.length) {
    const sealed = encryptJson(sessionSecret, {
      appUser: currentAppUser(req),
      accounts: remaining,
      exp: Date.now() + GITHUB_TOKEN_TTL_MS,
    });
    res.setHeader('Set-Cookie', `${GITHUB_COOKIE}=${sealed}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(GITHUB_TOKEN_TTL_MS / 1000)}${secure}`);
  } else {
    res.setHeader('Set-Cookie', `${GITHUB_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  }
  sendJson(res, 200, { ok: true });
}

async function githubRepos(req, res) {
  const accounts = accountsOf(getGithubSession(req));
  if (!accounts.length) return sendJson(res, 401, { error: 'GitHub not connected' });
  try {
    const perAccount = await Promise.all(
      accounts.map(async (account) => {
        const { ok, data } = await githubApiFetch(
          account.token,
          'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator'
        );
        if (!ok || !Array.isArray(data)) return [];
        return data
          .filter((r) => !r.private)
          .map((r) => ({
            fullName: r.full_name,
            description: r.description,
            defaultBranch: r.default_branch,
            // Which connected account can reach this repo. The model passes it
            // back so an org repo doesn't have to be guessed at.
            account: account.login,
          }));
      })
    );
    // The same repo can be visible to two accounts; keep one row per pairing
    // but never two identical ones.
    const seen = new Set();
    const repos = perAccount.flat().filter((r) => {
      const key = r.account + '/' + r.fullName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    sendJson(res, 200, repos);
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

async function githubListDir(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const repo = query.get('repo');
  const dirPath = query.get('path') || '';
  if (!repo) return sendJson(res, 400, { error: 'repo is required' });
  const account = resolveAccount(req, res, repo);
  if (!account) return;
  const encoded = dirPath ? dirPath.split('/').map(encodeURIComponent).join('/') : '';
  try {
    const { ok, status, data } = await githubApiFetch(
      account.token,
      `https://api.github.com/repos/${repo}/contents/${encoded}`
    );
    if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not list path' });
    // A file path returns an object rather than an array; say so plainly so
    // the caller knows to read it instead of listing it.
    if (!Array.isArray(data)) return sendJson(res, 400, { error: 'Path is a file, not a directory' });
    sendJson(res, 200, data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

async function githubGetFile(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const repo = query.get('repo');
  const filePath = query.get('path');
  if (!repo || !filePath) return sendJson(res, 400, { error: 'repo and path are required' });
  const account = resolveAccount(req, res, repo);
  if (!account) return;
  try {
    const { ok, status, data } = await githubApiFetch(
      account.token,
      `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}`
    );
    if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not read file' });
    if (Array.isArray(data) || !data.content) return sendJson(res, 400, { error: 'Path is a directory, not a file' });
    sendJson(res, 200, { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha, path: data.path });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

function githubPutFile(req, res) {
  readJsonBody(req, 512 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const { repo, path: filePath, content, message, sha, account: requested } = body || {};
    if (!repo || !filePath || typeof content !== 'string' || !message) {
      return sendJson(res, 400, { error: 'repo, path, content, and message are required' });
    }
    const picked = pickAccount(getGithubSession(req), repo, requested);
    if (picked.error) {
      return sendJson(res, picked.error === 'GitHub not connected' ? 401 : 400, { error: picked.error });
    }
    const account = picked.account;

    // GitHub needs the file's current sha to update it, and refuses without
    // one. Making the caller carry that between a read and a write was a
    // mistake: a model that commits without reading first, or reads as one
    // account and commits as another, loses it and the commit fails on a
    // detail it should never have been handling. Look it up here instead. A
    // 404 means the file is new, which is the one case where no sha is right.
    let resolvedSha = sha;
    if (!resolvedSha) {
      const existing = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}`
      );
      if (existing.ok && existing.data && existing.data.sha && !Array.isArray(existing.data)) {
        resolvedSha = existing.data.sha;
      }
    }

    try {
      const { ok, status, data } = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64'), sha: resolvedSha || undefined }),
        }
      );
      if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not commit file' });
      sendJson(res, 200, {
        sha: data.content.sha,
        htmlUrl: data.content.html_url,
        commitUrl: data.commit.html_url,
        account: account.login,
      });
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
  });
}

// Direct provider access, as an alternative to Puter. Each of these is
// OpenAI-compatible, so one adapter covers all of them: only the base URL, the
// key and a couple of headers differ.
//
// Keys live here, never in the browser. The whole API surface already sits
// behind the login gate, so a key can't be read by anyone who isn't signed in.
const LLM_PROVIDERS = {
  aigateway: {
    label: 'AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    envVar: 'AI_GATEWAY_API_KEY',
    // Pinned to the allowed set, in picker order. Anything else the key can
    // reach stays out of the list rather than appearing and failing on use.
    models: [
      'poolside/laguna-s-2.1',
      'ling-3.0-flash-sante-free',
      'ling-3.0-flash-fin-free',
      'fish-audio/s2.1-pro-free',
    ],
  },
  nara: {
    label: 'Nara',
    baseUrl: 'https://router.bynara.id/v1',
    envVar: 'NARA_API_KEY',
    // Pinned to the allowed set, in picker order. Anything else the key can
    // reach stays out of the list rather than appearing and failing on use.
    models: [
      'agnes-2.5-flash',
      'laguna-s-2.1',
      'ling-3.0-flash-fin-free',
      'nemotron-3.5-lightning-free',
      'stepfun-3.7-flash',
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    // Free-tier only. Every id below carries the ":free" suffix and was
    // verified against the live catalogue (https://openrouter.ai/api/v1/models)
    // on 2026-09-12: 445 models total, 19 of them free. Paid ids were pulled —
    // they only ever produced 402/403 errors on a free key. The allowlist is
    // intersected with the live catalogue, so when one of these is retired the
    // picker silently drops it instead of failing at send time.
    //
    // Being listed as free upstream is not enough, which is why one free id is
    // missing below. OpenRouter also gates some free models to apps it has
    // approved as an "agentic harness", and answers 403 for the rest -- so an
    // id can be in the catalogue, priced at zero, and still be unroutable for
    // us. Nothing in /models marks that gate, so it cannot be filtered out
    // automatically, only learned from a refusal or left out by hand.
    models: [
      // Long-context reasoning: the 1M-context trio.
      //
      // thinkingmachines/inkling:free is left out on purpose: it is what
      // produced "403: thinkingmachines/inkling:free is only available on
      // agentic harnesses" on a free key. thinkingmachines/inkling-small:free
      // is kept because the gate has only been observed on the larger model --
      // removing a working id on the strength of its name would cost a usable
      // model, so it stays until a refusal proves otherwise.
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'thinkingmachines/inkling-small:free',
      // General chat.
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'inclusionai/ling-3.0-flash-vl:free',
      'nex-agi/nex-n2.5-pro:free',
      'nex-agi/nex-n2.5-mini:free',
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      // Code.
      'cohere/north-mini-code:free',
      // Long-form / niche variants.
      'dots-studio/dots-3-note-preview:free',
      'liquid/lfm-2.5-2.6b:free',
      'inclusionai/ling-3.0-flash-sante:free',
      'inclusionai/ling-3.0-flash-fin:free',
      // Omni (text+audio) — still emits text.
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      // Content-safety classifier; excluded from the picker by the chat filter.
      'nvidia/nemotron-3.5-content-safety:free',
    ],
    // Keep the picker on the free tier even when the allowlist above is
    // edited or a paid id sneaks back in. Set OPENROUTER_FREE_ONLY=0 to let
    // paid models through.
    freeOnly: process.env.OPENROUTER_FREE_ONLY !== '0',
    // Optional attribution headers OpenRouter documents for its leaderboards.
    headers: (req) => ({ 'HTTP-Referer': requestOrigin(req), 'X-Title': 'FreeAi4U' }),
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envVar: 'NVIDIA_API_KEY',
    // The allowed set, in picker order. Anything else the key can reach stays
    // out of the list rather than appearing and failing on use. Declared as
    // rules rather than a bare array so a repeated id here cannot put the same
    // model in the picker twice -- mistral-medium was listed twice before this.
    models: {
      exact: [
        'z-ai/glm-5.3',
        'deepseek-ai/deepseek-v4-flash',
        'deepseek-ai/deepseek-v4-pro',
        'moonshotai/kimi-k3',
        'minimaxai/minimax-m3',
        'z-ai/glm-5.2',
        'minimaxai/minimax-m2.7',
        'mistralai/mistral-medium-3.5-128b',
        'qwen/qwen3-coder-480b-a35b-instruct',
        'nvidia/nemotron-3.5-lightning',
        'google/gemma-4-31b-it',
        'qwen/qwen2.5-coder-32b-instruct',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'nvidia/nemotron-3-ultra-550b-a55b',
      ],
    },
  },
  // Hugging Face Inference Providers: one OpenAI-compatible router
  // (router.huggingface.co/v1) in front of every serverless provider on the
  // Hub, metered in monthly inference credits (~$0.10/mo on a free account).
  // There is no such thing as a "free model list" on it: the
  // huggingface.co/models?other=free page filters nothing (the API ignores
  // other=<anything> and returns the unfiltered trending set), and the 29
  // models under the page's 'free' chip carry a community-authored tag that
  // no inference provider honours — all 29 were checked against the router
  // on 2026-09-12 and none is served. The real free tier is credits, so what
  // matters is price per model. The allowlist below is therefore the
  // router's full live chat catalogue (138 models, verified 2026-09-12),
  // ordered cheapest first, with the five zero-priced offerings up top. When
  // HF retires an id, the intersection with the live catalogue drops it from
  // the picker instead of failing on use — the same contract as the
  // OpenRouter list above. HF's own docs and clients standardise on
  // HF_TOKEN, so that is the variable here too, and HF_MODELS replaces the
  // list wholesale for an operator who wants a different cut.
  huggingface: {
    label: 'HuggingFace',
    baseUrl: 'https://router.huggingface.co/v1',
    envVar: 'HF_TOKEN',
    models: [
      // Served at zero price (ovhcloud / novita / together) — these never touch credits.
      "Qwen/Qwen3.8-27B",
      "inclusionAI/Ling-3.0-flash-VL",
      "prism-ml/Ternary-Bonsai-27B-gguf",
      "inclusionAI/Ling-3.0-flash-Fin",
      "prism-ml/Ternary-Bonsai-27B-AWQ-4bit",
      // Under ~$0.15/M blended — a $0.10 monthly credit goes a long way here.
      "Qwen/Qwen3-4B-Instruct-2507",
      "Qwen/Qwen2.5-Coder-7B-Instruct",
      "Qwen/Qwen2.5-Coder-3B-Instruct",
      "Qwen/Qwen3-4B-Thinking-2507",
      "meta-llama/Llama-3.1-8B-Instruct",
      "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
      "Sao10K/L3-8B-Stheno-v3.2",
      "Sao10K/L3-8B-Lunaris-v1",
      "ibm-granite/granite-4.2-3b",
      "google/gemma-3-4b-it",
      "openai/gpt-oss-20b",
      "zai-org/AutoGLM-Phone-9B-Multilingual",
      "google/gemma-3-12b-it",
      "openai/gpt-oss-120b",
      "microsoft/phi-4",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "inclusionAI/Ling-3.0-flash",
      "google/gemma-3-27b-it",
      "Qwen/Qwen3.5-9B",
      "Qwen/Qwen3-8B",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V4-Flash",
      "Qwen/Qwen3-14B",
      // Mid-priced.
      "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
      "swiss-ai/Apertus-v1.5-8B",
      "swiss-ai/Apertus-8B-Instruct-2509",
      "ibm-granite/granite-4.2-8b",
      "Qwen/Qwen3-32B",
      "meta-llama/Llama-Guard-4-12B",
      "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
      "stepfun-ai/Step-3.5-Flash",
      "google/gemma-4-26B-A4B-it",
      "XiaomiMiMo/MiMo-V2.5",
      "zai-org/GLM-4.7-Flash",
      "google/gemma-4-31B-it",
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen2.5-7B-Instruct",
      "aisingapore/Gemma-SEA-LION-v4-27B-IT",
      "Qwen/Qwen3-30B-A3B",
      "deepseek-ai/DeepSeek-V3.2",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "zai-org/GLM-5.3-Flash",
      "deepseek-ai/DeepSeek-V3.2-Exp",
      "tencent/Hy3",
      "Qwen/Qwen3-VL-30B-A3B-Instruct",
      "aisingapore/Qwen-SEA-LION-v4-32B-IT",
      "Qwen/Qwen2.5-72B-Instruct",
      "speakleash/Bielik-11B-v3.0-Instruct",
      "Qwen/Qwen3-235B-A22B",
      "ibm-granite/granite-4.2-30b",
      "zai-org/GLM-4.5-Air",
      "Qwen/Qwen3.6-35B-A3B",
      "Qwen/Qwen3-VL-235B-A22B-Instruct",
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "Qwen/Qwen3.5-35B-A3B",
      "deepseek-ai/DeepSeek-V3-0324",
      "Qwen/Qwen3-Next-80B-A3B-Instruct",
      // Premium flagships — spend credits here deliberately.
      "deepseek-ai/DeepSeek-V3.1",
      "zai-org/GLM-4.6V-Flash",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-V3.1-Terminus",
      "alpindale/WizardLM-2-8x22B",
      "MiniMaxAI/MiniMax-M2.7",
      "stepfun-ai/Step-3.7-Flash",
      "MiniMaxAI/MiniMax-M3",
      "NousResearch/Hermes-3-Llama-3.1-70B",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "meta-models/Muse-Glimmer-30B",
      "MiniMaxAI/MiniMax-M2",
      "MiniMaxAI/MiniMax-M2.1",
      "MiniMaxAI/MiniMax-M2.5",
      "XiaomiMiMo/MiMo-V2.5-Pro",
      "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
      "thinkingmachines/Inkling-Small",
      "baidu/ERNIE-4.5-VL-424B-A47B-Base-PT",
      "Qwen/Qwen3-Coder-Next",
      "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "Qwen/Qwen2.5-VL-72B-Instruct",
      "zai-org/GLM-4.7",
      "zai-org/GLM-4-32B-0414",
      "zai-org/GLM-4.5V",
      "zai-org/GLM-4.6",
      "Qwen/Qwen3-235B-A22B-Thinking-2507",
      "deepseek-ai/DeepSeek-R1-0528",
      "zai-org/GLM-5",
      "Qwen/Qwen3.5-122B-A10B",
      "Qwen/Qwen3.5-27B",
      "moonshotai/Kimi-K2.5",
      "MiniMaxAI/MiniMax-M1-80k",
      "moonshotai/Kimi-K2-Instruct",
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      "moonshotai/Kimi-K2-Instruct-0905",
      "zai-org/GLM-5.2",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen3.5-397B-A17B",
      "Qwen/Qwen3.6-27B",
      "swiss-ai/Apertus-v1.5-70B",
      "deepseek-ai/DeepSeek-V4-Pro",
      "deepseek-ai/DeepSeek-V4-Pro-0813",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.6",
      "zai-org/GLM-5.1",
      "Qwen/Qwen3-VL-235B-A22B-Thinking",
      "thinkingmachines/Inkling",
      "zai-org/GLM-5.3",
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16",
      "Qwen/Qwen3.8-2.4T-A95B",
      "moonshotai/Kimi-K3",
      // No pricing published in the catalogue (CohereLabs) — cost unknown, so they ride last.
      "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
      "zai-org/GLM-5.3-Flash-BF16",
      "zai-org/GLM-5.3-BF16",
      "openai/gpt-oss-safeguard-20b",
      "CohereLabs/aya-vision-32b",
      "zai-org/GLM-4.5V-FP8",
      "zai-org/GLM-4.6V",
      "zai-org/GLM-4.6V-FP8",
      "zai-org/GLM-4.6-FP8",
      "zai-org/GLM-4.7-FP8",
      "CohereLabs/c4ai-command-r-08-2024",
      "zai-org/GLM-5.2-FP8",
      "CohereLabs/aya-expanse-32b",
      "CohereLabs/c4ai-command-r7b-12-2024",
      "CohereLabs/c4ai-command-r7b-arabic-02-2025",
      "CohereLabs/c4ai-command-a-03-2025",
      "CohereLabs/command-a-reasoning-08-2025",
      "CohereLabs/command-a-translate-08-2025",
      "CohereLabs/tiny-aya-global",
      "CohereLabs/tiny-aya-water",
      "CohereLabs/tiny-aya-earth",
      "CohereLabs/tiny-aya-fire",
    ],
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envVar: 'MISTRAL_API_KEY',
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    // A key alone means Ollama Cloud rather than a local server: no key is
    // needed to reach a local instance (it usually sends none), while a real
    // OLLAMA_API_KEY from ollama.com pairs with its hosted /v1 endpoint.
    // An explicit OLLAMA_BASE_URL always wins, so a self-hosted install or a
    // different gateway is reachable with the same key anyway.
    cloudBaseUrl: 'https://ollama.com/v1',
    envVar: 'OLLAMA_API_KEY',
    // Local servers usually take no key. Appearing is opt-in: a key or an
    // explicit base URL puts it in the picker, and an empty key sends no
    // auth header at all rather than a bare "Bearer ".
    needsKey: false,
    // Pinned to the allowed set, in picker order. Anything else the key can
    // reach stays out of the list rather than appearing and failing on use.
    models: [
      'hf.co/unsloth/GLM-5.3-GGUF:latest',
      'deepseek-r1:8b',
      'deepseek-r1:70b',
      'hf.co/unsloth/kimi-k2.7-code-7b-GGUF:latest',
      'qwen3:8b',
      'qwen3:4b',
      'minimax/m3-20b',
      'minimax/m2.7-9b',
      'z-ai/glm-5.2',
      'hf.co/unsloth/glm-5.1-GGUF:latest',
      'devstral:24b',
      'devstral:7b',
      'qwen3-coder:32b',
      'qwen3-coder:7b',
      'nvidia/nemotron-3.5-lightning',
      'mistralai/mistral-medium-3.5-128b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'hf.co/unsloth/muse-glimmer-30b-GGUF:latest',
      'qwen2.5-coder:32b',
      'ibm/granite-4.2b-instruct:latest',
      'rnj-1:latest',
      'hf.co/unsloth/north-mini-code-1.0-GGUF:latest',
      'deepseek-r1:14b',
    ],
  },
  // Google Antigravity through an OpenAI-compatible proxy (antigravity-proxy),
  // which owns the Google accounts — antigravity-auth is how those accounts are
  // obtained, and it stays on the operator's machine. The proxy speaks plain
  // OpenAI, so this is an ordinary provider with two differences: it has no key
  // of its own, and it usually runs beside the user rather than on the public
  // internet, so it appears only once its base URL (or a key) is set.
  //
  // It publishes no model catalogue, so `catalogue: false` serves the pinned
  // list below instead of asking an endpoint the proxy may not implement — a
  // 404 there would turn a working setup into an empty picker plus a fetch
  // error. These ids are the ones the proxy documented; they drift between its
  // releases, so ANTIGRAVITY_MODELS replaces the list without a code change.
  antigravity: {
    label: 'Antigravity',
    baseUrl: 'http://localhost:3000/v1',
    envVar: 'ANTIGRAVITY_API_KEY',
    needsKey: false,
    catalogue: false,
    models: [
      // The reason this provider is worth wiring up at all: Opus through a
      // quota the user already has, with the thinking variants alongside it.
      'antigravity-claude-opus-4-6-thinking-high',
      'antigravity-claude-opus-4-6-thinking-medium',
      'antigravity-claude-opus-4-6-thinking-low',
      'antigravity-claude-opus-4-6-thinking',
      'antigravity-claude-sonnet-4-6-thinking-high',
      'antigravity-claude-sonnet-4-6',
      'antigravity-claude-sonnet-4-5',
      'antigravity-gemini-3.1-pro-high',
      'antigravity-gemini-3.1-pro-low',
      'antigravity-gemini-3-pro-high',
      'antigravity-gemini-3-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
  },
  // The three below are speech and search services. Probing them directly:
  //
  //   api.deepgram.com/v1/chat/completions   -> 404
  //   api.assemblyai.com/v1/chat/completions -> 404
  //   api.you.com/*                          -> 401 on every path, including
  //                                             ones that don't exist
  //
  // So the first two have no chat endpoint to reach and you.com's is unproven.
  // They're wired up anyway at the user's request so a key can settle it, and
  // each stays hidden until its key is set. They use their own auth schemes --
  // sending Bearer would make a test fail for the wrong reason.
  deepgram: {
    label: 'Deepgram',
    baseUrl: 'https://api.deepgram.com/v1',
    envVar: 'DEEPGRAM_API_KEY',
    authScheme: 'Token',
    kind: 'speech',
    note: 'Deepgram is a speech service. Its /v1/models returns transcription models — nova, whisper and the like, each with a language list — and its /v1/chat/completions answers 404. There are no chat models to list, whatever key is set.',
  },
  assemblyai: {
    label: 'AssemblyAI',
    baseUrl: 'https://api.assemblyai.com/v1',
    envVar: 'ASSEMBLYAI_API_KEY',
    authScheme: '',
    kind: 'speech',
    note: 'AssemblyAI is a speech-to-text service. It has no /v1/models and no chat completions endpoint; transcription lives at /v2/transcript.',
  },
  youcom: {
    label: 'You.com',
    baseUrl: 'https://api.you.com/v1',
    envVar: 'YOUCOM_API_KEY',
    authHeader: 'X-API-Key',
    authScheme: '',
    kind: 'search',
    note: 'You.com sells web search and research, not model inference. It has no model catalogue to list.',
  },
};

// Companion variable names derive from the key variable: NARA_API_KEY pairs
// with NARA_BASE_URL and NARA_MODELS. A key variable that does not end in
// _API_KEY (Hugging Face standardises on HF_TOKEN) must never map onto itself
// -- the replace() would no-op and the key would be read back as the base-URL
// override, sending every request to a host named after the token. A variable
// with neither suffix still gets a sibling rather than itself.
function providerEnvName(envVar, suffix) {
  const stem = envVar.replace(/_(API_KEY|TOKEN)$/, '');
  return stem === envVar ? envVar + suffix : stem + suffix;
}

function providerIsConfigured(provider) {
  if (process.env[provider.envVar]) return true;
  // Key-optional providers (local servers) opt in with an explicit base URL.
  return provider.needsKey === false && !!process.env[providerEnvName(provider.envVar, '_BASE_URL')];
}

// Providers whose documented base URL stops short of the OpenAI path. Ollama
// and the Antigravity proxy both accept "http://host:port", and both serve
// /v1/... underneath it, so the version segment is added when it is missing
// rather than making every operator remember to type it.
const V1_APPENDED_PROVIDERS = new Set(['ollama', 'antigravity', 'huggingface']);

function normalizeProviderBaseUrl(id, raw) {
  const base = String(raw || '').replace(/\/+$/, '');
  if (!V1_APPENDED_PROVIDERS.has(id) || /\/v1$/i.test(base)) return base;
  return base + '/v1';
}

function providerConfig(id) {
  const provider = LLM_PROVIDERS[id];
  if (!provider) return null;
  if (!providerIsConfigured(provider)) return null;
  const key = (process.env[provider.envVar] || '').trim();
  // A base URL override lets the same adapter reach a self-hosted NIM or a
  // proxy, and lets the tests point at a local stand-in. Without one, a
  // key-less/local provider keeps its default address — except a provider
  // that ships a cloudBaseUrl: there a real key means the hosted endpoint,
  // and the local default only applies when it is the operator's own install.
  const override = process.env[providerEnvName(provider.envVar, '_BASE_URL')];
  const rawBaseUrl = override || (key && provider.cloudBaseUrl) || provider.baseUrl;
  const baseUrl = normalizeProviderBaseUrl(id, rawBaseUrl);
  // A model list can be declared outright, which matters for a provider whose
  // catalogue is missing or whose ids move between releases: setting
  // PROVIDER_MODELS replaces the pinned allowlist for that provider alone.
  const declared = process.env[providerEnvName(provider.envVar, '_MODELS')];
  const models = declared
    ? declared.split(',').map((id) => id.trim()).filter(Boolean)
    : provider.models;
  const configured = { ...provider, key, baseUrl, models };
  // A key travels in an HTTP header, so a non-ASCII character in it (an em
  // dash from a word processor, a smart quote from autocorrect) makes the
  // fetch throw "Cannot convert argument to a ByteString" — a crash that
  // names neither the key nor the provider. Name both, before any fetch.
  const bad = unsafeHeaderChar(key);
  if (bad) {
    configured.keyError =
      `${provider.envVar} contains a non-ASCII character '${bad.char}' (U+${bad.code.toString(16).toUpperCase()}) at position ${bad.index}. ` +
      `Keys must be plain ASCII — this usually means placeholder text or a word processor's dash got pasted in. ` +
      `Re-copy the key from its source.`;
  }
  return configured;
}

// The error text of a retry packet, for the quota-exhaustion check: the body
// is `{ error: string }` or `{ error: { message } }` depending on the provider.
function packetErrorMessage(result) {
  const data = result && result.data;
  if (!data) return '';
  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return '';
}

// Deploy verification, deliberately public: it exists so a merge can be
// confirmed live instead of assumed. That makes this field list a security
// boundary — ids and counters only, never keys, base URLs, account names or
// paths, and never whether a provider is configured, which would let anyone
// enumerate which of the operator's keys are present.
function llmHealth(req, res) {
  // The route below accepts HEAD as well as GET, so an uptime monitor lands
  // here instead of falling through to the static handler, which answers 200
  // with index.html. Node suppresses the body for a HEAD response on its own.
  sendJson(res, 200, {
    ok: true,
    version: pkg.version,
    // Railway injects these; null locally, which is itself the answer.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    uptimeSeconds: Math.round(process.uptime()),
    // Source knowledge, not deployment state: every provider this build knows.
    providers: Object.keys(LLM_PROVIDERS),
    // Whether this deployment asks for a login of its own. Not a secret, and
    // not deployment state either: an unauthenticated visitor already learns it
    // from the redirect to /login.html. The page needs it to decide whether a
    // direct provider can be used without a Puter account — see
    // needsPuterAccount in chatlib.js for why that matters.
    loginRequired: getConfiguredAccounts(process.env).length > 0,
  }, { 'Cache-Control': 'no-store' });
}

// Which providers the user can actually pick. A provider with no key stays out
// of the list rather than appearing and failing on first use.
function llmProviders(req, res) {
  sendJson(res, 200, Object.entries(LLM_PROVIDERS).map(([id, provider]) => ({
    id,
    label: provider.label,
    configured: providerIsConfigured(provider),
    // 'speech' and 'search' services have no chat models. Saying so beats an
    // empty dropdown that looks like a bug.
    kind: provider.kind || 'chat',
    note: provider.note,
  })));
}

// The effective response knobs, so Settings can show what the server is
// actually enforcing instead of hardcoding the same numbers twice.
function llmLimits(req, res) {
  const t = providerTimeoutMs();
  sendJson(res, 200, {
    timeouts: { models: t.models, chat: t.chat, headers: t.headers, stall: t.stall },
    retries: { maxAttempts: rateLimitMaxAttempts(), baseDelayMs: retryBaseDelayMs() },
  });
}

// Web research for the chat: search without a key (DuckDuckGo instant
// answers plus Wikipedia), and read pages as plain text. Both are
// curiosity-driven GETs sharing one small fetch helper with a hard timeout;
// nothing here posts data anywhere.
const WEB_FETCH_TIMEOUT_MS = 15000;
const WEB_FETCH_MAX_BYTES = 600 * 1024;

async function fetchText(url, acceptHtml = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'FreeAi4U/1.0 (+https://github.com/tradernonymous/freeopenai)',
        Accept: acceptHtml ? 'text/html,*/*' : 'application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// SSRF guard: the fetch endpoint reads user-supplied URLs, so loopback,
// private ranges and link-local never resolve. Hostnames resolve first
// because a name can point at a private address behind our back.
function isPrivateIp(addr) {
  if (!addr) return true;
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

function lookupHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => (err ? reject(err) : resolve(address)));
  });
}

// Strip a page to readable text: drop scripts, styles, nav and comments,
// decode the common entities, collapse whitespace. Crude next to
// Readability, but dependency-free and honest about what it is.
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'");
}

function extractPageText(html) {
  if (!html) return { title: '', text: '' };
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  const text = String(html)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return {
    title: decodeEntities(titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : ''),
    text: decodeEntities(text).replace(/\s+/g, ' ').trim(),
  };
}

function normalizeDdG(data) {
  const out = [];
  const push = (title, url, snippet) => {
    if (title && url && /^https?:/i.test(url)) out.push({ title: String(title), url: String(url), snippet: String(snippet || '') });
  };
  if (!data || typeof data !== 'object') return out;
  if (data.AbstractText && data.AbstractURL) {
    push(data.AbstractText.slice(0, 200), data.AbstractURL, data.AbstractSource ? `Source: ${data.AbstractSource}` : '');
  }
  for (const t of [...(data.RelatedTopics || []), ...(data.Results || [])]) {
    if (!t || typeof t !== 'object') continue;
    if (Array.isArray(t.Topics)) {
      t.Topics.forEach((s) => push(s.Text && s.Text.slice(0, 200), s.FirstURL, ''));
    } else {
      push(t.Text && t.Text.slice(0, 200), t.FirstURL, '');
    }
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

function normalizeWiki(data) {
  // Opensearch shape: [query, [titles], [descs], [urls]].
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  return data[1].slice(0, 5).map((title, i) => ({
    title: String(title),
    url: String(((data[3] || [])[i]) || ''),
    snippet: String(((data[2] || [])[i]) || ''),
  })).filter((r) => r.url);
}

function normalizeWikiFull(data) {
  // Full-text search: almost any query returns titled hits with snippets.
  const list = data && data.query && Array.isArray(data.query.search) ? data.query.search : [];
  return list.slice(0, 5).map((s) => ({
    title: String((s && s.title) || ''),
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String((s && s.title) || '').replace(/ /g, '_')),
    snippet: String((s && s.snippet) || '').replace(/<[^>]+>/g, ''),
  })).filter((r) => r.title);
}

async function llmWebsearch(req, res) {
  const q = new URL(req.url, 'http://x').searchParams.get('q');
  if (!q || !q.trim()) return sendJson(res, 400, { error: 'q is required' });
  const query = q.trim().slice(0, 300);
  const [ddg, wiki, full] = await Promise.all([
    fetchText(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, false)
      .then((t) => { try { return normalizeDdG(JSON.parse(t)); } catch { return []; } })
      .catch(() => []),
    fetchText(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&format=json`, false)
      .then((t) => { try { return normalizeWiki(JSON.parse(t)); } catch { return []; } })
      .catch(() => []),
    fetchText(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json`, false)
      .then((t) => { try { return normalizeWikiFull(JSON.parse(t)); } catch { return []; } })
      .catch(() => []),
  ]);
  const seen = new Set();
  const results = [...ddg, ...wiki, ...full].filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  }).slice(0, 10);
  if (!results.length) return sendJson(res, 502, { error: 'Search is unreachable right now — try again, or paste a link to read directly.' });
  sendJson(res, 200, { query, results });
}

async function llmFetch(req, res) {
  const raw = new URL(req.url, 'http://x').searchParams.get('url');
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    return sendJson(res, 400, { error: 'A valid http(s) url is required' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return sendJson(res, 400, { error: 'Only http(s) pages can be read' });
  }
  let address;
  try {
    address = await lookupHost(parsed.hostname);
  } catch {
    return sendJson(res, 502, { error: 'Could not resolve that host' });
  }
  if (isPrivateIp(address)) return sendJson(res, 403, { error: 'That address is not readable from here' });
  let html;
  try {
    html = await fetchText(parsed.href);
  } catch (e) {
    return sendJson(res, 502, { error: e.name === 'AbortError' ? 'The page took too long to answer' : 'Could not read that page: ' + e.message });
  }
  if (html.length > WEB_FETCH_MAX_BYTES) {
    return sendJson(res, 400, { error: 'That page is too large to read here' });
  }
  const { title, text } = extractPageText(html);
  if (!text) return sendJson(res, 502, { error: 'Nothing readable on that page' });
  sendJson(res, 200, { url: parsed.href, title, text: text.slice(0, 8000) });
}

// Image generation and edits live on Nara's separate images host. Keys stay
// server-side: the browser sends prompt + image data, never credentials.
// Generations take a plain JSON body; edits need multipart with the source
// image (and optional mask) as data URLs, rebuilt here into file parts.
function naraImagesBase() {
  return process.env.NARA_IMAGES_BASE_URL || 'https://api-images.bynara.id';
}

async function llmImage(req, res, kind) {
  const key = process.env.NARA_API_KEY;
  const what = kind === 'edits' ? 'Image editing' : 'Image generation';
  if (!key) return sendJson(res, 400, { error: what + ' needs a Nara key (NARA_API_KEY).' });
  readJsonBody(req, 12 * 1024 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' });
    try {
      const headers = { Authorization: `Bearer ${key}` };
      let upstream;
      if (kind === 'edits') {
        const model = body.model || process.env.NARA_IMAGE_MODEL;
        if (!model) {
          return sendJson(res, 400, { error: 'Image editing needs NARA_IMAGE_MODEL set to an image-capable alias.' });
        }
        if (!body.image) return sendJson(res, 400, { error: 'image is required' });
        const boundary = '----freeopenai' + Date.now().toString(36);
        const parts = [];
        const filePart = (name, filename, dataUrl) => {
          const m = /^data:(.+?);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
          if (!m) throw new Error(`Invalid image data for "${name}" — expected a data URL.`);
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${m[1]}\r\n\r\n`));
          parts.push(Buffer.from(m[2], 'base64'));
          parts.push(Buffer.from('\r\n'));
        };
        const field = (name, value) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        filePart('image', 'image.png', body.image);
        if (body.mask) filePart('mask', 'mask.png', body.mask);
        field('prompt', prompt);
        field('model', model);
        if (body.size) field('size', body.size);
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        upstream = await fetch(naraImagesBase() + '/v1/images/edits', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          body: Buffer.concat(parts),
        });
      } else {
        // The alias is required, the same way it is for an edit: the upstream
        // answers "Image model is required" to a body without one, and that
        // sentence arrives here as a 400 that looks like our bug. Falling back
        // to the operator's configured alias keeps the client from having to
        // know Nara's model names.
        const model = body.model || process.env.NARA_IMAGE_MODEL;
        if (!model) {
          return sendJson(res, 400, { error: 'Image generation needs NARA_IMAGE_MODEL set to an image-capable alias.' });
        }
        upstream = await fetch(naraImagesBase() + '/v1/images/generations', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            model,
            ...(body.size ? { size: body.size } : {}),
          }),
        });
      }
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok || !data) {
        return sendJson(res, upstream.status || 502, { error: describeProviderError(upstream.status || 502, data, { label: 'Nara' }) });
      }
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
  });
}

// Providers disagree on error shape: some nest a message under error, some
// return a bare string, some return nothing but a status. Dig out whatever is
// there and keep the status code, which is often the most informative part.
// A 404 means different things depending on what the service is. Speech and
// search products have no chat endpoint at all, so the whole provider is the
// wrong shape. A chat provider returning 404 is saying this particular model
// isn't reachable -- NVIDIA lists models its accounts don't all have access to,
// and answers "Not found for account" for the rest.
function notFoundHint(provider) {
  if (provider && provider.kind && provider.kind !== 'chat') {
    return ' — this service has no chat API at all; it sells ' + provider.kind;
  }
  return " — that model isn't available to your key, even though the provider lists it";
}

// What a socket-level failure actually was, in words.
//
// undici collapses every connection failure into `TypeError: fetch failed` and
// puts the useful part one level down, in `cause`. That left "Could not reach
// Antigravity: fetch failed" describing three different problems at once: a
// host name that does not resolve, a service that is not listening, and a
// connection that was refused or timed out -- each with its own fix. The code
// alone would be cryptic, so this carries the meaning with it, and the code
// stays alongside for anyone grepping.
const FETCH_CAUSE_MEANINGS = {
  ENOTFOUND: 'the host name did not resolve',
  EAI_AGAIN: 'the host name did not resolve',
  ECONNREFUSED: 'the host resolved but nothing is listening on that port',
  ECONNRESET: 'the connection was closed as soon as it opened',
  ETIMEDOUT: 'the connection timed out',
  EHOSTUNREACH: 'the host is not reachable',
  ENETUNREACH: 'the network is not reachable',
  EPIPE: 'the connection broke mid-request',
  CERT_HAS_EXPIRED: 'the TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed',
};

// With autoSelectFamily enabled, Node tries every address a name resolves to
// and reports an AggregateError, so the first cause is often not the whole
// story. Walk them, keeping the first code that says something -- plus anything
// else distinct, since "refused on one address, timed out on the other" is a
// real and useful thing to see. The walk is bounded twice: the visited set
// stops a shared or self-referential cause being walked again, and the depth
// cap stops a pathologically nested one recursing without end. Either bound
// alone would stop a cycle; they cost nothing and guard different shapes.
function fetchFailureReason(err) {
  const codes = [];
  const seen = new Set();
  const walk = (e, depth) => {
    if (!e || typeof e !== 'object' || depth > 4 || seen.has(e)) return;
    seen.add(e);
    if (typeof e.code === 'string' && !codes.includes(e.code)) codes.push(e.code);
    if (Array.isArray(e.errors)) e.errors.forEach((inner) => walk(inner, depth + 1));
    if (e.cause) walk(e.cause, depth + 1);
  };
  walk(err, 0);
  if (!codes.length) return '';
  const described = codes.map((code) => (FETCH_CAUSE_MEANINGS[code] ? `${code}: ${FETCH_CAUSE_MEANINGS[code]}` : code));
  return ` (${described.join('; ')})`;
}

// A message that carries a link, or is long enough to be a real sentence rather
// than a status echo, is already telling the user what to do.
function isSelfExplanatory(message) {
  if (!message) return false;
  if (/https?:\/\//.test(message)) return true;
  return message.length >= 60;
}

function describeProviderError(status, data, provider) {
  const who = provider && provider.label ? provider.label : 'The provider';
  const raw = data && (data.error || data.message || data.detail);
  let message = '';
  if (typeof raw === 'string') message = raw;
  else if (raw && typeof raw === 'object') message = raw.message || raw.code || JSON.stringify(raw);
  if (!message && data && typeof data === 'object') message = JSON.stringify(data).slice(0, 300);
  // A gateway error upstream usually arrives with no body, or an HTML one that
  // failed to parse. "request failed" told the user nothing, least of all
  // which of several configured providers had stalled.
  if (!message && status >= 500) message = `${who} returned a gateway error with no detail`;

  // A hint is for a bare status with nothing behind it. When the provider has
  // already explained itself -- "only available on agentic harnesses", with a
  // link -- appending "usually an empty balance" actively contradicts it and
  // sends the user to check the wrong thing.
  if (isSelfExplanatory(message)) return `${status}: ${message}`;

  const hint =
    status === 401 ? ' — check the API key for this provider'
      : status === 402 ? ' — this model is not free on your plan'
        : status === 403 ? ' — the key is valid but not permitted here; usually an empty balance or a model your plan does not include'
        : status === 404 ? notFoundHint(provider)
          : status === 429 ? ' — rate limited, wait a moment'
            : status === 504 || status === 502 ? ' — the provider is slow or unreachable; this is on their side, not your key'
              : status >= 500 ? ' — the provider had an internal error; try again or pick another'
                : '';
  return `${status}: ${message || `${who} rejected the request`}${hint}`;
}

// A provider that hangs shouldn't hang us. Without a deadline the request sits
// until some intermediary gives up and returns an opaque 504, which tells the
// user nothing about which side stalled. Listing models should be quick; a
// chat call legitimately takes longer, especially on a reasoning model.
// Kept under the hosting platform's own request ceiling on purpose. If the
// edge times out first it returns its own HTML 504, which parses to nothing
// and produces exactly the bare "504: request failed" this replaced.
// Every knob reads at call time so deploys tune without a code change:
// total per-request budgets, a headers deadline for streams (so 429 backoff
// between attempts never trips it, each attempt gets its own), and a stall
// deadline that fires when a stream goes quiet mid-reply.
function providerTimeoutMs() {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    models: num(process.env.PROVIDER_TIMEOUT_MODELS_MS, 20000),
    chat: num(process.env.PROVIDER_TIMEOUT_CHAT_MS, 55000),
    headers: num(process.env.PROVIDER_TIMEOUT_HEADERS_MS, 25000),
    stall: num(process.env.PROVIDER_STALL_MS, 60000),
  };
}

// Most use "Authorization: Bearer <key>", but not all: Deepgram wants
// "Token", AssemblyAI wants the bare key, You.com wants its own header,
// and keyless local servers (Ollama) send no auth header at all rather
// than a bare "Bearer ".
function providerAuthHeaders(provider, req) {
  const extra = typeof provider.headers === 'function' ? provider.headers(req) : {};
  const headerName = provider.authHeader || 'Authorization';
  const scheme = provider.authScheme === undefined ? 'Bearer' : provider.authScheme;
  const auth = provider.key ? { [headerName]: scheme ? `${scheme} ${provider.key}` : provider.key } : {};
  return { ...auth, 'Content-Type': 'application/json', ...extra };
}

async function providerFetch(req, provider, path, init = {}) {
  const budget = path.includes('chat') ? providerTimeoutMs().chat : providerTimeoutMs().models;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await fetch(provider.baseUrl + path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...providerAuthHeaders(provider, req),
        ...(init.headers || {}),
      },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    // A provider's Retry-After rides the packet so the shared retry shell can
    // respect their schedule instead of guessing our own backoff.
    const retryAfterMs = parseRetryAfterMs(res.headers);
    return { ok: res.ok, status: res.status, data, retryAfterMs };
  } catch (err) {
    // Report our own deadline as such. A generic network error here would look
    // identical to the provider refusing us, which sends the user hunting
    // through their key when nothing is wrong with it.
    if (err.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        // Marks the deadline as ours, so the shared retry shell does not re-spend
        // the same budget trying to ride out a wait we already imposed.
        selfTimeout: true,
        data: { error: { message: `${provider.label} did not respond within ${Math.round(budget / 1000)}s` } },
      };
    }
    // A keyless provider is one the operator runs themselves: Ollama and the
    // Antigravity proxy. There is no "their side" to blame and no key to check,
    // and the address is one the operator typed -- so this says so, in the
    // message rather than the generic hint below (an explained message is long
    // enough to be treated as speaking for itself, which is right for the
    // cause and wrong here). The distinction that costs people the most time:
    // a localhost address here means the *server*, not the browser.
    const advice = provider.needsKey === false
      ? ' — this is the endpoint you configured, so check that it is running and reachable from the server (a localhost address here means the server itself, not your machine)'
      : '';
    return {
      ok: false,
      status: 502,
      data: { error: { message: `Could not reach ${provider.label}: ${err.message}${fetchFailureReason(err)}${advice}` } },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOllamaModels(req, provider) {
  const openai = await providerFetch(req, provider, '/models');
  if (openai.ok && openai.data && Array.isArray(openai.data.data) && openai.data.data.length) {
    return openai;
  }

  // Ollama's native catalogue is available even on installations that do not
  // expose the OpenAI-compatible route. Reuse the same auth/timeout adapter,
  // but remove /v1 before requesting /api/tags.
  const nativeProvider = {
    ...provider,
    baseUrl: provider.baseUrl.replace(/\/v1\/?$/i, ''),
  };
  const native = await providerFetch(req, nativeProvider, '/api/tags');
  if (native.ok && native.data && Array.isArray(native.data.models)) {
    return {
      ...native,
      data: {
        object: 'list',
        data: native.data.models
          .map((model) => {
            const id = model && (model.name || model.model || model.id);
            return id ? { id, name: id, owned_by: 'ollama' } : null;
          })
          .filter(Boolean),
      },
    };
  }

  // Preserve the OpenAI error because it is usually the useful one when both
  // routes are unavailable (bad host, cold service, or auth failure).
  return openai;
}

// Model lists are read from the provider at runtime rather than hardcoded, so
// they can't go stale and a renamed model can't silently break a request.
async function llmModels(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('provider');
  const provider = providerConfig(id);
  if (!provider) return sendJson(res, 400, { error: 'Unknown or unconfigured provider' });
  // A corrupt key would let the picker list models that can only fail on
  // send. Say why instead: the error names the variable and the character.
  if (provider.keyError) return sendJson(res, 400, { error: provider.keyError });
  // A provider that publishes no catalogue serves its declared list as-is. It
  // is not a fallback for a failed fetch: nothing is fetched at all, so a
  // working proxy cannot be reported as broken by an endpoint it never had.
  if (provider.catalogue === false) {
    const ids = Array.isArray(provider.models) ? provider.models : [];
    return sendJson(res, 200, ids.filter((id) => typeof id === 'string' && id).map((id) => ({ id })));
  }
  const ttl = modelsCacheTtlMs();
  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return sendJson(res, 200, cached.models);
  }
  try {
    const result = id === 'ollama'
      ? await fetchOllamaModels(req, provider)
      : await providerFetch(req, provider, '/models');
    const { ok, status, data } = result;
    if (!ok) return sendJson(res, status, { error: describeProviderError(status, data, provider) });
    const models = (data && Array.isArray(data.data) ? data.data : [])
      .filter((m) => m && m.id)
      .map(normalizeProviderModel);
    // A curated allowlist pins the picker to exactly those ids, in that
    // order. Either form works: an array of ids, or a rule object
    // ({ exact, newestOf, freeOnly }) for a catalogue that needs collapsing
    // rather than listing -- see selectAllowedModels. Without one the whole
    // catalogue goes through untouched.
    let listed = Array.isArray(provider.models)
      ? provider.models.map((wanted) => models.find((m) => matchListEntry(m, wanted))).filter(Boolean)
      : provider.models && typeof provider.models === 'object'
        ? selectAllowedModels(models, provider.models)
        : models;
    if (provider.freeOnly) listed = listed.filter((m) => isFreeModelId(m.id));
    // An allowlist that intersects the live catalogue at zero rows means every
    // pinned id was retired upstream — the empty picker that follows reads as
    // a bug ("no model" + a fetch error on the user's side). Serve the live
    // catalogue instead and let the client's free-first ranking sort it out;
    // that degrades to "wrong order", never to "nothing to pick".
    if (Array.isArray(provider.models) && listed.length === 0) {
      if (provider.freeOnly) {
        const free = models.filter((m) => isFreeModelId(m.id));
        if (free.length) listed = free;
      }
      if (!listed.length) listed = models;
    }
    // Only a successful catalogue is worth caching; errors rust nothing.
    modelCache.set(id, { fetchedAt: Date.now(), models: listed });
    sendJson(res, 200, listed);
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

// Every provider is OpenAI-compatible for chat, but each invents its own
// metadata around it. OpenRouter nests modalities under architecture and
// prices per token as strings; ZenMux puts modalities at the top level and
// prices per million tokens as arrays of objects; Nara and NVIDIA send
// neither. Flatten all of it into one shape so the client has a single set of
// rules to rank by.
function firstPriceValue(entry) {
  if (entry === undefined || entry === null) return undefined;
  if (Array.isArray(entry)) return entry.length ? firstPriceValue(entry[0]) : undefined;
  if (typeof entry === 'object') return firstPriceValue(entry.value);
  const num = Number(entry);
  return Number.isFinite(num) ? num : undefined;
}

// A path segment at a time: slashes are structure, everything else is data.
function encodePath(filePath) {
  return String(filePath).split('/').map(encodeURIComponent).join('/');
}

function normalizePricing(model) {
  const source = model.pricing || model.pricings;
  if (!source || typeof source !== 'object') return undefined;
  const prompt = firstPriceValue(source.prompt !== undefined ? source.prompt : source.input);
  const completion = firstPriceValue(source.completion !== undefined ? source.completion : source.output);
  if (prompt === undefined && completion === undefined) return undefined;
  return { prompt: prompt === undefined ? 0 : prompt, completion: completion === undefined ? 0 : completion };
}

// --- Agent skills ---
//
// The catalogues of the installed skill repos (anthropics/skills,
// obra/superpowers, caveman-lite), fetched from raw.githubusercontent at
// runtime with a TTL cache and a last-good fallback: GitHub being down must
// degrade to "stale skills", never to a broken chat.
const SKILLS_TTL_MS = 6 * 60 * 60 * 1000; // 6h: skills change on human timescales
let skillsCache = { fetchedAt: 0, skills: [] };
let skillsFetch = null;

function skillsTtlMs() {
  const n = Number(process.env.SKILLS_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : SKILLS_TTL_MS;
}

function clearSkillsCache() {
  skillsCache = { fetchedAt: 0, skills: [] };
  skillsFetch = null;
}

async function fetchSkillText(source, skillPath) {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${skillPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Lists one repo's skill names from its git tree, honoring `pick` (an explicit
// name list = lite) or 'all'. Trees fail closed: an error means no names from
// this source, not a crash.
async function fetchSkillNames(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://api.github.com/repos/${source.repo}/git/trees/${source.branch}?recursive=1`, {
      headers: { 'User-Agent': 'freeopenai-app', Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.tree)) return [];
    const all = data.tree
      .filter((t) => t.type === 'blob' && t.path.endsWith('/SKILL.md') && t.path.startsWith(source.dir + '/'))
      .map((t) => t.path.split('/')[1])
      .filter(Boolean);
    const names = [...new Set(all)];
    return Array.isArray(source.pick) ? names.filter((n) => source.pick.includes(n)) : names;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function loadSkills(force = false) {
  const fresh = skillsCache.fetchedAt && Date.now() - skillsCache.fetchedAt < skillsTtlMs();
  if (fresh && !force) return skillsCache.skills;
  if (skillsFetch) return skillsFetch;
  skillsFetch = (async () => {
    const perSource = await Promise.all(SKILL_SOURCES.map(async (source) => {
      const names = await fetchSkillNames(source);
      // Bounded parallelism per repo; a huge repo shouldn't open 50 sockets.
      const rows = [];
      for (let i = 0; i < names.length; i += 8) {
        const slice = names.slice(i, i + 8);
        const texts = await Promise.all(slice.map((name) =>
          fetchSkillText(source, `${source.dir}/${name}/SKILL.md`)
        ));
        slice.forEach((name, j) => {
          const body = texts[j] || '';
          const meta = parseSkillFrontmatter(body);
          if (body && meta.description) {
            rows.push({ source: source.repo, name, description: meta.description, body });
          }
        });
      }
      return rows;
    }));
    const skills = perSource.flat();
    // Last-good wins over nothing: GitHub unreachable mid-TTL keeps the old
    // catalogue serving.
    if (skills.length) skillsCache = { fetchedAt: Date.now(), skills };
    else if (skillsCache.skills.length) skillsCache.fetchedAt = Date.now();
    return skillsCache.skills;
  })().finally(() => { skillsFetch = null; });
  return skillsFetch;
}

// GET /api/skills — the id catalogue for the picker.
function llmSkills(req, res) {
  loadSkills().then((skills) => {
    sendJson(res, 200, skills.map((s) => ({ source: s.source, name: s.name, description: s.description })));
  }).catch((err) => sendJson(res, 502, { error: err.message }));
}

// GET /api/skills/content?name= — one skill's full SKILL.md, for use_skill.
async function llmSkillContent(req, res) {
  const name = new URL(req.url, 'http://x').searchParams.get('name');
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return sendJson(res, 400, { error: 'name is required' });
  }
  const skills = await loadSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return sendJson(res, 404, { error: `No installed skill named "${name}"` });
  sendJson(res, 200, skill);
}

function normalizeProviderModel(m) {
  const architecture = m.architecture || {};
  const inputModalities = m.input_modalities || architecture.input_modalities;
  return {
    id: m.id,
    name: m.name || m.display_name,
    ownedBy: m.owned_by,
    pricing: normalizePricing(m),
    contextLength: m.context_length,
    supportedParameters: m.supported_parameters,
    outputModalities: m.output_modalities || architecture.output_modalities,
    // Only a catalogue that actually lists image input counts as capable.
    // Nara and NVIDIA publish no modalities at all, and claiming vision there
    // would send an image to a model that can only reject it -- so the field
    // stays absent rather than false, leaving "unknown" distinguishable.
    vision: Array.isArray(inputModalities) ? inputModalities.includes('image') : undefined,
  };
}

function llmChat(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('provider');
  const provider = providerConfig(id);
  if (!provider) return sendJson(res, 400, { error: 'Unknown or unconfigured provider' });
  if (provider.keyError) return sendJson(res, 400, { error: provider.keyError });
  readJsonBody(req, 1024 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    if (!body || !body.model || !Array.isArray(body.messages)) {
      return sendJson(res, 400, { error: 'model and messages are required' });
    }
    const upstreamBody = JSON.stringify({
      model: body.model,
      messages: body.messages,
      ...(body.tools ? { tools: body.tools } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(body.stream ? { stream: true } : {}),
    });
    const headers = providerAuthHeaders(provider, req);
    if (body.stream) {
      const t = providerTimeoutMs();
      const controller = new AbortController();
      // failKind separates our own timeouts (explained, 504) from a client
      // disconnect (quiet 499). Set just before aborting so the catch below
      // knows which wait expired.
      let failKind = '';
      // A client that vanished mid-stream must not get a partial-notice frame
      // written to a dead socket; the error path checks this.
      let clientGone = false;
      const fail = (kind) => { failKind = kind; controller.abort(); };
      const totalTimer = setTimeout(() => fail('total'), t.chat);
      const onClientClose = () => {
        clientGone = true;
        if (!res.writableEnded) controller.abort();
      };
      // Use the socket close event rather than req.on('close'), because
      // req (IncomingMessage/Readable) emits 'close' when the request body
      // is fully consumed — which happens before we start streaming.
      req.socket.on('close', onClientClose);
      let upstreamConsumed = false;
      // Distinct from upstreamConsumed (full success): any chunk that reached
      // the page counts, because those tokens were paid for whether or not the
      // stream finishes.
      let deliveredAny = false;
      let headersSent = false;
      try {
        const upstream = await fetchStreamWithRetry(id, async () => {
          const headerTimer = setTimeout(() => fail('headers'), t.headers);
          try {
            return await fetch(provider.baseUrl + '/chat/completions', {
              method: 'POST',
              signal: controller.signal,
              headers,
              body: upstreamBody,
            });
          } finally {
            clearTimeout(headerTimer);
          }
        });
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          // Some reverse proxies (Railway, nginx, Cloudflare) buffer SSE by
          // default. This header tells them to flush the data through.
          'X-Accel-Buffering': 'no',
        });
        headersSent = true;
        // Non-retryable or non-streamable failures still get a readable body.
        if (!upstream.ok) {
          const data = await upstream.json().catch(() => null);
          res.write(`data: ${JSON.stringify({ error: describeProviderError(upstream.status, data, provider) })}\n\n`);
        } else {
          // A stream that goes quiet is hung, not slow: poke a deadline on
          // every chunk so silence aborts instead of spinning forever.
          let stallTimer;
          const poke = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => fail('stall'), t.stall);
          };
          try {
            poke();
            for await (const chunk of upstream.body) {
              poke();
              res.write(chunk);
              deliveredAny = true;
            }
            upstreamConsumed = true;
          } finally {
            clearTimeout(stallTimer);
          }
        }
      } catch (e) {
        // Once streaming has started the status is already on the wire, so a
        // mid-body failure travels as an SSE error event, not a new status.
        let status = 502;
        let message = e.message;
        if (e.name === 'AbortError' && !failKind) {
          status = 499;
          message = 'Request aborted';
        } else if (failKind) {
          const secs = Math.round((failKind === 'headers' ? t.headers : failKind === 'stall' ? t.stall : t.chat) / 1000);
          status = 504;
          message = failKind === 'headers'
            ? `${provider.label} sent no response headers within ${secs}s`
            : failKind === 'stall'
              ? `${provider.label} stalled mid-reply (no data for ${secs}s)`
              : `${provider.label} did not finish within ${secs}s`;
        }
        if (!headersSent) res.writeHead(status, { 'Content-Type': 'text/event-stream' });
        // A failure with nothing sent yet is a plain error. But when tokens
        // already reached the page before the deadline hit, that partial text
        // is spend the user already paid for — the upstream may well have kept
        // generating after we gave up. Sending the error alone threw the
        // delivered words away and invited a resend that re-spends them; the
        // partial content rides first (the renderer has it on screen as it
        // arrives), then the error names what went wrong. The page's
        // finalizePartial() decides keep/discard below.
        if (deliveredAny && !clientGone) {
          res.write(`data: ${JSON.stringify({ partial: true, notice: message })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        }
      } finally {
        clearTimeout(totalTimer);
        req.socket.removeListener('close', onClientClose);
        if (!res.writableEnded) {
          // Providers already send a [DONE] sentinel at the end of a
          // successful stream; only add one when the body was consumed
          // partially or an error was sent instead.
          if (!upstreamConsumed) res.write('data: [DONE]\n\n');
          res.end();
        }
      }
      return;
    }
    try {
      const { ok, status, data } = await fetchProviderWithRetry(id, () =>
        providerFetch(req, provider, '/chat/completions', {
          method: 'POST',
          // Passed through rather than rebuilt: these are OpenAI-shaped already,
          // and rebuilding would quietly drop anything new the caller sends.
          body: upstreamBody,
        })
      );
      if (!ok) {
        // Collapsing every upstream failure into one string made it impossible
        // to tell a missing model from an empty balance from a bad key. Report
        // what the provider actually said.
        return sendJson(res, status, { error: describeProviderError(status, data, provider) });
      }
      // A 200 whose body could not be read as an object is not a success, and
      // forwarding it put a bare `null` on the wire: the client parsed that and
      // then read a field off it -- "Cannot read properties of null (reading
      // 'parseFailed')". An empty body lands here too.
      if (!data || typeof data !== 'object') {
        const who = provider && provider.label ? provider.label : 'The provider';
        return sendJson(res, 502, {
          error: `${who} accepted the request but sent nothing readable back. Try again, or pick another model.`,
        });
      }
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
  });
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveSafePath(root, urlPath) {
  let clean = urlPath.split('?')[0].split('#')[0];
  if (clean === '/') clean = '/index.html';
  const resolved = path.join(root, path.normalize(clean).replace(/^([/\\])+/, ''));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function isAssetPath(urlPath) {
  return path.extname(urlPath.split('?')[0]) !== '';
}

function createRequestHandler(root) {
  return (req, res) => {
    const urlPath = req.url.split('?')[0];

    if (req.method === 'POST' && urlPath === '/api/login') {
      handleLogin(req, res);
      return;
    }

    if (urlPath === '/login.html' && isAuthenticated(req)) {
      const redirectTo = new URL(req.url, 'http://x').searchParams.get('redirect');
      res.writeHead(302, { Location: redirectTo && redirectTo.startsWith('/') ? redirectTo : '/' });
      res.end();
      return;
    }

    if (!PUBLIC_PATHS.has(urlPath) && !isAuthenticated(req)) {
      if (urlPath.startsWith('/api/')) {
        sendJson(res, 401, { error: 'Not signed in' });
        return;
      }
      if (isAssetPath(urlPath)) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      res.writeHead(302, { Location: '/login.html?redirect=' + encodeURIComponent(urlPath) });
      res.end();
      return;
    }

    if (urlPath === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
    if (urlPath === '/api/github/authorize' && req.method === 'GET') return githubAuthorize(req, res);
    if (urlPath === '/api/github/callback' && req.method === 'GET') return githubCallback(req, res);
    if (urlPath === '/api/github/status' && req.method === 'GET') return githubStatus(req, res);
    if (urlPath === '/api/github/disconnect' && req.method === 'POST') return githubDisconnect(req, res);
    if (urlPath === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return llmHealth(req, res);
    if (urlPath === '/api/llm/providers' && req.method === 'GET') return llmProviders(req, res);
    if (urlPath === '/api/skills' && req.method === 'GET') return llmSkills(req, res);
    if (urlPath === '/api/skills/content' && req.method === 'GET') return llmSkillContent(req, res);
    if (urlPath === '/api/llm/models' && req.method === 'GET') return llmModels(req, res);
    if (urlPath === '/api/llm/limits' && req.method === 'GET') return llmLimits(req, res);
    if (urlPath === '/api/llm/chat' && req.method === 'POST') return llmChat(req, res);
    if (urlPath === '/api/llm/images/generations' && req.method === 'POST') return llmImage(req, res, 'generations');
    if (urlPath === '/api/llm/images/edits' && req.method === 'POST') return llmImage(req, res, 'edits');
    if (urlPath === '/api/llm/websearch' && req.method === 'GET') return llmWebsearch(req, res);
    if (urlPath === '/api/llm/fetch' && req.method === 'GET') return llmFetch(req, res);
    if (urlPath === '/api/github/repos' && req.method === 'GET') return githubRepos(req, res);
    if (urlPath === '/api/github/tree' && req.method === 'GET') return githubListDir(req, res);
    if (urlPath === '/api/github/file' && req.method === 'GET') return githubGetFile(req, res);
    if (urlPath === '/api/github/file' && req.method === 'PUT') return githubPutFile(req, res);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    const file = resolveSafePath(root, req.url);
    if (!file) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        if (isAssetPath(req.url)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        fs.readFile(path.join(root, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(req.method === 'HEAD' ? undefined : html);
        });
        return;
      }
      // Static files never cache: the whole UI ships in index.html, so a
      // cached copy silently runs yesterday's code after a deploy.
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}

if (require.main === module) {
  http.createServer(createRequestHandler(rootDir)).listen(port, () => console.log(`Serving on port ${port}`));
}

module.exports = {
  resolveSafePath,
  isAssetPath,
  LLM_PROVIDERS,
  createRequestHandler,
  normalizeProviderModel,
  normalizePricing,
  normalizeProviderBaseUrl,
  providerConfig,
  parseRetryAfterMs,
  retryBackoffMs,
  fetchOllamaModels,
  describeProviderError,
  fetchFailureReason,
  fetchProviderWithRetry,
  fetchStreamWithRetry,
  clearModelCache,
  clearSkillsCache,
  loadSkills,
  modelsCacheTtlMs,
  providerTimeoutMs,
  rateLimitMaxAttempts,
  retryBaseDelayMs,
  extractPageText,
  normalizeDdG,
  normalizeWiki,
  normalizeWikiFull,
  isPrivateIp,
};
