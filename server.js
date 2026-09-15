const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
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
const { matchListEntry, isFreeModelId, selectAllowedModels, isRetryableStatus, isQuotaExhausted, unsafeHeaderChar, SKILL_SOURCES, parseSkillFrontmatter, skillEntriesFromTree } = require('./chatlib.js');
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

// Which line of a search fragment the first match sits on. GitHub returns the
// text around a hit, not its position, so the position is counted here -- a
// result a caller cannot locate is a result they have to read the whole file to
// use, which is the cost the search existed to avoid.
function lineOfFirstMatch(fragment, match) {
  const text = String(fragment || '');
  const at = typeof match === 'string' ? text.indexOf(match) : Number(match);
  if (!Number.isFinite(at) || at < 0) return 0;
  return text.slice(0, at).split('\n').length;
}

// Text search inside one repository. GitHub's code search is the cheapest way to
// find where a symbol lives, and the only one that does not cost a directory
// listing plus a guess per level.
async function githubSearchCode(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const repo = query.get('repo');
  const term = query.get('q');
  if (!repo || !term) return sendJson(res, 400, { error: 'repo and q are required' });
  const account = resolveAccount(req, res, repo);
  if (!account) return;
  try {
    const { ok, status, data } = await githubApiFetch(
      account.token,
      'https://api.github.com/search/code?per_page=30&q=' + encodeURIComponent(term + ' repo:' + repo),
      // text-match+json is what adds the matching fragments to each result; the
      // plain shape answers with paths only, which is half an answer.
      { headers: { Accept: 'application/vnd.github.text-match+json' } }
    );
    // A repository GitHub has not indexed answers 422 with its own explanation
    // ("you can only search the default branch"), which is more useful than a
    // generic failure because the fix is to search the default branch instead.
    if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not search the code' });
    const items = Array.isArray(data && data.items) ? data.items : [];
    sendJson(res, 200, items.map((item) => {
      const fragment = Array.isArray(item.text_matches) ? item.text_matches[0] : null;
      const first = fragment && Array.isArray(fragment.matches) ? fragment.matches[0] : null;
      return {
        path: item.path,
        line: fragment ? lineOfFirstMatch(fragment.fragment, first) : 0,
        text: fragment ? String(fragment.fragment || '').trim().replace(/\s+/g, ' ').slice(0, 240) : '',
      };
    }));
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

// Recent history, optionally for one file. A commit list is how "why is this
// like this" gets answered without reading the whole repository.
async function githubListCommits(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const repo = query.get('repo');
  const filePath = query.get('path') || '';
  if (!repo) return sendJson(res, 400, { error: 'repo is required' });
  const account = resolveAccount(req, res, repo);
  if (!account) return;
  try {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=20` +
      (filePath ? '&path=' + encodeURIComponent(filePath) : '');
    const { ok, status, data } = await githubApiFetch(account.token, url);
    if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not list commits' });
    const rows = Array.isArray(data) ? data : [];
    sendJson(res, 200, rows.map((row) => ({
      sha: String(row.sha || ''),
      message: String((row.commit && row.commit.message) || '').split('\n')[0].slice(0, 200),
      author: (row.commit && row.commit.author && row.commit.author.name) || '',
      date: (row.commit && row.commit.author && row.commit.author.date) || '',
    })));
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

// Delete one file, as a commit. The contents API wants the blob's current sha,
// the same way an update does, and for the same reason it is looked up here
// rather than carried by the caller: a model that deletes without reading first
// has no sha to give, and the failure it got was about a detail it should never
// have been handling.
function githubDeleteFile(req, res) {
  readJsonBody(req, 64 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const { repo, path: filePath, message, account: requested } = body || {};
    if (!repo || !filePath) return sendJson(res, 400, { error: 'repo and path are required' });
    const picked = pickAccount(getGithubSession(req), repo, requested);
    if (picked.error) {
      return sendJson(res, picked.error === 'GitHub not connected' ? 401 : 400, { error: picked.error });
    }
    const account = picked.account;
    try {
      const existing = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}`
      );
      if (!existing.ok || !existing.data || Array.isArray(existing.data) || !existing.data.sha) {
        // GitHub answers a missing file with "Not Found", which tells a caller
        // nothing about which of its arguments was wrong. The path is the one
        // thing worth repeating, and it is the one thing GitHub left out.
        const status = existing.status === 200 ? 400 : existing.status || 502;
        return sendJson(res, status, {
          error: `No file at "${filePath}" in ${repo} to delete`,
        });
      }
      const { ok, status, data } = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message || `Delete ${filePath}`, sha: existing.data.sha }),
        }
      );
      if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not delete file' });
      sendJson(res, 200, {
        path: filePath,
        commitUrl: data.commit && data.commit.html_url,
        account: account.login,
      });
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
  });
}

function isSecretFile(path) {
  const secretNames = ['.env', '.env.local', '.env.*', '.claude-local', '.claude.json', '.freebuff', 'antigravity-accounts.json', 'token.json', 'config.yaml', 'opencode.json', '.github/workflows/', 'deploy/antigravity-proxy/data/'];
  const p = String(path || '').toLowerCase();
  return secretNames.some((n) => p.includes(n.toLowerCase()));
}

function enforceNoSecretWrites(req) {
  // P2 enforcement hook: workspace_write_file to protected paths is
  // refused. We check the message arguments directly because the body has
  // no filePath field at this layer; if a path argument is present and
  // names a secret, the turn is blocked with a clear reason.
  const dangerousWrites = {
    workspace_write_file: true,
    workspace_edit_file: true,
    workspace_delete_file: true,
    github_commit_file: true,
    github_delete_file: true,
  };
  if (req.body && Array.isArray(req.body.tools)) {
    const dangerous = req.body.tools.filter((t) => dangerousWrites[t.function?.name]);
    const firstDangerous = dangerous[0];
    if (firstDangerous && firstDangerous.function && firstDangerous.function.arguments) {
      try {
        const argsStr = String(firstDangerous.function.arguments || '');
        const args = JSON.parse(argsStr);
        const path = args.path || args.file || args.file_path || args.filePath || '';
        if (path && isSecretFile(String(path))) {
          return { blocked: true, reason: 'Write to a protected file (.env, secrets, proxy/auth data, .claude/.freebuff, .github/workflows) refused by enforcement hook. Read/version/rename instead, or ask explicitly.' };
        }
      } catch { /* arguments not JSON; no file path detectable; pass through */ }
    }
  }
  return null; // not a blocked case
}

// Direct provider access, as an alternative to Puter. Each of these is
// OpenAI-compatible, so one adapter covers all of them: only the base URL, the
// key and a couple of headers differ.
//
// Keys live here, never in the browser. The whole API surface already sits
// behind the login gate, so a key can't be read by anyone who isn't signed in.
const LLM_PROVIDERS = {
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
    // Where a picture can come from, on the same key. Declared here rather than
    // inside the image route because the capabilities are the provider's, not
    // the route's: this is the table an operator reads to find out what they
    // have to set for what.
    image: {
      shape: 'openai-images',
      baseUrl: 'https://api-images.bynara.id',
      baseUrlEnv: 'NARA_IMAGES_BASE_URL',
      modelEnv: 'NARA_IMAGE_MODEL',
      // The size every request is drawn at when the caller asks for none. Kept,
      // and read per store rather than globally, so an operator's setting for
      // Nara cannot decide what OpenRouter or HuggingFace is asked for.
      sizeEnv: 'NARA_IMAGE_SIZE',
      // A source picture arrives as multipart file parts on the edits endpoint.
      edit: 'multipart',
      // Dimensions are an upstream contract: only these pass, and anything else
      // is refused by us with the list rather than being rewritten silently.
      sizes: [
        { label: 'Square (1:1)', value: '1024x1024' },
        { label: 'Facebook cover (wide, 1640×856)', value: '1640x856' },
        { label: 'Portrait (4:5)', value: '1024x1280' },
        { label: 'Landscape banner (2:1)', value: '2048x1024' },
      ],
    },
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
    // The dedicated Image API (launched 2026-06-23): 30+ models behind one
    // OpenAI-shaped endpoint, and the same key that chats here draws here.
    //
    // Two paths are tried on purpose. OpenRouter's own docs name
    // /api/v1/images in one page and /api/v1/images/generations in another, so
    // a 404 moves to the other rather than failing a draw over a path the
    // service itself describes two ways.
    image: {
      shape: 'openai-images',
      baseUrl: 'https://openrouter.ai/api/v1',
      baseUrlEnv: 'OPENROUTER_IMAGES_BASE_URL',
      path: '/images/generations',
      altPath: '/images',
      // Image-to-image rides the generations endpoint as a reference, which is
      // what makes "change the sky" work here the way it works on Nara.
      edit: 'references',
      modelEnv: 'OPENROUTER_IMAGE_MODEL',
      // Cheap and good at following an instruction to change one thing; the
      // gpt-image line is the alternative several operators will prefer.
      defaultModel: 'google/gemini-2.5-flash-image',
    },
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
    // NVIDIA sells image generation, so an NVIDIA key here should draw.
    //
    // Two shapes, in this order. The hosted FLUX models answer the NVCF GenAI
    // shape at ai.api.nvidia.com ({prompt} in, {artifacts:[{base64}]} out), and
    // a self-hosted visual-genai NIM documents an OpenAI-compatible images API
    // instead. Which one a given NVIDIA_IMAGES_BASE_URL speaks is the
    // operator's deployment, not something this app can know, so both are
    // tried and the second is reached on a 404.
    image: {
      shape: 'nvidia-genai',
      altShape: 'openai-images',
      baseUrl: 'https://ai.api.nvidia.com/v1',
      baseUrlEnv: 'NVIDIA_IMAGES_BASE_URL',
      modelEnv: 'NVIDIA_IMAGE_MODEL',
      defaultModel: 'black-forest-labs/flux.1-schnell',
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
    // Text-to-image is not on the OpenAI-compatible router: it is the task
    // route, {inputs, parameters} in and raw image bytes out. The model is a
    // repo id, so HF_IMAGE_MODEL picks which one (FLUX.1-schnell by default:
    // fast, and one of the models HF's own docs lead with).
    image: {
      shape: 'hf-inference',
      baseUrl: 'https://router.huggingface.co/hf-inference',
      baseUrlEnv: 'HF_IMAGES_BASE_URL',
      modelEnv: 'HF_IMAGE_MODEL',
      defaultModel: 'black-forest-labs/FLUX.1-schnell',
    },
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
    // A local server may well have an image model pulled, and this app has no
    // catalogue that says which -- so this is opt-in by name. Without it,
    // Ollama is simply not a candidate for drawing, which is what keeps a
    // local chat server from being picked over a provider that really can.
    image: {
      shape: 'openai-images',
      modelEnv: 'OLLAMA_IMAGE_MODEL',
    },
  },
  // Google Antigravity through CLIProxyAPI (deploy/cliproxyapi), which owns the
  // Google accounts -- they are signed in once locally and carried to the
  // service as a variable, and it stays on the operator's side. The proxy
  // speaks plain OpenAI, so this is an ordinary provider with two
  // differences: the key is the service's API key rather than a provider key,
  // and it appears only once its base URL (or a key) is set.
  //
  // It publishes a catalogue, but the catalogue is the proxy's whole world
  // (every model any configured provider could serve) rather than this
  // provider's allowlist, so `catalogue: false` serves the pinned list below
  // instead: these ids are the ones probed live against the service, and
  // ANTIGRAVITY_MODELS replaces the list without a code change.
  //
  // Every id below was verified against the live v2 service on 2026-09-14
  // (tiny "hi" over /v1/chat/completions, plus SSE streaming and a tool_calls
  // round-trip). Anything not on this list failed on every account, so
  // pinning it would only offer a picker row that cannot answer:
  // - gemini-3.1-pro-high: Google answers 400 INVALID_ARGUMENT everywhere --
  //   the target name is retired, not a network problem. gemini-pro-agent
  //   serves the same tier under its current name.
  // - gemini-2.5-flash: absent from the v2 catalogue, and on the old proxy
  //   the only form that answered is retired with it.
  // - gemini-3-pro-high, gemini-2.5-pro, sonnet-4-5 and the opus thinking
  //   tiers: retired upstream or never served by this proxy.
   // Rovo Dev, which is Claude Sonnet 4 on an Atlassian account's own allowance:
  // 5 million tokens a day on the free tier, 20 million with a paid Jira plan,
  // and no card either way. That is the one thing here that a free key cannot
  // otherwise buy -- Qwen3-Coder-480B is free nowhere reachable since Cerebras
  // ended its no-card tier, and OpenRouter has never listed a :free variant.
  //
  // It is not an API. Rovo Dev is a terminal agent, and the way in is
  // `acli rovodev serve <port>`, an officially documented server mode, with a
  // small shim in front translating OpenAI's shape to Rovo's /v3. Both run in
  // the container built by deploy/rovo-proxy, so what this provider talks to is
  // an ordinary OpenAI-compatible endpoint like any other here.
  //
  // needsKey is false because the key does not authenticate to Rovo -- the
  // container's own acli session does that. The key authenticates to the
  // container, which matters a great deal: the shim strips Authorization, so a
  // tunnelled URL with nothing in front of it lets anyone on the internet spend
  // the account's allowance. The gate in that container is what the key is for.
  //
  // No `models` list. The shim reports what the account can actually reach, and
  // a list pinned here would go stale against a service whose catalogue is not
  // ours; ROVO_MODELS overrides when the live answer is wrong. No `image` block
  // either, because the shim is text-only and says so.
  rovo: {
    label: 'Rovo',
    baseUrl: 'http://localhost:4000/v1',
    envVar: 'ROVO_API_KEY',
    needsKey: false,
  },

 antigravity: {
    label: 'Antigravity',
    baseUrl: 'http://localhost:3000/v1',
    envVar: 'ANTIGRAVITY_API_KEY',
    needsKey: false,
    catalogue: false,
    models: [
      // The reason this provider is worth wiring up at all: Opus and Sonnet
      // through a quota the user already has, plus Gemini alongside them.
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-6',
      'gemini-3-flash',
      'gemini-3.1-pro-low',
      'gemini-pro-agent',
    ],
  },
  // OmniRoute (github.com/diegosouzapw/OmniRoute) is a self-hosted AI gateway:
  // one OpenAI-compatible endpoint in front of hundreds of upstream providers
  // (OpenAI, Anthropic, Google, GLM, DeepSeek, Mistral, Kimi, plus dozens of
  // free tiers), with automatic routing and fallback between them. It keeps
  // its own catalogue and key/account database in SQLite, so this app needs
  // nothing more than the gateway's address -- and optionally a key, for when
  // the operator has hardened the gateway with REQUIRE_API_KEY=true.
  //
  // The model ids below are the point of it. `auto` and its variants are
  // virtual combos that route each request to whichever connected provider
  // best fits at that moment; direct `provider/model` ids are pinned for when
  // the picker wants a concrete name. All of them are intersected with the
  // gateway's live /v1/models catalogue, so an id a release retires drops out
  // silently instead of failing on use. OMNIROUTE_MODELS replaces the whole
  // list, like the other providers.
  omniroute: {
    label: 'OmniRoute',
    baseUrl: 'http://127.0.0.1:20128/v1',
    envVar: 'OMNIROUTE_API_KEY',
    // A fresh install answers without a key (REQUIRE_API_KEY=false). When the
    // operator turns that on, the key here is sent as Bearer; when it stays
    // off, no auth header goes at all, never a bare "Bearer ".
    needsKey: false,
    // The gateway lists every model twice by default (a `cc/...` alias and a
    // `provider/...` canonical id for the same model). One id per model is
    // enough for a picker, and the allowlist below is written in those alias
    // ids, so ask for the deduplicated catalogue.
    modelsPath: '/models?prefix=alias',
    models: [
      // The router itself: let OmniRoute pick the best provider per request.
      'auto',
      'auto/coding',
      'auto/fast',
      'auto/cheap',
      'auto/smart',
      'auto/offline',
      // Direct flagships, as documented in the OmniRoute README / affiliates.
      'openai/gpt-5.4',
      'glm/glm-5.2',
      'cc/claude-opus-4-6',
      'cc/claude-sonnet-4-6',
      'agentrouter/claude-opus-4-8',
      'agentrouter/claude-opus-5',
      'agentrouter/gpt-5.6-sol',
    ],
    // The gateway fronts plenty of upstreams that sell images, and it speaks
    // OpenAI, so whatever image model it has connected is reachable through it
    // -- named by the operator, because the gateway's catalogue is its own.
    image: {
      shape: 'openai-images',
      modelEnv: 'OMNIROUTE_IMAGE_MODEL',
    },
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
const V1_APPENDED_PROVIDERS = new Set(['ollama', 'antigravity', 'huggingface', 'omniroute', 'rovo']);

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
  //
  // A declaration that resolves to nothing falls back to the provider's own
  // list. Setting the variable to a blank value is far more often a mistake
  // (an empty Railway field, a stray space, a commented-out line) than an
  // instruction to publish no models at all -- and the version of it that
  // reaches the picker is an empty list, which reads as the provider being
  // broken. Something is better than nothing here, always.
  // An id has to be able to address a model, so anything that is not printable
  // ASCII with no spaces is dropped rather than served: a paste from a word
  // processor can leave a zero-width space or a smart quote in the list, and a
  // row in the picker that cannot possibly work is worse than no row. Dropping
  // every entry falls back to the pinned list, like a blank declaration does.
  const declared = process.env[providerEnvName(provider.envVar, '_MODELS')];
  const declaredIds = declared
    ? declared.split(',').map((id) => id.trim()).filter((id) => id && !/[^\x21-\x7e]/.test(id))
    : [];
  const models = declaredIds.length ? declaredIds : provider.models;
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

// ---------------------------------------------------------------------------
// Image generation, for every provider that sells it.
//
// This route used to be Nara-only, which meant an operator with an OpenRouter,
// NVIDIA or HuggingFace key could chat on it and not draw: the one image route
// answered "Image generation needs NARA_IMAGE_MODEL", naming a service they had
// not configured. Puter draws in the browser and is always asked first; this is
// the server side of the chain, and it now reaches whichever configured provider
// can actually make a picture.
//
// That matters most for a deployment with no Puter sign-in at all (a
// login-gated deploy): there Puter's SDK is unreachable, so the server route is
// the only way to draw, and it was the only way to draw *with Nara*.
//
// Keys stay server-side: the browser sends prompt + image data, never
// credentials. Each provider declares how it draws in its own entry (see the
// `image` block on LLM_PROVIDERS), and what differs between them is one of three
// request shapes:
//
//   openai-images  {model, prompt, ...} -> {data:[{b64_json|url}]}
//   hf-inference   {inputs, parameters} -> raw image bytes
//   nvidia-genai   {prompt, ...} -> {artifacts:[{base64}]}
//
// Every answer is normalized to the OpenAI images shape (data[].b64_json), which
// is what the browser already reads -- one reader for three services is one
// place a picture can go missing.
//
// Nara serves images from a host of its own rather than the router that carries
// its chat, which is why a store may declare a base URL of its own and the
// variable that overrides it -- see imageBaseFor below.
//
// The order image requests fall back through, best first. Nara leads because it
// is what this route has always fronted: an operator who has it configured sees
// exactly the behaviour they had, and one who does not gets their next key.
// Ollama and OmniRoute are last because their image models are named by the
// operator rather than published, so they can only be offered when asked for.
const IMAGE_PROVIDER_ORDER = ['nara', 'openrouter', 'nvidia', 'huggingface', 'omniroute', 'ollama'];

// Which model name to ask for: the request's own, then the operator's variable,
// then the store's default. A store with no default (Ollama, OmniRoute) is
// therefore only usable once the operator names one -- which is the point, since
// nothing here can know what a local server or a gateway has loaded.
function imageModelFor(store, explicit) {
  const named = String(explicit || '').trim();
  if (named) return named;
  const fromEnv = store.modelEnv ? String(process.env[store.modelEnv] || '').trim() : '';
  if (fromEnv) return fromEnv;
  return String(store.defaultModel || '').trim();
}

// One provider, ready to draw -- or the sentence that says why it cannot.
function imageCandidateFor(id, options) {
  const declared = LLM_PROVIDERS[id];
  const store = declared && declared.image ? declared.image : null;
  if (!store) return { error: 'No image service is wired up as "' + id + '".' };
  // providerConfig is what resolves a key and a base URL for the chat path, and
  // an image is billed to the same key: reading the environment a second way
  // here is how a provider that chats fine reports "not configured" for drawing.
  const provider = providerConfig(id);
  if (!provider) return { error: declared.label + ' is not configured — set ' + declared.envVar + '.' };
  if (provider.keyError) return { error: provider.keyError };
  // The request's own model name is honoured only next to the provider it was
  // meant for. On its own it is whatever the browser last used somewhere else,
  // and an id from another catalogue is a 404 dressed up as a bad request.
  const model = imageModelFor(store, options && options.explicitModel);
  if (!model) {
    return { error: declared.label + ' has no image model named — set ' + (store.modelEnv || declared.envVar) + '.' };
  }
  return { id, store, model, provider };
}

// Every provider that could draw for this request, best first.
//
// A named provider is the whole list. Naming one is a decision, and quietly
// spending a second operator's key because the first said no is not a retry --
// it is a different choice made on their behalf. Two things name one: the
// request's own `provider`, and the operator's IMAGE_PROVIDER, which is a
// deployment saying "this is the service I pay for".
//
// A *preferred* provider is not that. The page sends the service the conversation
// is on -- "generate an image" should follow the choice the user already made
// rather than asking again -- and a preference is exactly the strength that
// deserves: that provider goes first, with the chat's own model, and the rest of
// the order stays behind it for the case where it cannot draw. Pinning would turn
// a service that does not do images into a dead end.
//
// Nothing named and nothing preferred means fall through, and that is what makes
// this route cover every provider instead of the first one that happens to be
// configured: an OpenRouter key draws without NARA_API_KEY, a HuggingFace key
// draws without either, and so on down the order. Ollama and OmniRoute come last
// because their model names are the operator's to supply, so they can only ever
// be reached when one was.
function imageDrawOrder(requested, options) {
  const settings = options || {};
  const explicitModel = String(settings.explicitModel || '').trim();
  const named = String(requested || process.env.IMAGE_PROVIDER || '').trim();
  if (named) {
    const provider = LLM_PROVIDERS[named];
    if (!provider || !provider.image) {
      return { error: 'Unknown image provider "' + named + '". Wired up: ' + IMAGE_PROVIDER_ORDER.join(', ') + '.' };
    }
    return { candidates: [imageCandidateFor(named, { explicitModel })] };
  }
  const preferred = String(settings.preferredProvider || '').trim();
  const order = preferred && IMAGE_PROVIDER_ORDER.includes(preferred)
    ? [preferred, ...IMAGE_PROVIDER_ORDER.filter((id) => id !== preferred)]
    : IMAGE_PROVIDER_ORDER;
  const candidates = [];
  for (const id of order) {
    // The conversation's model is offered to the provider the conversation is on,
    // and to that one alone: ids come from per-provider catalogues, so an
    // OpenRouter name handed to Nara is a 404 dressed up as a bad request. A
    // provider further down the order draws with its own model.
    const candidate = imageCandidateFor(id, { explicitModel: id === preferred ? explicitModel : '' });
    if (!candidate.error) candidates.push(candidate);
  }
  if (!candidates.length) return { error: imageUnavailableMessage() };
  return { candidates };
}

// Which providers could draw right now, in the order they would be tried, and
// what each is missing when it could not.
//
// The page used to read this to build a picker of image services, which was the
// second question the composer should never have asked: an image request now
// follows the conversation, so this is the operator's view of the order rather
// than the browser's. It is also what a failure message is written from, so the
// variables it names are the ones that would actually fix the setup.
function imageProvidersReport() {
  const rows = [];
  for (const id of IMAGE_PROVIDER_ORDER) {
    const provider = LLM_PROVIDERS[id];
    const store = provider && provider.image ? provider.image : null;
    if (!store) continue;
    const candidate = imageCandidateFor(id, {});
    rows.push({
      id,
      label: provider.label,
      ready: !candidate.error,
      model: candidate.model || '',
      reason: candidate.error || '',
      // Only the store that states its dimensions has any: everywhere else a
      // size is a preference the upstream may or may not know.
      sizes: (store.sizes || []).map((s) => s.value),
      edits: store.edit === 'multipart' ? 'mask' : store.edit === 'references' ? 'reference' : 'none',
    });
  }
  return rows;
}

// What to say when nothing can draw, in the form an operator can act on: every
// provider that could, and the one variable each is missing. Naming only the
// first would send them round the loop one key at a time.
function imageUnavailableMessage() {
  const rows = [];
  for (const id of IMAGE_PROVIDER_ORDER) {
    const provider = LLM_PROVIDERS[id];
    if (!provider || !provider.image) continue;
    if (!providerIsConfigured(provider)) rows.push(id + ' (add ' + provider.envVar + ')');
    else rows.push(id + ' (set ' + provider.image.modelEnv + ')');
  }
  return (
    'No image provider is ready. ' +
    rows.join('; ') +
    '. And Puter draws in the browser with no configuration at all when the visitor is signed in.'
  );
}

// Where the picture endpoint lives. A store that names a host means it: Nara
// serves images from a different host than its chat, HuggingFace's text-to-image
// is a different path than its router, and neither wants the /v1 the chat URL is
// normalised with. Only a store that names nothing falls back to the chat URL,
// and there it is normalised the same way the chat path normalises it.
function imageBaseFor(id, provider, store) {
  const override = store.baseUrlEnv ? String(process.env[store.baseUrlEnv] || '').trim() : '';
  const declared = override || store.baseUrl;
  if (declared) return declared.replace(/\/+$/, '');
  return normalizeProviderBaseUrl(id, provider.baseUrl);
}

// The pictures in whatever an images endpoint answered with. Both fields are
// legitimate -- b64_json is what an OpenAI-shaped API returns when it is asked
// not to publish the file, url is what several fronts return instead -- and a
// reader that knows only one of them reports "no image" for a picture that
// arrived. Entries without either are dropped rather than counted.
function imageUrlsIn(payload) {
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  const urls = [];
  for (const row of rows) {
    if (!row) continue;
    if (typeof row.b64_json === 'string' && row.b64_json) {
      urls.push('data:' + (row.media_type || 'image/png') + ';base64,' + row.b64_json);
    } else if (typeof row.url === 'string' && row.url) {
      urls.push(row.url);
    }
  }
  return urls;
}

// A refusal is the prompt's fault, and that is the one failure worth not asking
// the next provider about: it is being handed the same prompt, so it can only
// answer the same way, and the user is the only one who can reword it.
//
// Two things arrive under this name: a moderation flag (Puter reports
// errorCode 'moderation_flagged' rather than prose) and the plain sentences the
// other fronts use for the same decision.
function imageLooksRefused(status, text) {
  const message = String(text || '');
  if (/moderation_flagged|image_generation_user_error/i.test(message)) return true;
  if (/content policy|safety (system|filter)|moderation|prohibited|violates? (our|the) (polic|usage)|not allowed to (generate|create)/i.test(message)) return true;
  return status === 451;
}

// What to say when nobody could draw. Naming each service and what it said is
// the difference between a user who can fix a key and one who can only retry:
// "every provider failed" is the same sentence for six different problems.
function imageDrawFailureMessage(what, failures) {
  if (!failures.length) return what + ' failed: no image provider was ready to try.';
  if (failures.length === 1) return what + ' failed on ' + failures[0].label + ': ' + failures[0].reason;
  return (
    what + ' failed on every provider that could draw: ' +
    failures.map((f) => f.label + ' (' + f.reason + ')').join('; ') + '.'
  );
}

// 'WIDTHxHEIGHT' -> { w, h }. A size this cannot read is not sent anywhere:
// guessing a dimension for a service that asked for something else is how a
// request gets refused for a reason nobody typed.
function sizeParts(size) {
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(String(size || '').trim());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

// The ratios the services that take one actually use, so 1640x856 is sent as
// 16:9 rather than as a pixel pair no ratio field will accept.
const IMAGE_ASPECT_RATIOS = [
  { label: '1:1', dims: [1024, 1024] },
  { label: '16:9', dims: [1640, 856] },
  { label: '4:5', dims: [1024, 1280] },
  { label: '2:1', dims: [2048, 1024] },
  { label: '3:2', dims: [1536, 1024] },
  { label: '2:3', dims: [1024, 1536] },
];

function aspectForSize(size) {
  const parts = sizeParts(size);
  if (!parts) return '';
  for (const entry of IMAGE_ASPECT_RATIOS) {
    if (entry.dims[0] === parts.w && entry.dims[1] === parts.h) return entry.label;
  }
  return '';
}

// How close two sizes are, so "the nearest one it does offer" has a meaning:
// shape first, area second. A 16:9 request lands on 16:9 before it lands on
// something with the same megapixels, which is what the user is asking about.
function nearestDeclaredSize(declared, parts) {
  if (!parts) return '';
  const scored = declared
    .map((entry) => ({ value: entry.value, parts: sizeParts(entry.value) }))
    .filter((entry) => entry.parts)
    .map((entry) => ({
      value: entry.value,
      aspect: Math.abs(entry.parts.w / entry.parts.h - parts.w / parts.h),
      area: Math.abs(entry.parts.w * entry.parts.h - parts.w * parts.h),
    }))
    .sort((a, b) => a.aspect - b.aspect || a.area - b.area);
  if (!scored.length) return '';
  return scored[0].value;
}

// The size this service will actually be asked for.
//
// A store that lists its sizes has agreed to them, and handing it one it does
// not offer used to mean the draw failed on a service that was ready and had
// credits -- the request was refused for a reason nobody typed. The nearest size
// it does offer is used instead, and the swap is a sentence on screen rather
// than something found later in the download.
//
// A store that lists none has said nothing about size, and there a size is a
// preference like quality: sent, and dropped on a 400 rather than losing the
// picture over a setting nobody promised to understand.
function resolveImageSize(store, requested, label) {
  const want = String(requested || '').trim();
  if (!want) return { declaredSize: '', preferenceSize: '' };
  const declared = Array.isArray(store.sizes) && store.sizes.length ? store.sizes : null;
  if (!declared) return { declaredSize: '', preferenceSize: want };
  const exact = declared.find((entry) => entry.value === want);
  if (exact) return { declaredSize: exact.value, preferenceSize: '' };
  const nearest = nearestDeclaredSize(declared, sizeParts(want));
  if (!nearest || nearest === want) return { declaredSize: want, preferenceSize: '' };
  return {
    declaredSize: nearest,
    preferenceSize: '',
    note: (label ? 'asked for ' + want + ' — ' + label + ' draws ' : 'asked for ' + want + ' — the service draws ') + nearest,
  };
}

// The multipart body an OpenAI-shaped edits endpoint wants: file parts for the
// picture and its mask, fields for the rest. Built per attempt because the
// boundary is the framing, and a retry must not reuse the framing of a request
// that was refused.
function imageEditMultipart(args) {
  const { image, mask, prompt, model, extra } = args;
  const boundary = '----freeopenai' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const parts = [];
  const filePart = (name, filename, file) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.bytes);
    parts.push(Buffer.from('\r\n'));
  };
  const field = (name, value) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  filePart('image', 'image.png', image);
  if (mask) filePart('mask', 'mask.png', mask);
  field('prompt', prompt);
  field('model', model);
  for (const [name, value] of Object.entries(extra)) field(name, value);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

// One request, in whichever shape the chosen provider speaks, normalized to the
// OpenAI images payload the browser already reads.
//
// A shape is a list of attempts, and a 404 moves to the next one. That is for
// the two cases where the shape is not knowable from here: OpenRouter's own
// docs give its image path two ways (/api/v1/images and
// /api/v1/images/generations), and an NVIDIA_IMAGES_BASE_URL may be a self-hosted
// NIM (OpenAI-compatible images) or the hosted FLUX endpoints (NVCF GenAI). One
// 404 each, then the answer that works -- rather than a draw that fails because
// this app guessed the wrong third-party detail.
//
// quality and n are preferences, not requirements: both are documented on the
// OpenAI-shaped API, but a front is free to know only some of them, and Nara is
// strict enough that a dimension it does not list is a 400 rather than a
// rewrite. So a 400 that arrives while a preference was sent buys exactly one
// more attempt without it. A 400 is never billed, which is what makes that free.
async function drawImage(args) {
  const { id, provider, store, model, explicitModel, kind, prompt, image, mask, source, options, headers, signal } = args;
  const base = imageBaseFor(id, provider, store);
  // A keyless local server (Ollama) sends no auth header at all rather than a
  // bare "Bearer ", which some fronts read as a malformed token. A provider's
  // own headers ride along for the same reason they do on the chat path: they
  // are the service's, not the route's, and a draw is billed the same way.
  const auth = { ...(provider.key ? { Authorization: 'Bearer ' + provider.key } : {}), ...(headers || {}) };
  // The request's size, or the operator's default for this one service. Per
  // store, not global: 1024x1024 is Nara's and nothing else's business.
  const fallbackSize = store.sizeEnv ? String(process.env[store.sizeEnv] || '').trim() : '';
  const requestedSize = String(options.size || '').trim() || fallbackSize;
  const sizeForService = resolveImageSize(store, requestedSize, provider.label);
  const declaredSize = sizeForService.declaredSize;
  // Only what a service is free not to know about.
  const extra = {};
  if (options.quality) extra.quality = options.quality;
  if (options.n > 1) extra.n = options.n;
  if (sizeForService.preferenceSize) extra.size = sizeForService.preferenceSize;

  const postJson = (url, body, withExtra) => fetch(url, {
    method: 'POST',
    signal,
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(withExtra ? { ...body, ...extra } : body),
  });

  // Every shape below takes the model as an argument rather than closing over
  // one: the ladder at the bottom tries a second model, and rebuilding the
  // request is the only way a retry can differ from the attempt it repeats.
  const attemptsFor = (useModel) => {
    // The OpenAI-shaped request, used by Nara, OpenRouter, a gateway (OmniRoute),
    // a local server (Ollama) and a self-hosted NVIDIA NIM. An edit rides either
    // the edits endpoint as multipart, or the same generations endpoint as a
    // reference -- which of the two is the store's `edit` mode.
    const openaiAttempt = (path) => (withExtra) => {
      const body = { model: useModel, prompt };
      if (declaredSize) body.size = declaredSize;
      if (kind === 'edits' && store.edit === 'references' && source) {
        body.input_references = [{ type: 'image_url', image_url: { url: source } }];
      }
      return postJson(base + path, body, withExtra);
    };
    const multipartAttempt = (withExtra) => {
      const fields = withExtra ? { ...(declaredSize ? { size: declaredSize } : {}), ...extra } : (declaredSize ? { size: declaredSize } : {});
      const built = imageEditMultipart({ image, mask, prompt, model: useModel, extra: fields });
      return fetch(base + (store.editPath || '/images/edits'), {
        method: 'POST',
        signal,
        headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=' + built.boundary },
        body: built.body,
      });
    };

    if (store.shape === 'nvidia-genai') {
      return [
        (withExtra) => {
          // The hosted FLUX models: {prompt} in, {artifacts:[{base64}]} out.
          const body = { prompt, mode: 'base' };
          const aspect = aspectForSize(requestedSize);
          if (aspect) body.aspect_ratio = aspect;
          if (withExtra && extra.n > 1) body.n = extra.n;
          return postJson(base + '/genai/' + useModel, body, false);
        },
        // A self-hosted visual-genai NIM documents an OpenAI-compatible images
        // API instead of that shape, so a 404 moves here.
        openaiAttempt('/images/generations'),
      ];
    }
    if (store.shape === 'hf-inference') {
      // The task route, not the router: {inputs, parameters} in, image bytes out.
      return [(withExtra) => {
        const parameters = {};
        const parts = sizeParts(requestedSize);
        if (parts) { parameters.width = parts.w; parameters.height = parts.h; }
        if (withExtra && extra.n > 1) parameters.num_images = extra.n;
        return postJson(base + '/models/' + useModel, { inputs: prompt, parameters }, false);
      }];
    }
    if (kind === 'edits' && store.edit === 'multipart') return [multipartAttempt];
    // Two paths where a service describes its own endpoint two ways.
    return [store.path || '/images/generations', store.altPath].filter(Boolean).map(openaiAttempt);
  };

  // The chat's own model first, then the one this provider would draw with by
  // itself.
  //
  // The page now sends the model the conversation is on, because "generate an
  // image" should follow the choice the user already made rather than a second
  // picker. Most chat models on these services can draw, but not all, and a
  // model that cannot is a fact about the model and not about the provider: a
  // 400 is never billed, so the provider's own image model costs one free
  // attempt and is what makes this a preference rather than a gamble.
  const models = [model];
  if (explicitModel) {
    const own = imageModelFor(store, '');
    if (own && own !== model) models.push(own);
  }

  let response = null;
  for (let index = 0; index < models.length; index++) {
    const attempts = attemptsFor(models[index]);
    const send = async (withExtra) => {
      for (const attempt of attempts) {
        response = await attempt(withExtra);
        if (response.status !== 404) return;
      }
    };
    await send(true);
    if (Object.keys(extra).length && response && response.status === 400) {
      // A 400 is never billed, which is what makes this second attempt free. The
      // first answer is the one kept when the second fails too: dropping a
      // preference answers "was it the preference?", and when the answer is no, the
      // sentence worth reporting is the refusal the service actually wrote.
      console.warn('image ' + kind + ': ' + provider.label + ' refused a request carrying ' + Object.keys(extra).join(', ') + ' — retrying without them');
      const refusedWithPreferences = response;
      await send(false);
      if (!response || response.status >= 400) {
        if (response && response.body) await response.body.cancel().catch(() => {});
        response = refusedWithPreferences;
      }
    }
    const last = index === models.length - 1;
    if (last || !response || response.status !== 400) break;
    console.warn('image ' + kind + ': ' + provider.label + ' refused the chat model ' + models[index] + ' — retrying with its own image model, ' + models[index + 1]);
  }

  // Bytes or JSON, whichever this service answers with: hf-inference returns the
  // picture itself, the others return a document that carries it.
  const mediaType = String(response.headers.get('content-type') || '').split(';')[0].trim();
  const notes = sizeForService.note ? [sizeForService.note] : [];
  if (/^image\//i.test(mediaType)) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      notes,
      data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: bytes.toString('base64'), media_type: mediaType }] },
    };
  }
  const payload = await response.json().catch(() => null);
  // The NVCF shape ({artifacts:[{base64}]}) is normalized here rather than at
  // the caller, so there is one place a picture could be misread.
  if (payload && !payload.data) {
    const artifact = Array.isArray(payload.artifacts) ? payload.artifacts[0] : null;
    if (artifact && artifact.base64) {
      return { status: response.status, notes, data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: artifact.base64, media_type: 'image/png' }] } };
    }
  }
  return { status: response.status, notes, data: payload };
}

// The largest source picture an edit will carry, in bytes. The browser already
// shrinks attachments to fit, so this only ever catches a link that resolves to
// something enormous.
const IMAGE_FETCH_MAX_BYTES = 12 * 1024 * 1024;

// An edit's source picture arrives either as a data URL (something just
// attached) or as an https link (a picture this chat already drew, whose bytes
// live on the image host, or a photo from anywhere else). The multipart endpoint
// only takes bytes, so a link is fetched here -- through the same private-address
// guard the page reader uses, because this URL comes from the browser and the
// server would otherwise be talked into fetching from inside its own network.
//
// Without this an implicit edit -- "now make it look warmer", with no attachment
// and the previous picture named by its URL -- could only ever fail, and the one
// case that would have worked was re-uploading your own output by hand.
async function imageBytesFor(value, label) {
  const raw = String(value || '');
  const dataUrl = /^data:(.+?);base64,([\s\S]+)$/.exec(raw);
  if (dataUrl) return { contentType: dataUrl[1], bytes: Buffer.from(dataUrl[2], 'base64') };
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`Invalid ${label} image — expected a data URL or an http(s) link.`);
  }
  const parsed = new URL(raw);
  let address;
  try {
    address = await lookupHost(parsed.hostname);
  } catch {
    throw new Error(`Could not resolve the host for that ${label} image`);
  }
  if (isPrivateIp(address)) throw new Error(`That ${label} image address is not readable from here`);
  const fetched = await fetch(parsed.href);
  if (!fetched.ok) throw new Error(`Could not fetch the ${label} image (${fetched.status})`);
  const declared = Number(fetched.headers.get('content-length') || 0);
  if (declared > IMAGE_FETCH_MAX_BYTES) throw new Error(`That ${label} image is too large to edit here`);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  if (bytes.length > IMAGE_FETCH_MAX_BYTES) throw new Error(`That ${label} image is too large to edit here`);
  const contentType = String(fetched.headers.get('content-type') || 'image/png').split(';')[0].trim();
  return { contentType: /^image\//i.test(contentType) ? contentType : 'image/png', bytes };
}

// Where a picture is made, for whichever provider can make one.
//
// This route used to be Nara's and only Nara's: an operator holding an
// OpenRouter, NVIDIA or HuggingFace key could chat on it and not draw, and the
// one image route answered "Image generation needs NARA_IMAGE_MODEL" -- naming
// a service they had not configured at all. It now walks the image order and
// takes the first service that answers with a picture, so every provider that
// can draw actually draws.
//
// Puter is not in that order and does not need to be. It draws in the browser
// for the visitor's own account rather than the operator's key, so it is asked
// first and this route is only reached when it cannot answer.
//
// The body is the same whatever the provider: a prompt, plus for an edit the
// source picture and the optional mask. `provider` and `model` may name a
// service, and naming one is honoured exactly -- no falling through behind a
// choice the user made on purpose.
async function llmImage(req, res, kind) {
  const what = kind === 'edits' ? 'Image editing' : 'Image generation';
  readJsonBody(req, 12 * 1024 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' });
    // The conversation's own service and model, sent as a preference rather than
    // a pin: that provider is asked first, with that model, and the rest of the
    // order stays behind it. Which one the page names is the user's own choice
    // from the model picker, so it is worth honouring -- and worth not being
    // trapped by when the model turns out not to draw.
    const order = imageDrawOrder(body.provider, {
      explicitModel: body.model,
      preferredProvider: body.preferProvider,
    });
    if (order.error) return sendJson(res, 400, { error: order.error });
    const options = {
      size: String(body.size || '').trim(),
      quality: body.quality ? String(body.quality) : '',
      // One prompt cannot reasonably ask for more than ten pictures -- that is
      // the ceiling the OpenAI images API documents, and some upstreams cap at
      // one, which is why whatever comes back short is drawn again by the caller.
      n: Number(body.n) > 1 ? Math.min(10, Math.floor(Number(body.n))) : 1,
    };
    // A render legitimately takes a while, but not forever. Without a deadline a
    // stalled image service keeps this request open until the hosting platform's
    // own ceiling answers it, and that arrives as an opaque failure rather than
    // the sentence below -- which is the same class of bug the chat path fixed.
    const budget = providerTimeoutMs().chat;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      // The source picture is read once, before any provider is asked. A link
      // has to be fetched, and a mask has to match the picture it describes, so
      // both are resolved up front: an unreadable link is a 400 with the reason,
      // rather than a malformed body sent upstream to be guessed at.
      let image = null;
      let mask = null;
      let source = '';
      if (kind === 'edits') {
        if (!body.image) return sendJson(res, 400, { error: 'image is required' });
        try {
          image = await imageBytesFor(body.image, 'source');
          if (body.mask) mask = await imageBytesFor(body.mask, 'mask');
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        // A service that takes a reference rather than a file part wants a URL.
        // The bytes were just read, so this is the same picture either way -- and
        // passing the caller's own link through instead would have the far side
        // fetch from a host it may not be able to reach.
        source = 'data:' + image.contentType + ';base64,' + image.bytes.toString('base64');
      }
      const failures = [];
      const notes = [];
      for (const candidate of order.candidates) {
        // A painted mask is a file part or it is nothing. Handing one to a
        // service that takes a reference would edit the whole picture while the
        // user watches a region they drew being ignored, so the mask is dropped
        // here and said out loud instead of being quietly wasted.
        let useMask = mask;
        if (mask && candidate.store.edit !== 'multipart') {
          useMask = null;
          const dropped = 'the brush mask was dropped — ' + candidate.provider.label + ' edits the whole picture only';
          if (!notes.includes(dropped)) notes.push(dropped);
        }
        let drawn;
        try {
          drawn = await drawImage({
            id: candidate.id,
            provider: candidate.provider,
            store: candidate.store,
            model: candidate.model,
            kind,
            prompt,
            image,
            mask: useMask,
            source,
            options,
            // Whether the name being tried is the request's own, which is what
            // earns the second attempt with this provider's own image model.
            explicitModel: candidate.model === String(body.model || '').trim() && !!candidate.model,
            headers: typeof candidate.provider.headers === 'function' ? candidate.provider.headers(req) : null,
            signal: controller.signal,
          });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          // A socket failure is a fact about this service -- a host that does
          // not resolve, a port with nothing behind it -- and the next provider
          // is a real chance of a picture, so this is recorded and stepped past.
          failures.push({ label: candidate.provider.label, reason: e.message + fetchFailureReason(e) });
          continue;
        }
        if (drawn.status >= 200 && drawn.status < 300) {
          if (imageUrlsIn(drawn.data).length) {
            // Which service drew rides back with the picture. It is the one fact
            // about an image that cannot be recovered afterwards, and the page
            // says it rather than leaving the user to guess who to thank.
            // What the provider had to say about itself rides along with the
            // picture: a size it had to swap for its nearest one, a mask it
            // cannot take. Both are answers to questions the request asked.
            const allNotes = [...(drawn.notes || []), ...notes];
            sendJson(res, 200, {
              ...drawn.data,
              provider: candidate.id,
              providerLabel: candidate.provider.label,
              model: candidate.model,
              ...(allNotes.length ? { notes: allNotes } : {}),
            });
            return;
          }
          // A 200 carrying no picture is this service not doing the job, which is
          // exactly what the next provider is for.
          failures.push({ label: candidate.provider.label, reason: 'answered without a picture', status: 502 });
          continue;
        }
        const detail = describeProviderError(drawn.status, drawn.data, candidate.provider);
        // A refusal is the prompt's fault, and the next provider is handed the
        // same prompt: paying a second key to hear it refused again is the
        // opposite of what the sentence will tell the user to do.
        if (imageLooksRefused(drawn.status, detail)) {
          return sendJson(res, 422, { error: detail, refused: true, provider: candidate.id });
        }
        // Everything else -- a key not allowed, a model this account cannot
        // reach, a bill, a 5xx -- is a fact about *that* service rather than
        // about the request, so the order continues with the next one.
        failures.push({ label: candidate.provider.label, reason: detail, status: drawn.status });
      }
      // One provider tried means its status is the answer: a 400 is a 400, and a
      // 403 is a 403, both of which say far more than the 502 that stands in for
      // "somewhere in a chain of services something went wrong".
      const status = failures.length === 1 && failures[0].status >= 400 ? failures[0].status : 502;
      sendJson(res, status, {
        error: imageDrawFailureMessage(what, failures),
        tried: failures.map((f) => f.label),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return sendJson(res, 504, {
          error:
            what + ' timed out: no image service answered within ' +
            Math.round(budget / 1000) +
            's — the service is slow or unreachable, not your prompt. Try again.',
        });
      }
      sendJson(res, 502, { error: e.message });
    } finally {
      clearTimeout(timer);
    }
  });
}

// The image services this deployment can actually draw with, in the order they
// would be tried, each with what it is missing when it cannot. The page reads
// this instead of guessing: a picker that offers a service the server has no key
// for turns a working setup into a failure the user then has to debug.
function llmImageProviders(req, res) {
  sendJson(res, 200, {
    // Puter is not a server provider -- it draws in the browser on the visitor's
    // own account -- so it is reported here only so the picker can offer it in
    // the same list, and marked as what it is.
    browser: { id: 'puter', label: 'Puter', ready: false, note: 'Draws in your browser, billed to your Puter account when signed in.' },
    providers: imageProvidersReport(),
  }, { 'Cache-Control': 'no-store' });
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
    const ids = (Array.isArray(provider.models) ? provider.models : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => ({ id: id.trim() }));
    // An empty 200 here is the worst possible answer: the client renders it as
    // "this provider returned no chat models", which blames the provider for
    // what is always a configuration mistake. Say which variable decides the
    // list instead, so the fix is obvious from the message alone.
    if (!ids.length) {
      const variable = providerEnvName(provider.envVar, '_MODELS');
      const bad = unsafeHeaderChar(process.env[variable] || '');
      return sendJson(res, 500, {
        error:
          'This provider publishes no model catalogue of its own, and no models are declared for it. ' +
          'Set ' + variable + ' to a comma-separated list of the ids it serves' +
          (bad ? " -- the value currently set contains a non-ASCII character at position " + bad.index + '.' : '.') +
          ' (Leave it unset to use the list this build ships with.)',
      });
    }
    return sendJson(res, 200, ids);
  }
  const ttl = modelsCacheTtlMs();
  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return sendJson(res, 200, cached.models);
  }
  try {
    const result = id === 'ollama'
      ? await fetchOllamaModels(req, provider)
      : await providerFetch(req, provider, provider.modelsPath || '/models');
    const { ok, status, data } = result;
    if (!ok) {
      // Nara's catalogue endpoint occasionally answers 500 ("An internal
      // error occurred.") while chat on the same key stays up. A provider
      // with a pinned allowlist can still offer a pickable list, so serve
      // it as bare ids rather than emptying the picker for a transient
      // catalogue outage. Transport-level failures (502/504, empty body)
      // still report as errors -- the tests below lock that in.
      if (status === 500 && data != null && Array.isArray(provider.models) && provider.models.length) {
        const pinned = provider.models.map((id) => ({ id })).filter((m) => m && m.id);
        if (pinned.length) {
          modelCache.set(id, { fetchedAt: Date.now(), models: pinned });
          return sendJson(res, 200, pinned);
        }
      }
      return sendJson(res, status, { error: describeProviderError(status, data, provider) });
    }
    // OpenAI-compatible providers wrap the catalogue in { data: [...] }, but
    // the wire occasionally disagrees -- a bare array, or Ollama-style
    // { models: [...] }. Reading any of those beats reading the answer as
    // nothing, which used to flow on as an empty 200 and the client's
    // "this provider returned no chat models".
    let rows = [];
    if (data && Array.isArray(data.data)) rows = data.data;
    else if (data && Array.isArray(data.models)) rows = data.models;
    else if (Array.isArray(data)) rows = data;
    const models = rows
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
    // A catalogue that parsed to nothing (upstream hiccup, surprise shape)
    // lands here too, and an empty-rows fallback that still leaves nothing
    // serves the pinned list as bare ids: pickable and addressable beats a
    // picker with no rows at all.
    if (listed.length === 0) {
      if (provider.freeOnly) {
        const free = models.filter((m) => isFreeModelId(m.id));
        if (free.length) listed = free;
      }
      if (!listed.length && models.length) listed = models;
      if (!listed.length && Array.isArray(provider.models)) {
        listed = provider.models.map((id) => ({ id })).filter((m) => m && m.id);
      }
    }
    // Only a successful, non-empty answer is worth caching; errors rust
    // nothing, and an empty list would outlive the upstream hiccup that
    // caused it, pinning "no models" for the cache's whole lifetime.
    if (listed.length) modelCache.set(id, { fetchedAt: Date.now(), models: listed });
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
let skillsRateLimited = false;

// GitHub's tree API allows 60 unauthenticated requests an hour per address, and
// the catalogue spends one per source -- so on a shared address (a container
// host, an office, a VPN) the library goes quiet part way through the day and
// comes back empty, with nothing anywhere saying why. A token raises the same
// budget to 5000, and GITHUB_TOKEN is a one-line setting next to the OAuth app
// the GitHub tools already need.
function githubApiHeaders() {
  const headers = { 'User-Agent': 'freeopenai-app', Accept: 'application/vnd.github+json' };
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

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

// Lists one repo's skills from its git tree as { name, path } pairs, honoring
// `pick` (an explicit name list = lite) or 'all'. Trees fail closed: an error
// means no skills from this source, not a crash.
//
// The path is carried out of here rather than reconstructed from the name: a
// repo may nest its skills (`skills/engineering/code-review/SKILL.md`) or put
// the file at its root, and the fetcher below has to ask for the file that is
// actually there.
async function fetchSkillEntries(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://api.github.com/repos/${source.repo}/git/trees/${source.branch}?recursive=1`, {
      headers: githubApiHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 403 is how GitHub says "rate limit" on this endpoint, and 429 is the
      // explicit form of the same thing. Either way the library is about to look
      // empty for a reason that has nothing to do with the app.
      if (res.status === 403 || res.status === 429) skillsRateLimited = true;
      return [];
    }
    const data = await res.json();
    return skillEntriesFromTree(data.tree, source);
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
      const entries = await fetchSkillEntries(source);
      // Bounded parallelism per repo; a huge repo shouldn't open 50 sockets.
      const rows = [];
      for (let i = 0; i < entries.length; i += 8) {
        const slice = entries.slice(i, i + 8);
        const texts = await Promise.all(slice.map((entry) => fetchSkillText(source, entry.path)));
        slice.forEach((entry, j) => {
          const body = texts[j] || '';
          const meta = parseSkillFrontmatter(body);
          // The frontmatter name wins when it disagrees with the folder: it is
          // what the skill calls itself, and what the model will ask for.
          const name = meta.name || entry.name;
          if (body && meta.description) {
            rows.push({ source: source.repo, name, description: meta.description, body, allowedTools: meta.allowedTools || null, userOnly: !!meta.userOnly });
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
    else if (skillsRateLimited) {
      // The one failure an operator can actually fix, so it is said out loud
      // rather than left as a skill picker that is simply empty.
      console.warn('[skills] GitHub refused the tree request (rate limit) — set GITHUB_TOKEN to raise the hourly allowance.');
    }
    skillsRateLimited = false;
    return skillsCache.skills;
  })().finally(() => { skillsFetch = null; });
  return skillsFetch;
}

// GET /api/skills — the id catalogue for the picker.
function llmSkills(req, res) {
  loadSkills().then((skills) => {
    sendJson(res, 200, skills.map((s) => ({ source: s.source, name: s.name, description: s.description, allowedTools: s.allowedTools || null, userOnly: !!s.userOnly })));
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
  // P2 enforcement hook: prevent writing to protected files through
  // workspace_write_file from corrupting secrets or proxy state.
  if (provider.id === 'antigravity') {
    const guard = enforceNoSecretWrites(req);
    if (guard && guard.blocked) return sendJson(res, 400, { error: guard.reason });
  }
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

// --- Sending a static file ---
//
// The whole UI is one 520KB index.html plus a 208KB chatlib.js, and both went
// out uncompressed on every single load: 728KB of text, most of it whitespace and
// the long comments this codebase is written in. Both compress about eight to one.
//
// Two things are fixed here, and they answer different questions.
//
//   Encoding -- brotli when the client takes it, gzip otherwise. 728KB becomes
//   154KB, which on a phone is the difference between a slow load and a quick one,
//   and it is the user's own mobile data either way. Compressing 520KB is not free,
//   so each encoding is produced once and kept; the file's mtime and size are the
//   cache key, so a deploy invalidates it without anyone having to remember to.
//
//   Revalidation -- an ETag. 'no-cache' is right for this app and is not what it
//   sounds like: it means revalidate before reuse, not never store. But with no
//   validator to revalidate *with*, every reload was a full download of bytes the
//   browser already had. With one, an unchanged deploy answers 304 and sends no
//   body at all.
//
// Vary is not optional. Without it any shared cache in front of this may hand a
// brotli body to a client that cannot read it.
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg)/;
const COMPRESS_FLOOR = 1024;
const encodedCache = new Map();

function acceptedEncoding(req) {
  const header = String((req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  // Parsed rather than pattern-matched, because `;q=0` is a refusal: it is the
  // one case where naming an encoding means the opposite of asking for it, and a
  // regex that misses it would send a body the client cannot read.
  const offered = new Set();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';').map((bit) => bit.trim());
    if (!name) continue;
    const q = params.map((bit) => /^q=(.*)$/.exec(bit)).find(Boolean);
    if (q && Number(q[1]) === 0) continue;
    offered.add(name);
  }
  if (offered.has('br')) return 'br';
  if (offered.has('gzip')) return 'gzip';
  return '';
}

function encodedVariants(file, stat, data) {
  const fresh = stat ? stat.mtimeMs + ':' + stat.size : '';
  const hit = encodedCache.get(file);
  if (hit && hit.key === fresh) return hit;
  const entry = {
    key: fresh,
    etag: '"' + crypto.createHash('sha1').update(data).digest('base64url') + '"',
    identity: data,
  };
  if (fresh) encodedCache.set(file, entry);
  return entry;
}

function sendStatic(req, res, file, data, stat, contentType) {
  const variants = encodedVariants(file, stat, data);
  // A matching validator means the browser already holds this exact body, so
  // there is nothing to send and nothing to compress.
  const inm = req.headers && req.headers['if-none-match'];
  if (inm && String(inm).split(',').some((tag) => tag.trim() === variants.etag)) {
    res.writeHead(304, { ETag: variants.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
    res.end();
    return;
  }
  const headers = {
    'Content-Type': contentType,
    // Static files revalidate rather than being reused blind: the whole UI ships
    // in index.html, so a cached copy silently runs yesterday's code. The ETag
    // above is what makes that revalidation cost nothing.
    'Cache-Control': 'no-cache',
    ETag: variants.etag,
    Vary: 'Accept-Encoding',
  };
  let body = variants.identity;
  const wanted = COMPRESSIBLE.test(contentType) && data.length >= COMPRESS_FLOOR ? acceptedEncoding(req) : '';
  if (wanted) {
    if (!variants[wanted]) {
      try {
        variants[wanted] = wanted === 'br'
          // Text this size at the default quality of 11 costs far more time than
          // the last few percent is worth, and the result is cached either way.
          ? zlib.brotliCompressSync(data, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
              },
            })
          : zlib.gzipSync(data, { level: 6 });
      } catch {
        // A compressor that fails is not a reason to fail the request.
        variants[wanted] = null;
      }
    }
    if (variants[wanted]) {
      body = variants[wanted];
      headers['Content-Encoding'] = wanted;
    }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

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
    if (urlPath === '/api/llm/images/providers' && req.method === 'GET') return llmImageProviders(req, res);
    if (urlPath === '/api/llm/images/generations' && req.method === 'POST') return llmImage(req, res, 'generations');
    if (urlPath === '/api/llm/images/edits' && req.method === 'POST') return llmImage(req, res, 'edits');
    if (urlPath === '/api/llm/websearch' && req.method === 'GET') return llmWebsearch(req, res);
    if (urlPath === '/api/llm/fetch' && req.method === 'GET') return llmFetch(req, res);
    if (urlPath === '/api/github/repos' && req.method === 'GET') return githubRepos(req, res);
    if (urlPath === '/api/github/tree' && req.method === 'GET') return githubListDir(req, res);
    if (urlPath === '/api/github/file' && req.method === 'GET') return githubGetFile(req, res);
    if (urlPath === '/api/github/file' && req.method === 'PUT') return githubPutFile(req, res);
    if (urlPath === '/api/github/file' && req.method === 'DELETE') return githubDeleteFile(req, res);
    if (urlPath === '/api/github/search' && req.method === 'GET') return githubSearchCode(req, res);
    if (urlPath === '/api/github/commits' && req.method === 'GET') return githubListCommits(req, res);

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
        const shell = path.join(root, 'index.html');
        fs.readFile(shell, (e2, html) => {
          if (e2) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          fs.stat(shell, (e3, shellStat) => {
            sendStatic(req, res, shell, html, e3 ? null : shellStat, 'text/html; charset=utf-8');
          });
        });
        return;
      }
      fs.stat(file, (statErr, stat) => {
        sendStatic(req, res, file, data, statErr ? null : stat,
          mime[path.extname(file)] || 'application/octet-stream');
      });
    });
  };
}

if (require.main === module) {
  http.createServer(createRequestHandler(rootDir)).listen(port, () => console.log(`Serving on port ${port}`));
}

module.exports = {
  githubApiHeaders,
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
