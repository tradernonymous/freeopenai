const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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
  readSession,
  verifySession,
  parseCookieHeader,
  checkRateLimit,
} = require('./auth.js');
const { matchListEntry, isFreeModelId, freeRowsOnly, selectAllowedModels, isRetryableStatus, isQuotaExhausted, unsafeHeaderChar, SKILL_SOURCES, parseSkillFrontmatter, skillEntriesFromTree, MODELS, DEFAULT_MODEL } = require('./chatlib.js');
const {
  encryptJson,
  decryptJson,
  sessionMatchesUser,
  MAX_GITHUB_ACCOUNTS,
  normalizeGithubSession,
  accountsOf,
  pickAccount,
} = require('./github.js');
const { createBuildSessions, handleBuildRoute, resolveInside, protectedPath, searchFolder, refusedGit } = require('./agent-sessions.js');
const { parseServiceAccount, sendPush } = require('./fcm-push.js');

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

// --- The provider ledger ----------------------------------------------------
//
// Every number the app already sees and used to throw away: how long a provider
// took, what it answered, when it last rate limited us, and how many of today's
// calls it has served. This is what makes "move this turn to another provider"
// a decision instead of a guess, and it is deliberately per process and in
// memory: a deploy restarts the count, and these are our own beats against an
// allowance the provider keeps -- an estimate, never an authority on it.
const providerLedger = new Map();

function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function ledgerFor(providerId) {
  const key = String(providerId || '');
  let entry = providerLedger.get(key);
  if (!entry) {
    entry = {
      lastStatus: 0,
      lastAt: 0,
      latencyMs: null,
      lastRetryAfterMs: null,
      // One entry per model this process has actually called, so it is bounded
      // by the provider's catalogue rather than by traffic.
      modelMs: new Map(),
      calls: 0,
      day: '',
    };
    providerLedger.set(key, entry);
  }
  return entry;
}

// An exponentially weighted mean, so one slow call does not condemn a provider
// and one fast one does not forgive it. 30% of the newest beat is enough to
// follow a provider that gets worse within a handful of calls.
function foldLatency(previous, ms) {
  return previous === null || previous === undefined ? ms : Math.round(previous * 0.7 + ms * 0.3);
}

function recordProviderAttempt(providerId, outcome = {}) {
  const entry = ledgerFor(providerId);
  const ms = Number(outcome.ms);
  const day = utcDayKey();
  if (entry.day !== day) {
    entry.day = day;
    entry.calls = 0;
  }
  // The unit a free tier's daily cap is written in, counted when the call is
  // made rather than when it succeeds: a rate-limited attempt spent the
  // provider's time either way.
  entry.calls += 1;
  entry.lastStatus = Number(outcome.status) || 0;
  entry.lastAt = Date.now();
  if (Number.isFinite(ms) && ms > 0) {
    entry.latencyMs = foldLatency(entry.latencyMs, ms);
    const model = typeof outcome.model === 'string' ? outcome.model : '';
    if (model) entry.modelMs.set(model, foldLatency(entry.modelMs.get(model), ms));
  }
  const retryAfterMs = Number(outcome.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) entry.lastRetryAfterMs = retryAfterMs;
}

function providerLedgerSnapshot(providerId) {
  const entry = providerLedger.get(String(providerId || ''));
  const cooldownMs = providerCooldownRemaining(providerId);
  if (!entry && !cooldownMs) return null;
  // A count from yesterday is not today's count. The rollover happens here as
  // well as on the way in, so a deployment that idled overnight reports zero
  // rather than the number it stopped at.
  const day = utcDayKey();
  const callsToday = entry && entry.day === day ? entry.calls : 0;
  // Only what a caller reads: the last answer, how long it took, how long the
  // provider asked to be left alone, and today's count against its free tier.
  return {
    lastStatus: entry ? entry.lastStatus : 0,
    lastAt: entry ? entry.lastAt : 0,
    latencyMs: entry ? entry.latencyMs : null,
    cooldownMs,
    cooling: cooldownMs > 0,
    lastRetryAfterMs: entry ? entry.lastRetryAfterMs : null,
    callsToday,
  };
}

// The observed time for one model, for the picker: a row that has answered
// slowly every time it was asked is worth knowing about before it is picked,
// not after it stalls the turn.
function providerModelLatency(providerId, modelId) {
  const entry = providerLedger.get(String(providerId || ''));
  if (!entry) return null;
  const ms = entry.modelMs.get(String(modelId || ''));
  return Number.isFinite(ms) ? ms : null;
}

// How long one call may spend *waiting* to retry, in total. An attempt count
// alone cannot bound this: a free tier's Retry-After is routinely longer than
// the whole turn is worth -- OVHcloud asks for 40-57s on an allowance of two
// requests a minute -- so six attempts at that schedule is minutes of dead air
// before the app even considers another provider. Past this budget the refusal
// is handed back as-is, which is exactly the signal the caller needs to move
// the turn somewhere else.
function retryBudgetMs() {
  const n = Number(process.env.RATE_LIMIT_RETRY_BUDGET_MS);
  return Number.isFinite(n) && n >= 0 ? n : 20000;
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
async function retryProviderRequest(providerId, attempt, meta = {}) {
  const maxAttempts = rateLimitMaxAttempts();
  // Waiting has a clock of its own: see retryBudgetMs. `waitedMs` is what this
  // call has actually spent asleep, so a provider asking for a long wait cannot
  // spend a turn on retries that were never going to succeed.
  const budget = retryBudgetMs();
  let waitedMs = 0;
  let result;
  for (let tryNum = 0; tryNum < maxAttempts; tryNum += 1) {
    const wait = providerCooldownRemaining(providerId);
    // A provider that asked to be left alone for longer than this call may wait
    // is the same stall as a Retry-After we declined, so it gets the same answer:
    // the refusal goes back with the reason in it and the client moves the turn
    // on. Sleeping it here would hold the turn on a wait nothing is waiting for.
    if (wait > budget) {
      const label = (LLM_PROVIDERS[providerId] && LLM_PROVIDERS[providerId].label) || providerId;
      return {
        ok: false,
        status: 429,
        retryAfterMs: wait,
        data: { error: { message: `${label} is cooling down for another ${Math.ceil(wait / 1000)}s after a rate limit` } },
      };
    }
    if (wait > 0) {
      await sleep(wait);
      waitedMs += wait;
    }
    const startedAt = Date.now();
    try {
      result = await attempt();
    } catch (err) {
      // Our own deadline (headers/chat budget, or a client abort) is not a
      // provider "no response" to ride out — retrying it would re-spend the
      // same budget again. A genuine connection failure, though, is worth
      // probing up to the cap before the caller reports the real error.
      if (err.name === 'AbortError') throw err;
      recordProviderAttempt(providerId, { ms: Date.now() - startedAt, status: 0, model: meta.model });
      const delay = Math.min(retryBackoffMs(tryNum), 30000);
      markProviderCooldown(providerId, delay + retryBaseDelayMs());
      if (tryNum >= maxAttempts - 1) throw err;
      // The same waiting budget the refusal path below enforces: a connection
      // that keeps failing is worth probing, but not past the point where the
      // turn is worth more somewhere else.
      if (waitedMs + delay > budget) throw err;
      waitedMs += delay;
      await sleep(delay);
      continue;
    }
    let status = result && typeof result.status === 'number' ? result.status : 0;
    if (result && typeof result.status !== 'number') status = result.ok ? 200 : 599;
    // One beat per attempt, for the ledger. Retry-After comes along because it
    // is the fact that tells an operator how long the provider wanted to be
    // left alone -- which is what /api/llm/providers reports and what the
    // client uses to steer clear of a provider still cooling down.
    recordProviderAttempt(providerId, {
      ms: Date.now() - startedAt,
      status,
      model: meta.model,
      retryAfterMs:
        result && typeof result.headers === 'object' && typeof result.headers.get === 'function'
          ? parseRetryAfterMs(result.headers)
          : result && typeof result.retryAfterMs === 'number'
            ? result.retryAfterMs
            : undefined,
    });
    // A timeout we imposed (providerFetch's own deadline) is a budget spent,
    // not a transient refusal to retry through.
    if (result.selfTimeout) return result;
    // A spent allowance is not a transient refusal — retrying it re-spends the
    // same wait for the same answer. Ollama Cloud's monthly cap and a
    // gateway's "Quota Exhausted" both 429 with a body that says so.
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
    // A provider's own Retry-After is honoured in full, and a free tier's is
    // routinely longer than the turn is worth (OVHcloud asks for 40-57s on an
    // allowance of two requests a minute). Past the budget, hand the refusal
    // back instead of sleeping through it: the caller moves the turn on with
    // the work already done, which is the only outcome that keeps the user's
    // task alive. The cooldown is set for the wait we declined, so the next
    // call skips this provider until it has had the time it asked for.
    if (waitedMs + delay > budget) {
      markProviderCooldown(providerId, delay);
      return result;
    }
    waitedMs += delay;
    markProviderCooldown(providerId, delay + retryBaseDelayMs());
    await sleep(delay);
  }
  return result;
}

// Retries an idempotent provider call (chat completions) on retryable statuses.
// The last attempt is always returned as-is, so the caller can describe it.
async function fetchProviderWithRetry(providerId, fetchOnce, meta) {
  return retryProviderRequest(providerId, fetchOnce, meta);
}

// The streaming sibling: each attempt resolves to a raw Response so the caller
// can pipe the upstream body through. The retryable status arrives as the
// initial status before any body is read, so the same retry/cooldown logic
// applies. When the client cancels, `onAbort` aborts the in-flight read.
async function fetchStreamWithRetry(providerId, fetchRaw, meta) {
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
  }, meta);
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

// Origins the desktop shell actually runs on: the Tauri 2 production origin
// (http://tauri.localhost on Windows, tauri://localhost on macOS/Linux) and
// the vite dev server. Localhost on any port stays allowed for local
// tooling. Everything else -- any public website -- gets no grant, because
// reflecting an arbitrary origin back with credentials on would let it act
// with the user's session cookie.
function corsOriginFor(origin) {
  if (!origin) return null;
  if (origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost' || origin === 'tauri://localhost') return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function setSessionCookie(res, username, req) {
  const value = signSession(sessionSecret, username);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  // The desktop shell is a separate origin, so a Lax cookie never rides its
  // fetches and sign-in would not stick there. Browsers only accept a
  // cross-site cookie as SameSite=None with Secure, which the https proxy
  // header guarantees on Railway; same-site browser use keeps Lax.
  const crossSite = secure !== '' && !!corsOriginFor(req.headers.origin);
  const sameSite = crossSite ? '; SameSite=None; Secure' : `; SameSite=Lax${secure}`;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${value}; HttpOnly;${sameSite}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
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

// GET /api/session: who this request is signed in as. The Android app asks
// this on every launch, before it loads the page, so an expired session is
// found out in a 401 here rather than half-way through a chat.
//
// A session past half its life is renewed on the way out. The web page has
// no launch step to hang a renewal on, so its sessions run the full seven
// days and then ask again; the app, which does, stays signed in for as long
// as it is opened at least once a week. The gate itself is unchanged: the
// route sits behind it like every other /api/ path, so a request that gets
// here at all is either signed in or on a deployment with no accounts set.
function sessionStatus(req, res) {
  if (getConfiguredAccounts(process.env).length === 0) {
    return sendJson(res, 200, { gate: false, user: null });
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = readSession(sessionSecret, cookies[SESSION_COOKIE_NAME]);
  if (!session) return sendJson(res, 401, { error: 'Not signed in' });
  if (session.exp - Date.now() < SESSION_TTL_MS / 2) setSessionCookie(res, session.username, req);
  return sendJson(res, 200, { gate: true, user: session.username, expiresAt: session.exp });
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

// A branch name reaches the contents API as ?ref= on a read and as a `branch`
// field on a write. Both are optional: without one GitHub uses the repository's
// default branch, which is the behaviour every call here had before branches
// existed as a concept in this app.
function refQuery(branch) {
  const name = String(branch || '').trim();
  return name ? '?ref=' + encodeURIComponent(name) : '';
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
      `https://api.github.com/repos/${repo}/contents/${encoded}` + refQuery(query.get('branch'))
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
      `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}` + refQuery(query.get('branch'))
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
    const { repo, path: filePath, content, message, sha, branch, account: requested } = body || {};
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
        // On the same branch the write is going to: a sha read from another
        // branch names a different blob, and GitHub rejects the commit with a
        // conflict that reads like the file was changed underneath you.
        `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}` + refQuery(branch)
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
          body: JSON.stringify({
            message,
            content: Buffer.from(content, 'utf8').toString('base64'),
            sha: resolvedSha || undefined,
            branch: String(branch || '').trim() || undefined,
          }),
        }
      );
      if (!ok) return sendJson(res, status, { error: (data && data.message) || 'Could not commit file' });
      sendJson(res, 200, {
        sha: data.content.sha,
        htmlUrl: data.content.html_url,
        commitUrl: data.commit.html_url,
        account: account.login,
        branch: String(branch || '').trim() || undefined,
      });
    } catch (e) {
      sendJson(res, 502, { error: e.message });
    }
  });
}

// The branches a repository has, and which one is its default. A model that
// cannot see this guesses "main", which is wrong often enough to matter: a repo
// whose only branch is `claude/some-feature` answers 404 for every read, and
// the reason is invisible from the outside.
async function githubListBranches(req, res) {
  const query = new URL(req.url, 'http://x').searchParams;
  const repo = query.get('repo');
  if (!repo) return sendJson(res, 400, { error: 'repo is required' });
  const account = resolveAccount(req, res, repo);
  if (!account) return;
  try {
    const [branches, meta] = await Promise.all([
      githubApiFetch(account.token, `https://api.github.com/repos/${repo}/branches?per_page=100`),
      githubApiFetch(account.token, `https://api.github.com/repos/${repo}`),
    ]);
    if (!branches.ok) {
      return sendJson(res, branches.status, { error: (branches.data && branches.data.message) || 'Could not list branches' });
    }
    const defaultBranch = meta.ok && meta.data ? meta.data.default_branch : undefined;
    sendJson(res, 200, {
      defaultBranch,
      branches: (Array.isArray(branches.data) ? branches.data : []).map((b) => ({
        name: b.name,
        sha: b.commit && b.commit.sha,
        isDefault: b.name === defaultBranch,
      })),
    });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

// Create a branch. This existed nowhere, and its absence was reported by the
// agent itself: asked to put work on `main` in a repo that had only a
// `claude/...` branch, it answered that branch creation "requires the GitHub
// web UI or the git CLI" and handed the user a list of clicks. A branch is one
// POST to the refs API, so the tool surface was the only thing missing.
function githubCreateBranch(req, res) {
  readJsonBody(req, 64 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const { repo, branch, from, account: requested } = body || {};
    const name = String(branch || '').trim();
    if (!repo || !name) return sendJson(res, 400, { error: 'repo and branch are required' });
    const picked = pickAccount(getGithubSession(req), repo, requested);
    if (picked.error) {
      return sendJson(res, picked.error === 'GitHub not connected' ? 401 : 400, { error: picked.error });
    }
    const account = picked.account;
    try {
      // Where to branch from: the named source, else whatever the repository
      // calls its default. Resolving it here means the caller never has to know
      // a sha, which is the part of the refs API that makes it awkward.
      let source = String(from || '').trim();
      if (!source) {
        const meta = await githubApiFetch(account.token, `https://api.github.com/repos/${repo}`);
        if (!meta.ok) {
          return sendJson(res, meta.status, { error: (meta.data && meta.data.message) || 'Could not read the repository' });
        }
        source = meta.data && meta.data.default_branch;
        if (!source) {
          return sendJson(res, 400, {
            error: `${repo} has no commits yet, so there is nothing to branch from. Commit a first file to it instead.`,
          });
        }
      }
      const ref = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(source)}`
      );
      if (!ref.ok || !ref.data || !ref.data.object || !ref.data.object.sha) {
        return sendJson(res, ref.status === 200 ? 400 : ref.status || 502, {
          error: `No branch "${source}" in ${repo} to branch from`,
        });
      }
      const { ok, status, data } = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/git/refs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: 'refs/heads/' + name, sha: ref.data.object.sha }),
        }
      );
      if (!ok) {
        // GitHub answers an existing branch with 422 "Reference already
        // exists", which is not a failure worth retrying -- say what is true
        // so the model carries on rather than trying again with a new name.
        const message = (data && data.message) || 'Could not create the branch';
        if (status === 422 && /already exists/i.test(message)) {
          return sendJson(res, 200, { repo, branch: name, from: source, existed: true, account: account.login });
        }
        return sendJson(res, status, { error: message });
      }
      sendJson(res, 200, { repo, branch: name, from: source, sha: ref.data.object.sha, created: true, account: account.login });
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
    const { repo, path: filePath, message, branch, account: requested } = body || {};
    if (!repo || !filePath) return sendJson(res, 400, { error: 'repo and path are required' });
    const picked = pickAccount(getGithubSession(req), repo, requested);
    if (picked.error) {
      return sendJson(res, picked.error === 'GitHub not connected' ? 401 : 400, { error: picked.error });
    }
    const account = picked.account;
    try {
      const existing = await githubApiFetch(
        account.token,
        `https://api.github.com/repos/${repo}/contents/${encodePath(filePath)}` + refQuery(branch)
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
          body: JSON.stringify({
            message: message || `Delete ${filePath}`,
            sha: existing.data.sha,
            branch: String(branch || '').trim() || undefined,
          }),
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
      'agnes-3-flash',
      'atria-dawn',
      'laguna-s-2.1',
      'stepfun-3.7-flash',
      'deepseek-v4.1-flash-free',
      'muse-spark-1.3-contributor-free',
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
    freeTier: {
      models: [':free'],
      limits: { requestsPerDay: 50, scope: 'account' },
      note: "OpenRouter's own free cap: 50 requests a day on an unfunded account, 1,000 once $10 of credit has been bought.",
    },
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
    headers: (req) => ({ 'HTTP-Referer': requestOrigin(req), 'X-Title': 'NeuraOS' }),
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
    freeTier: {
      all: true,
      limits: { requestsPerMinute: 40, scope: 'account' },
      note: 'NIM free credits: no card to start, roughly 1,000 inference credits (up to 5,000 on request) -- a balance that runs out, not a daily allowance that resets.',
    },
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
      // Run-by-name, like Workers AI: /genai/<model> serves image models only.
      ownModel: true,
    },
  },
  // Mistral's own API (docs.mistral.ai). The no-card "Experiment" tier on La
  // Plateforme answers every model here, rate-limited well below production
  // use -- Mistral does not publish the exact numbers; an account's own
  // Admin Console -> Limits has the real ceiling. A free key is generated at
  // console.mistral.ai/api-keys. Verified against the live catalogue
  // 2026-09-17: mistral-large-2411, mistral-medium-2508, mistral-small-2506
  // and codestral-25-08 are today's dated ids -- Mistral retires these on its
  // own schedule, so a stale one here just drops out of the intersection
  // with the live GET /v1/models rather than failing on use.
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envVar: 'MISTRAL_API_KEY',
    freeTier: {
      all: true,
      limits: { scope: 'account' },
      note: "Mistral's own no-card Experiment tier. Rate-limited well below production use; exact numbers aren't published.",
    },
    models: [
      'mistral-large-2411',
      'mistral-medium-2508',
      'mistral-small-2506',
      'codestral-25-08',
    ],
  },
  // Groq: free tier with fast inference. API keys at https://console.groq.com/keys
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envVar: 'GROQ_API_KEY',
    freeTier: {
      all: true,
      limits: { requestsPerMinute: 30, requestsPerDay: 14400, scope: 'account' },
      note: "Groq's own free tier: no card, 30 requests/min, 6,000 tokens/min, 14,400 requests/day.",
    },
    // Re-verified 2026-09-17: mixtral-8x7b-32768, gemma2-9b-it and gemma-7b-it
    // are all retired upstream (each was live at an earlier audit, each
    // superseded on Groq's own schedule since). Only these two survive on the
    // live catalogue today; a future retirement here just drops out of the
    // intersection with GET /v1/models rather than failing on use.
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  },
  // OpenAI on a key of your own: chat from the live catalogue, plus the
  // image models no free service carries. gpt-image-1 draws (square,
  // landscape and portrait) and edits through multipart file parts on the
  // images/edits endpoint; OPENAI_IMAGE_MODEL pins a different drawing
  // model the way NARA_IMAGE_MODEL does for Nara. The key is billed, so
  // this provider stays out of the picker until it is set.
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    image: {
      shape: 'openai-images',
      modelEnv: 'OPENAI_IMAGE_MODEL',
      defaultModel: 'gpt-image-1',
      edit: 'multipart',
      sizes: [
        { label: 'Square (1:1)', value: '1024x1024' },
        { label: 'Landscape (3:2)', value: '1536x1024' },
        { label: 'Portrait (2:3)', value: '1024x1536' },
      ],
    },
  },
  // Google Gemini on the free tier, through the v1beta/openai compatibility
  // endpoint: plain OpenAI chat and a model list on GEMINI_API_KEY from
  // aistudio.google.com (no card, daily free quota). No image block: image
  // models are not available on the Gemini API free tier, so there is
  // nothing honest to declare for drawing.
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
  },
  // Cloudflare Workers AI: an official free allowance on every Cloudflare
  // account (10,000 Neurons a day, no card), used with an API token the
  // account owner creates from the "Workers AI" template. Nothing here is
  // borrowed or impersonated.
  //
  // The account id is part of every URL, so the provider needs two variables:
  // CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Chat is OpenAI-compatible
  // under the account's /ai/v1. That path has no GET /models, so the list is
  // pinned (catalogue: false); CLOUDFLARE_MODELS replaces it.
  //
  // Drawing uses Workers AI's own run-by-name endpoint rather than an images
  // API: POST /ai/run/<model> with {prompt, steps}, answered by FLUX.1
  // [schnell] as {result:{image:<base64 JPEG>}}. It is the image service this
  // app tries first, because it is free and needs nothing but the token.
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
    envVar: 'CLOUDFLARE_API_TOKEN',
    // Workers AI answers with at most 256 tokens unless asked for more; a
    // thinking model never gets past its thinking in that.
    defaultMaxTokens: 4096,
    freeTier: {
      all: true,
      limits: { neuronsPerDay: 10000, scope: 'account' },
      note: 'Workers AI free allowance: 10,000 Neurons a day per Cloudflare account, reset daily.',
    },
    accountEnv: 'CLOUDFLARE_ACCOUNT_ID',
    catalogue: false,
    models: [
      '@cf/openai/gpt-oss-120b',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/qwen/qwen2.5-coder-32b-instruct',
      '@cf/qwen/qwq-32b',
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/openai/gpt-oss-20b',
    ],
    image: {
      shape: 'cloudflare-run',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai',
      baseUrlEnv: 'CLOUDFLARE_IMAGES_BASE_URL',
      modelEnv: 'CLOUDFLARE_IMAGE_MODEL',
      defaultModel: '@cf/black-forest-labs/flux-1-schnell',
      ownModel: true,
    },
  },
  // A keyless free tier: a public gateway that answers an OpenAI-shaped
  // catalogue and chat completions with no API key, no signup and no card, on a
  // limit measured per IP rather than per account. (Verified live 2026-09-18:
  // a chat completion with no Authorization header answers 200.)
  //
  // It is here because of what a free tier behind a key actually is: the one
  // that runs out, on the deployment where a variable was never set. A provider
  // that needs no credential cannot be left unconfigured, so the floor under
  // this app stops depending on the operator having done anything at all.
  //
  // Two consequences come with that, and both are the operator's to know rather
  // than this app's to hide. The limit is per IP, and on a container host that
  // IP is the app's own egress address -- every visitor spends the same
  // allowance, and a busy day spends it faster than a quiet one. And a gateway
  // like this may route a prompt to a provider that logs it. Free, keyless and
  // not private: a floor to fall back on, not the pool to live on.
  //
  // Pinned as a plain list rather than an ordering, unlike OmniRoute. Kilo does
  // mark its free ids (`isFree`, and the `:free` suffix), but its own free
  // router is `kilo-auto/free` -- which carries no suffix, so the app-wide
  // "is this free?" rule reads it as paid and a freeOnly gate would drop the
  // one id that does the rotating. Pin what is free; the router inside the
  // list does the rest.
  kilocode: {
    label: 'Kilo Code',
    baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    envVar: 'KILO_API_KEY',
    // Kilo publishes no rate-limit headers at all, so its caps cannot be read
    // off a response. What can be said honestly is what this app can observe:
    // its own count of the calls it made today, which is what /api/llm/providers
    // reports next to this note.
    freeTier: {
      all: true,
      limits: { scope: 'ip' },
      note: 'Free and keyless. Kilo sends no rate-limit headers, so the count here is this app counting its own calls, not the gateway reporting.',
    },
    keyless: true,
    needsKey: false,
    models: [
      // The free router: rotates through Kilo's pool, so one rate-limited
      // upstream does not end the turn. Confirmed answering with no key.
      'kilo-auto/free',
      // The reason this provider is here. Laguna S is Poolside's agentic
      // coding model -- 118B total, 8B active, tool calling, 262K context.
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      'cohere/north-mini-code:free',
      // Context, for the turn that has to read a whole repository.
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'stepfun/step-3.7-flash:free',
      'tencent/hy3:free',
      'google/gemma-4-26b-a4b-it:free',
      'google/gemma-4-31b-it:free',
      'inclusionai/ling-3.0-flash-vl:free',
      'nex-agi/nex-n2.5-pro:free',
      'dots-studio/dots-3-note-preview:free',
      'liquid/lfm-2.5-2.6b:free',
    ],
  },
  // A second keyless official free tier, EU-hosted: OVHcloud's AI Endpoints
  // answer anonymously with no key and no signup at 2 requests a minute per IP
  // per model.
  //
  // That limit is the whole story of this provider and it is why it sits behind
  // Kilo rather than beside it. Measured live on 2026-09-18: one model answered
  // 200, and a handful of requests from a single address was enough to turn the
  // whole endpoint into `429 API rate limit exceeded` for every model, including
  // ones nothing had asked for. Two requests a minute per model is generous for
  // one person and nothing at all for a container host, where the address is
  // shared by every visitor -- so this is a pool to fall back on, never one to
  // rely on. A 429 is handled the way any other is: the turn moves to the next
  // provider with everything it had already collected.
  ovhcloud: {
    label: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    envVar: 'OVHCLOUD_API_KEY',
    // Measured live 2026-09-18: the anonymous tier answers `ratelimit-limit: 2`
    // and `x-ratelimit-limit-minute: 2`, and a single request leaves
    // `remaining: 0` for every model on that address -- so the allowance is per
    // IP and shared across the whole catalogue, not one per model.
    //
    // This declaration is the difference between a picker that lists seven rows
    // priced like paid models and one that says what they are: entitlement, and
    // the two-a-minute allowance that is the real constraint.
    freeTier: {
      all: true,
      limits: { requestsPerMinute: 2, scope: 'ip', shared: true },
      note: 'Free, keyless, and metered per IP: two requests a minute for the whole catalogue, shared by every visitor behind one address.',
    },
    keyless: true,
    needsKey: false,
    models: [
      'Qwen3-Coder-30B-A3B-Instruct',
      'gpt-oss-120b',
      'gpt-oss-20b',
      'Qwen3.5-397B-A17B',
      'Qwen3-32B',
      'Meta-Llama-3_3-70B-Instruct',
      'Mistral-Small-3.2-24B-Instruct',
      // Reads pictures, for the step that reviews a drawing against the request.
      'Qwen2.5-VL-72B-Instruct',
    ],
  },
  // The sibling fact to the block above, and the more surprising one: this
  // service *draws*, and it is the only free image service this app can reach
  // with no key, no signup and no card at all. Verified live 2026-09-18 -- a POST
  // to /v1/images/generations with model `stable-diffusion-xl-base-v10` and no
  // Authorization header answered 200 with a real PNG. Its catalogue publishes
  // exactly one image model, and that is it.
  //
  // It is deliberately *not* declared as an `image` block, so pushing this does
  // not move the draw order under a deployment that already had one. No image
  // block means the keyless guard in imageStoreFor keeps it out of that order
  // until the operator names a model -- and naming one is the entire opt-in:
  //
  //   OVHCLOUD_IMAGE_MODEL=stable-diffusion-xl-base-v10
  //
  // That is the same shape every other keyless service here already has:
  // OmniRoute, the custom slot and FreeGPT4 all stay out of the picker until a
  // variable points at them. One variable buys a free drawer with no key at all.
  //
  // Know what you are buying first. The limit is 2 requests a minute per IP per
  // model, and on a container host that IP is shared by every visitor -- measured
  // live, a handful of requests from a single address turned the whole endpoint
  // into `429` for every model, including ones nothing had asked for. Cloudflare
  // Workers AI is the roomier free drawer (10,000 Neurons a day) and already
  // leads the order; this is what to reach for once Cloudflare's day is spent.
  custom: {
    label: 'Custom endpoint',
    // The sentence the reports show while the slot is still dark. An
    // unconfigured slot with no note reads as a bug; the same slot with the
    // variable named reads as a starting state.
    note: 'Points at any self-hosted OpenAI-compatible gateway — FreeGPT4-WEB-API, Ollama, llama.cpp, vLLM — via CUSTOM_BASE_URL (https://…/v1). Its models load into the picker once the URL answers.',
    // No default address: a self-hosted OpenAI-compatible gateway -- free-one-api,
    // Free-GPT4-WEB-API/g4f, Ollama, llama.cpp, vLLM, or anything serving
    // /models and /chat/completions -- is reached through CUSTOM_BASE_URL,
    // including the /v1 segment when the gateway serves it there. With no
    // pinned list the whole live catalogue goes through in its own order, and
    // CUSTOM_MODELS narrows it the way NARA_MODELS does for Nara.
    baseUrl: '',
    envVar: 'CUSTOM_API_KEY',
    // A key alone means nothing without somewhere to send it, so unlike the
    // keyed providers this one activates on the URL, with the key optional --
    // keyless gateways simply get no auth header rather than a bare "Bearer ".
    needsKey: false,
    needsBaseUrl: true,
  },
  freegpt4: {
    label: 'FreeGPT4',
    // A self-hosted Free-GPT4-WEB-API gateway: plain-text answers over
    // GET /?text=, model ids from GET /models as a bare string array. Not
    // OpenAI-shaped, so it carries its own chat shape (llmChatTextQuery)
    // instead of the shared completions path. Answers arrive whole rather
    // than streamed, from the gateway's configured default model, with no
    // conversation memory -- the trade for free, keyless models.
    baseUrl: '',
    envVar: 'FREEGPT4_API_KEY',
    needsKey: false,
    needsBaseUrl: true,
    chatShape: 'text-query',
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
  // Freebuff (github.com/Quorinex/Freebuff2API) is an OpenAI-compatible proxy
  // in front of Freebuff free coding models. The model list is read live from
  // its /v1/models -- it tracks the upstream free-agent roster, so pinning ids
  // here would rot -- and FREEBUFF_MODELS narrows it the way G4F_MODELS does
  // for gpt4free. It runs as its own Railway service, see
  // deploy/freebuff-railway, and this slot activates on FREEBUFF_BASE_URL,
  // with the /v1 segment added when it is missing. FREEBUFF_API_KEY is only
  // sent when set, matching a proxy deployed with API_KEYS; an open proxy gets
  // no auth header rather than a bare "Bearer ". Chat only: the proxy serves
  // no image endpoint, so no image block is declared.
  freebuff: {
    label: 'Freebuff',
    baseUrl: '',
    envVar: 'FREEBUFF_API_KEY',
    needsKey: false,
    needsBaseUrl: true,
  },
  // gpt4free (github.com/xtekky/gpt4free) runs as the "Interference API": one
  // OpenAI-compatible endpoint in front of a large set of community provider
  // adapters, including media generation. It is declared here because of the
  // half of this app that has no free answer anywhere else -- see the image
  // block below.
  //
  // Declared last on purpose. imageOrderIds walks the named order first and
  // then every other provider that declares an image store, in declaration
  // order -- so this block being the final entry is what puts g4f at the end of
  // the draw order rather than in the middle of it.
  //
  // The honest description of what this is: an aggregator of adapters that talk
  // to services by scraping their web endpoints rather than through a documented
  // API. It is free and keyless, and individual adapters break without notice
  // when the site they read changes. That is exactly why it is last: a service
  // this shape is a better rescue than a first choice, and a failure here costs
  // a round trip rather than a turn.
  g4f: {
    label: 'gpt4free',
    // No default address, like the custom slot: a self-hosted gateway is reached
    // through G4F_BASE_URL, with the /v1 segment added when it is missing.
    baseUrl: '',
    envVar: 'G4F_API_KEY',
    needsKey: false,
    needsBaseUrl: true,
    // A short pinned list rather than the whole live catalogue, which is
    // hundreds of aliases and would fill the picker with names that answer
    // differently every day. An intersection that comes out empty falls back to
    // the service's own catalogue, so a renamed alias degrades to "wrong order"
    // rather than "nothing to pick".
    models: ['gpt-4o-mini', 'gpt-4o', 'deepseek-v3', 'llama-3.3-70b'],
    image: {
      shape: 'openai-images',
      // The model gpt4free routes text-to-image through. `flux` is its own
      // alias, kept stable across releases where the vendor id behind it moves.
      defaultModel: 'flux',
      modelEnv: 'G4F_IMAGE_MODEL',
      // No `edit` is declared, and that is a decision rather than an omission.
      // A service that declares no edit shape is stepped past for an edit, which
      // is the honest answer here: gpt4free's media adapters can edit on some
      // backends and not others, and a declared edit that silently drew something
      // new instead would be a fresh picture presented as a change to yours.
    },
  },
};

// Companion variable names derive from the key variable: NARA_API_KEY pairs
// with NARA_BASE_URL and NARA_MODELS. A key variable that does not end in
// _API_KEY (Hugging Face standardises on HF_TOKEN) must never map onto itself
// -- the replace() would no-op and the key would be read back as the base-URL
// override, sending every request to a host named after the token. A variable
// with neither suffix still gets a sibling rather than itself.
function providerEnvName(envVar, suffix) {
  // CLOUDFLARE_API_TOKEN documents CLOUDFLARE_MODELS and CLOUDFLARE_BASE_URL,
  // so the whole _API_TOKEN tail goes, not just _TOKEN.
  const stem = envVar.replace(/_(API_KEY|API_TOKEN|TOKEN)$/, '');
  return stem === envVar ? envVar + suffix : stem + suffix;
}

// The account a provider's URLs are scoped to (Cloudflare), trimmed, or ''.
function providerAccount(provider) {
  return provider && provider.accountEnv ? String(process.env[provider.accountEnv] || '').trim() : '';
}

// A declared URL with its {account} placeholder filled. A malformed id is
// refused by providerConfig before anything is fetched, so the encoding here
// only matters for a value that was already going to be rejected.
function withAccount(provider, url) {
  if (!url || !String(url).includes('{account}')) return url;
  return String(url).replace('{account}', encodeURIComponent(providerAccount(provider)));
}

function providerIsConfigured(provider) {
  // An explicit off switch, for every provider and not just the keyless ones.
  // A keyless provider is the case that made it necessary: it needs no variable
  // to activate, so there was no variable to remove to deactivate it, and an
  // always-on service on a shared address is a liability rather than a gift --
  // its rate limit is measured against this host's egress IP, so every visitor
  // spends the same allowance. <STEM>_DISABLED=1 is the way out.
  if (/^(1|true|yes|on)$/i.test(String(process.env[providerEnvName(provider.envVar, '_DISABLED')] || '').trim())) return false;
  // A keyless provider answers with no credential at all: an officially free
  // tier reached on the operator's own IP rather than a key. It is configured
  // the moment this build ships, and that is deliberate rather than a
  // convenience -- a free model behind a key is the one that runs out, and a
  // variable that has to be set is the one that is missing on a fresh deploy.
  // It leads the checks below because it is the single case where "nothing is
  // set" and "nothing is configured" are different answers.
  if (provider.keyless) return true;
  // A provider whose URLs name an account is not configured without one: the
  // token alone has nowhere to go.
  if (provider.accountEnv && !providerAccount(provider)) return false;
  // A provider with no default address (the custom endpoint slot) activates
  // on the URL alone: a key with nowhere to send it would only fail at use.
  if (provider.needsBaseUrl) return !!process.env[providerEnvName(provider.envVar, '_BASE_URL')];
  if (process.env[provider.envVar]) return true;
  // Key-optional providers (local servers) opt in with an explicit base URL.
  return provider.needsKey === false && !!process.env[providerEnvName(provider.envVar, '_BASE_URL')];
}

// Providers whose documented base URL stops short of the OpenAI path. The
// OmniRoute gateway accepts "http://host:port" and serves
// /v1/... underneath it, so the version segment is added when it is missing
// rather than making every operator remember to type it. gpt4free is the same
// shape for the same reason: its Interference API is served under /v1 on a
// server that boots on a bare host and port, and "add the version segment" is a
// step nobody remembers on the deploy where it matters.
const V1_APPENDED_PROVIDERS = new Set(['g4f', 'freebuff']);

function normalizeProviderBaseUrl(id, raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/^https?:/i.test(base)) {
    // The scheme came along, but a paste can drop a slash ("http:/host") or
    // shout ("HTTPS://host"). Repair those. Any other scheme passes through
    // untouched and is reported as unusable rather than silently rewritten.
    base = base.replace(/^(https?):\/{1,3}/i, (m, s) => s.toLowerCase() + '://');
  } else if (/^[a-z][a-z0-9+.-]*:\//i.test(base)) {
    // A deliberate non-web scheme; leave it for the provider's own error.
  } else {
    // "host:port" already says where to dial; a bare host means https.
    base = (/^[^/:]+:\d+/.test(base) ? 'http://' : 'https://') + base;
  }
  // A "/models" tail was copied along with the address. It is the endpoint
  // this app appends itself, so it must not become part of the host -- that
  // paste used to die as ERR_INVALID_URL before a byte was ever sent.
  base = base.replace(/\/models\/?$/i, '');
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
  // key-less/local provider keeps its default address.
  const override = process.env[providerEnvName(provider.envVar, '_BASE_URL')];
  const rawBaseUrl = override || withAccount(provider, provider.baseUrl);
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
  const account = providerAccount(provider);
  if (provider.accountEnv && account && !/^[0-9a-f]{32}$/i.test(account)) {
    configured.keyError =
      `${provider.accountEnv} should be the 32-character account id from the ${provider.label} dashboard, not a name or an email. ` +
      `Copy it from the account home page.`;
  }
  if (bad) {
    configured.keyError =
      `${provider.envVar} contains a non-ASCII character '${bad.char}' (U+${bad.code.toString(16).toUpperCase()}) at position ${bad.index}. ` +
      `Keys must be plain ASCII — this usually means placeholder text or a word processor's dash got pasted in. ` +
      `Re-copy the key from its source.`;
  }
  // The same honesty for the address: a base URL that never became a URL
  // would otherwise surface as ERR_INVALID_URL from inside fetch, naming
  // neither the variable nor the shape of the mistake.
  if (!/^https?:\/\//i.test(baseUrl)) {
    configured.baseUrlError =
      `${providerEnvName(provider.envVar, '_BASE_URL')} is "${rawBaseUrl}", which is not a usable web address. ` +
      `Set the full URL, starting with https://.`;
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
  sendJson(res, 200, Object.entries(LLM_PROVIDERS)
    // A service that only draws is not a chat provider, and listing it as one
    // would put a row in the model picker that can only ever answer "this
    // service has no chat API at all". It appears in the image report instead.
    .filter(([, provider]) => provider.kind !== 'image')
    .map(([id, provider]) => ({
    id,
    label: provider.label,
    configured: providerIsConfigured(provider),
    // 'speech' and 'search' services have no chat models. Saying so beats an
    // empty dropdown that looks like a bug.
    kind: provider.kind || 'chat',
    note: provider.note,
    // The two reports the page needs to route rather than guess: what this
    // provider's free tier meters, and what this process has observed of it.
    // Together they are what turns "the turn stalled" into "it was rate limited
    // with 42s left to wait, so the app used another provider instead".
    freeTier: freeTierReport(id, provider),
    health: providerLedgerSnapshot(id),
  })));
}

// The effective response knobs, so Settings can show what the server is
// actually enforcing instead of hardcoding the same numbers twice.
function llmLimits(req, res) {
  const t = providerTimeoutMs();
  sendJson(res, 200, {
    timeouts: { models: t.models, chat: t.chat, headers: t.headers, stall: t.stall },
    retries: {
      maxAttempts: rateLimitMaxAttempts(),
      baseDelayMs: retryBaseDelayMs(),
      // The total a call may spend asleep before a refusal is handed back for
      // another provider to answer. See retryBudgetMs for why an attempt count
      // alone cannot bound this.
      budgetMs: retryBudgetMs(),
    },
    freeTiers: Object.entries(LLM_PROVIDERS)
      .filter(([, provider]) => provider.kind !== 'image' && providerFreeTier(provider))
      .map(([id, provider]) => ({ id, label: provider.label, ...freeTierReport(id, provider) })),
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
        'User-Agent': 'NeuraOS/1.0 (+https://github.com/tradernonymous/freeopenai)',
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
  const results = await searchWebResults(query);
  if (!results.length) return sendJson(res, 502, { error: 'Search is unreachable right now — try again, or paste a link to read directly.' });
  sendJson(res, 200, { query, results });
}

// The search itself, shared by the route above and the build agent.
async function searchWebResults(query) {
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
  return [...ddg, ...wiki, ...full].filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  }).slice(0, 10);
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
  // readPublicPage follows redirects by hand and checks every hop's addresses,
  // so a public page redirecting to an internal one is refused too.
  let page;
  try {
    page = await readPublicPage(parsed.href);
  } catch (e) {
    const message = String((e && e.message) || '');
    if (/not readable from here/.test(message)) return sendJson(res, 403, { error: message });
    if (/too large/.test(message) || /http\(s\)/.test(message)) return sendJson(res, 400, { error: message });
    if (/resolve|too long|Too many redirects/.test(message)) return sendJson(res, 502, { error: message });
    return sendJson(res, 502, { error: 'Could not read that page: ' + message });
  }
  if (!page.text) return sendJson(res, 502, { error: 'Nothing readable on that page' });
  sendJson(res, 200, page);
}

// Zero-key Edge TTS: Microsoft's free text-to-speech service.
// No API key required for basic synthesis. Returns base64-encoded audio.
async function llmTts(req, res) {
  readJsonBody(req, 4 * 1024 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' });
    const voice = body && typeof body.voice === 'string' ? body.voice.trim() : '';
    // Edge TTS endpoint - works without key for common voices
    const ttsUrl = 'https://edge.tts.microsoft.com/cognitiveservices/v1/audio:speak';
    const headers = {
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
      'User-Agent': 'Mozilla/5.0',
    };
    let ssml = '<speak version="1.0" xml:lang="en-US">';
    if (voice) {
      ssml += `<voice name="${voice}">`;
    }
    ssml += prompt;
    if (voice) {
      ssml += '</voice>';
    }
    ssml += '</speak>';
    try {
      const upstream = await fetch(ttsUrl, {
        method: 'POST',
        headers,
        body: ssml,
      });
      if (!upstream.ok) return sendJson(res, upstream.status, { error: 'TTS service failed' });
      const ab = await upstream.arrayBuffer();
      const b64 = Buffer.from(ab).toString('base64');
      sendJson(res, 200, { audio: b64, sampleRate: 16000 });
    } catch (e) {
      sendJson(res, 502, { error: 'TTS request failed: ' + (e && e.message) });
    }
  });
}

// ---------------------------------------------------------------------------
// Shareable read-only conversation links.
//
// A share is the conversation at publish time, frozen: the signed-in owner PUTs
// the transcript to /api/share, gets a random id back, and /s/<id> serves a
// static reader page to anyone with the link -- no login, like /api/health.
//
// The store is capped both by count and, when a file is configured, by bytes.
// By default it lives in memory only: this deployment keeps chats client-side
// by design, and a restart dropping shares reads as an expired link rather
// than as a broken promise. Setting SHARE_STORE_PATH points the same store at
// a JSON file -- loaded at boot, written through a debounced tmp-file rename
// -- so links survive a redeploy, which is what a Railway volume mounts as.
const SHARE_MAX_CONVERSATIONS = 200;
const SHARE_BODY_MAX_CHARS = 400000;
// Both read through functions rather than frozen constants: the value is
// process.env at require time on a real boot, and a test flips the env before
// driving the same code paths. The cap floor is one oversized share plus
// slack, so the byte budget can never make every share unkeepable.
function shareStorePath() {
  return String(process.env.SHARE_STORE_PATH || '').trim();
}

function shareStoreMaxBytes() {
  return Math.min(Math.max(parseInt(process.env.SHARE_STORE_MAX_BYTES, 10) || 2 * 1024 * 1024, SHARE_BODY_MAX_CHARS + 128 * 1024), 64 * 1024 * 1024);
}
const SHARE_STORE_FLUSH_MS = 2000;
const shareStore = new Map();
let shareStoreDirty = false;
let shareStoreTimer = null;
let shareStoreWriting = false;

function loadShareStore() {
  if (!shareStorePath()) return;
  let raw;
  try {
    raw = fs.readFileSync(shareStorePath(), 'utf8');
  } catch {
    return; // first boot, or a volume not mounted yet: start empty
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [id, entry] of Object.entries(parsed)) {
      // Same field-by-field read the publish route does: a hand-edited or
      // half-written file contributes only rows that look like shares.
      if (!/^[a-f0-9]{32}$/i.test(id)) continue;
      if (!entry || !Array.isArray(entry.messages) || !entry.messages.length) continue;
      shareStore.set(id, {
        title: String(entry.title || '').trim().slice(0, 200) || 'Shared chat',
        messages: entry.messages,
        createdAt: Number(entry.createdAt) || 0,
      });
    }
  } catch {
    // A corrupt file reads as no shares rather than as a crash at boot.
  }
}

// One writer at a time; the tmp-file rename is the atomic step, so a crash
// mid-write leaves the previous file intact.
function flushShareStore() {
  if (!shareStorePath() || !shareStoreDirty || shareStoreWriting) return Promise.resolve();
  shareStoreWriting = true;
  shareStoreDirty = false;
  const payload = JSON.stringify(Object.fromEntries(shareStore));
  const tmp = shareStorePath() + '.tmp';
  return new Promise((resolve) => {
    fs.writeFile(tmp, payload, 'utf8', (writeErr) => {
      if (writeErr) {
        shareStoreWriting = false;
        shareStoreDirty = true; // the next change retries; a read-only disk just means memory-only shares
        resolve();
        return;
      }
      fs.rename(tmp, shareStorePath(), (renameErr) => {
        shareStoreWriting = false;
        if (renameErr) shareStoreDirty = true;
        else if (shareStoreDirty) flushShareStore(); // changed while writing
        resolve();
      });
    });
  });
}

function scheduleShareFlush() {
  if (!shareStorePath()) return;
  shareStoreDirty = true;
  if (shareStoreTimer) return;
  shareStoreTimer = setTimeout(() => {
    shareStoreTimer = null;
    flushShareStore();
  }, SHARE_STORE_FLUSH_MS);
  if (typeof shareStoreTimer.unref === 'function') shareStoreTimer.unref();
}

// Count first, then bytes when a file backs the store: the oldest share goes
// until the payload fits. Without a file the count alone is the contract.
function evictSharesToCap() {
  let overflow = shareStore.size - SHARE_MAX_CONVERSATIONS;
  for (let i = 0; i < overflow; i++) shareStore.delete(shareStore.keys().next().value);
  if (!shareStorePath()) return;
  while (shareStore.size && JSON.stringify(Object.fromEntries(shareStore)).length > shareStoreMaxBytes()) {
    shareStore.delete(shareStore.keys().next().value);
  }
}

loadShareStore();

function readShareBody(req, res, cb) {
  let size = 0;
  let dead = false;
  const chunks = [];
  req.on('data', (chunk) => {
    if (dead) return;
    size += chunk.length;
    if (size > SHARE_BODY_MAX_CHARS + 64 * 1024) {
      // Answer with a reason -- not a dropped connection -- and ignore every
      // event after this: the callback must never fire twice.
      dead = true;
      chunks.length = 0;
      sendJson(res, 413, { error: 'Conversation too large to share' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (dead) return;
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (err) {
      cb(err);
    }
  });
  req.on('error', () => {
    if (!dead) cb(new Error('Request failed'));
  });
}

function handleSharePublish(req, res) {
  readShareBody(req, res, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const messages = Array.isArray(body && body.messages) ? body.messages : null;
    if (!messages || !messages.length) return sendJson(res, 400, { error: 'Nothing to share — the conversation is empty' });
    const entry = {
      title: String(body.title || '').trim().slice(0, 200) || 'Shared chat',
      messages,
      createdAt: Date.now(),
    };
    const id = crypto.randomBytes(16).toString('hex');
    shareStore.set(id, entry);
    evictSharesToCap();
    scheduleShareFlush();
    sendJson(res, 200, { id, url: '/s/' + id });
  });
}

function handleShareRevoke(req, res) {
  const id = req.url.slice('/api/share/'.length).split('?')[0];
  if (!shareStore.has(id)) return sendJson(res, 404, { error: 'No share with that link' });
  shareStore.delete(id);
  scheduleShareFlush();
  sendJson(res, 200, { ok: true });
}

function handleShareData(req, res) {
  const id = req.url.slice('/api/share/'.length).split('?')[0];
  const entry = id && shareStore.get(id);
  if (!entry) return sendJson(res, 404, { error: 'No share with that link' });
  sendJson(res, 200, entry, { 'Cache-Control': 'no-store' });
}

function handleShareRead(req, res) {
  const id = req.url.slice('/s/'.length).split('?')[0];
  const entry = id && shareStore.get(id);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Link expired</title><p>This shared chat has expired or was revoked.</p><p><a href="/">Open the app</a></p>');
    return;
  }
  fs.readFile(path.join(rootDir, 'share.html'), (err, html) => {
    if (err) return sendJson(res, 500, { error: 'Share reader missing' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
}

// ---------------------------------------------------------------------------
// Saved memory: small facts the user asked to keep across chats.
//
// The transcript stays client-side, so this endpoint is a tiny clipboard for
// the facts the model wrote through its save_memory tool. Scoped per signed-in
// user (or 'anon' with the gate off), capped, and validated field by field.
const MEMORY_MAX_FACTS = 200;
const memoryStore = new Map();

function memoryKey(req) {
  const user = currentAppUser(req);
  return user ? 'u:' + user : 'anon';
}

function handleMemoryList(req, res) {
  const list = memoryStore.get(memoryKey(req)) || [];
  // max rides along so the page can warn before the next save is refused,
  // instead of the user meeting the cap as a failure.
  sendJson(res, 200, { facts: list, max: MEMORY_MAX_FACTS });
}

function handleMemoryUpsert(req, res) {
  readJsonBody(req, 8192, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const text = String((body && body.text) || '').trim().slice(0, 300);
    if (!text) return sendJson(res, 400, { error: 'text is required' });
    const key = memoryKey(req);
    let list = memoryStore.get(key) || [];
    if (body.replace) {
      list = list.filter((f) => f.text !== text);
    } else if (list.some((f) => f.text === text)) {
      return sendJson(res, 200, { facts: list });
    } else if (list.length >= MEMORY_MAX_FACTS) {
      return sendJson(res, 400, { error: 'Memory is full — remove something first' });
    }
    list.unshift({ text, addedAt: Date.now() });
    memoryStore.set(key, list);
    sendJson(res, 200, { facts: list });
  });
}

function handleMemoryDelete(req, res) {
  readJsonBody(req, 8192, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const key = memoryKey(req);
    const list = memoryStore.get(key) || [];
    if (body.all) {
      memoryStore.set(key, []);
      return sendJson(res, 200, { facts: [] });
    }
    const text = String((body && body.text) || '').trim();
    memoryStore.set(key, list.filter((f) => f.text !== text));
    sendJson(res, 200, { facts: memoryStore.get(key) });
  });
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
// `image` block on LLM_PROVIDERS), and what differs between them is one of two
// request shapes:
//
//   openai-images  {model, prompt, ...} -> {data:[{b64_json|url}]}
//   nvidia-genai   {prompt, ...} -> {artifacts:[{base64}]}
//
// Every answer is normalized to the OpenAI images shape (data[].b64_json), which
// is what the browser already reads -- one reader for every service is one
// place a picture can go missing.
//
// Nara serves images from a host of its own rather than the router that carries
// its chat, which is why a store may declare a base URL of its own and the
// variable that overrides it -- see imageBaseFor below.
//
// The order image requests fall back through, best first. Nara leads because it
// is what this route has always fronted: an operator who has it configured sees
// exactly the behaviour they had, and one who does not gets their next key.
const IMAGE_PROVIDER_ORDER = ['cloudflare', 'nara', 'openrouter', 'nvidia'];

// Which model name to ask for: the request's own, then the operator's variable,
// then the store's default, then one read from the provider's own catalogue (see
// discoverImageModel). A store with no default (Nara, OmniRoute) is
// therefore usable once the operator names a model -- which is the point, since
// nothing here can know what a local server or a gateway has loaded -- or once
// the service publishes one that can be read.
function imageModelFor(store, explicit) {
  const named = String(explicit || '').trim();
  if (named) return named;
  const fromEnv = store.modelEnv ? String(process.env[store.modelEnv] || '').trim() : '';
  if (fromEnv) return fromEnv;
  return String(store.defaultModel || store.discoveredModel || '').trim();
}

// --- Finding an image model a service already publishes ----------------------
//
// Naming <PROVIDER>_IMAGE_MODEL is how every service gained the ability to
// draw, and it asks an operator to know something the service publishes itself:
// the id of its own image model. On a Google key or an Antigravity proxy the
// answer is a model already sitting in that provider's catalogue
// (`gemini-2.5-flash-image`), so the variable is one line of configuration
// between a deployment and a working draw -- and the line nobody knows to write.
//
// So the catalogue is read instead, for the service the conversation is already
// on, and only when that service has no model of its own: a provider whose
// operator named one is never asked, and a provider that answers "none" is not
// asked again for the cache's lifetime.

// What an image model looks like in an id, best first. The order is the ranking:
// `gpt-image-1` beats a model that merely contains "image", and within one rank
// the catalogue's own order wins, which is newest-first nearly everywhere.
const IMAGE_MODEL_MARKERS = [
  'gpt-image', 'dall-e', 'imagen', 'flux', 'stable-diffusion', 'sdxl', 'sd3',
  'seedream', 'ideogram', 'recraft', 'photon', 'nano-banana', 'kolors',
  'qwen-image', 'image',
];

// Words that mean a model reads or indexes pictures rather than making one. A
// vision model is the trap: its id says "image" and its answer is prose.
const IMAGE_MODEL_NOT = [
  'vision', 'vl', 'embed', 'rerank', 'moderation', 'guard', 'caption',
  'whisper', 'tts', 'audio', 'ocr', 'transcri',
];

// The one id in a catalogue that can draw, or ''. Takes ids or model rows.
function imageModelFromCatalogue(models) {
  const ids = (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === 'string' ? m : (m && m.id) || ''))
    .filter(Boolean);
  let best = '';
  let bestRank = Infinity;
  for (const id of ids) {
    const lower = String(id).toLowerCase();
    if (IMAGE_MODEL_NOT.some((word) => lower.includes(word))) continue;
    const rank = IMAGE_MODEL_MARKERS.findIndex((marker) => lower.includes(marker));
    if (rank < 0 || rank >= bestRank) continue;
    best = id;
    bestRank = rank;
  }
  return best;
}

// What a provider's catalogue answered when it was last asked, whether or not it
// had anything: "none" is an answer, and re-reading it on every draw would put a
// round trip in front of every picture. Kept apart from modelCache on purpose --
// that one holds what the *picker* may show, which for a gateway is the
// operator's own allowlist rather than the catalogue, and writing raw catalogue
// ids into it is how a picker ends up showing 2,330 rows.
const imageDiscoveryCache = new Map();

function clearImageDiscoveryCache() {
  imageDiscoveryCache.clear();
}

// '' means "asked, and there was nothing to draw with"; null means "not asked".
// The two are different answers -- one is a reason to stop reading and the other
// is a reason to go and read -- and collapsing them made every draw re-read a
// catalogue that had already answered.
function discoveryFor(id) {
  if (!id) return null;
  const hit = imageDiscoveryCache.get(id);
  if (!hit || Date.now() - hit.fetchedAt >= modelsCacheTtlMs()) return null;
  return hit.model;
}

function discoveredImageModel(id) {
  return discoveryFor(id) || '';
}

// A discovery read is a lookup in front of a picture the user is waiting for, so
// it gets a shorter leash than the picker's own catalogue read: five seconds is
// already a long time for a GET, and the draw behind it is the point of the wait.
const IMAGE_DISCOVERY_TIMEOUT_MS = 5000;

// Read a provider's catalogue for an image model, or ''. Never throws: a service
// that will not answer is a service with no discovered model, which is where
// this route stood before it was asked at all.
async function discoverImageModel(req, id) {
  const provider = LLM_PROVIDERS[id];
  if (!provider) return '';
  const already = discoveryFor(id);
  if (already !== null) return already;
  const store = imageStoreFor(id);
  // A service that already has a model -- its own default or one the operator
  // named -- is not asked: the answer could not change the request, and every
  // draw would pay a round trip for it.
  if (!store || imageModelFor(store, '')) return '';
  // The picker's list is free when it is warm, which on a service the user has
  // been chatting on it usually is.
  const warm = modelCache.get(id);
  if (warm && Date.now() - warm.fetchedAt < modelsCacheTtlMs()) {
    const found = imageModelFromCatalogue(warm.models);
    if (found) {
      imageDiscoveryCache.set(id, { fetchedAt: Date.now(), model: found });
      return found;
    }
  }
  const config = providerConfig(id);
  if (!config || config.keyError || config.baseUrlError) return '';
  let model = '';
  try {
    // Through the *configured* provider, not the declared one: an operator's
    // base URL override is how a proxy or a gateway is reached at all, and the
    // key that reaches its catalogue is the same key that draws.
    const result = await fetchCatalogue(req, config, IMAGE_DISCOVERY_TIMEOUT_MS);
    if (result && result.ok) model = imageModelFromCatalogue(catalogueRows(result.data));
  } catch {
    model = '';
  }
  imageDiscoveryCache.set(id, { fetchedAt: Date.now(), model });
  return model;
}

// A provider's image store: the one it declares, or one derived from a single
// variable for every other provider that speaks OpenAI in and out of the same
// URL.
//
// Only seven providers used to be able to draw at all, and the list was code.
// That left the conversation's own service unable to produce a picture whenever
// it was not one of them -- a Google key, an Antigravity proxy in front of one,
// Mistral, Groq, any OpenAI-shaped gateway -- so a chat could generate images
// only through Puter, in the browser, on the visitor's own account. The service
// in front of the reader was the one thing the route would not ask.
//
// A derived store is not a guess at what a service can do: it exists only once
// the operator has named a model with <PROVIDER>_IMAGE_MODEL, which is the same
// thing they have to do for Nara and OmniRoute. The shape is OpenAI's,
// because that is what "OpenAI-compatible" means, and a service that answers
// its chat on /v1/chat/completions answers /v1/images/generations one level the
// same way -- which is why the chat path's own URL resolution is reused rather
// than a second address declared here.
function imageStoreFor(id) {
  const declared = LLM_PROVIDERS[id];
  if (!declared) return null;
  // A keyless provider declares how it draws, or names a model, or it does not
  // draw at all.
  //
  // The store synthesised further down is what makes "every key draws" true: an
  // operator who set a key expects that key to be able to draw, and naming one
  // more variable finishes the job. A keyless provider has no such operator and
  // no such key -- it is a free chat tier this build enrolled by itself -- so
  // enrolling it as a *drawing* service too would spend a shared per-IP
  // allowance on pictures nobody asked it for, on every deployment, with no
  // action to point at. Naming <PROVIDER>_IMAGE_MODEL turns it into one, and
  // then it is a decision like every other.
  //
  // Kilo is the case this exists for. Its catalogue really does publish image
  // ids -- google/gemini-3.1-flash-image, openai/gpt-5.4-image-2, five more --
  // and every one of them is isFree=false on a keyless account that can only
  // spend the free pool, so discovery would have enrolled it as a drawer whose
  // every answer is 402. It also keeps the catalogue read off the report route:
  // this guard is above the discovery call, so the image report does not go and
  // fetch two more catalogues on every page load it never used to touch.
  if (declared.keyless && !declared.image && !String(process.env[providerEnvName(declared.envVar, '_IMAGE_MODEL')] || '').trim()) return null;
  // A model read from the provider's own catalogue rides on the store, so every
  // reader of "which model would this service draw with" -- the order, the
  // report, the draw -- answers with the same one.
  const discovered = discoveredImageModel(id);
  if (declared.image) return discovered ? { ...declared.image, discoveredModel: discovered } : declared.image;
  // Speech and search services are not image services at any variable: their
  // "models" are transcription and ranking engines, and a key for them is not a
  // drawing key however it is named.
  if (declared.kind && declared.kind !== 'chat') return null;
  const modelEnv = providerEnvName(declared.envVar, '_IMAGE_MODEL');
  const named = String(process.env[modelEnv] || '').trim();
  // A derived store exists once the operator names a model -- or, now that a
  // catalogue can be read, once the service is configured at all: the variable
  // stays the way to pin or override a model, not the only way to have one.
  if (!named && !discovered && !providerIsConfigured(declared)) return null;
  const store = {
    shape: 'openai-images',
    modelEnv,
    baseUrlEnv: providerEnvName(declared.envVar, '_IMAGES_BASE_URL'),
    // A derived service is assumed to take a source picture as file parts, the
    // way OpenAI's own edits endpoint does. A reference field would be
    // OpenRouter's invention, and inventing it for someone else's URL is how a
    // request becomes a 400 nobody can act on.
    edit: 'multipart',
  };
  return discovered ? { ...store, discoveredModel: discovered } : store;
}

// One provider, ready to draw -- or the sentence that says why it cannot.
function imageCandidateFor(id, options) {
  const declared = LLM_PROVIDERS[id];
  const store = imageStoreFor(id);
  if (!store) {
    // A chat provider reaches here only when it has no key: one that is
    // configured has a store now, whether or not it yet has a model, so the
    // missing thing is what it would be drawn with at all.
    if (declared && (!declared.kind || declared.kind === 'chat')) {
      return { error: declared.label + ' is not configured — set ' + declared.envVar + '.' };
    }
    return { error: 'No image service is wired up as "' + id + '".' };
  }
  // providerConfig is what resolves a key and a base URL for the chat path, and
  // an image is billed to the same key: reading the environment a second way
  // here is how a provider that chats fine reports "not configured" for drawing.
  const provider = providerConfig(id);
  if (!provider) return { error: declared.label + ' is not configured — set ' + declared.envVar + '.' };
  if (provider.keyError) return { error: provider.keyError };
  if (provider.baseUrlError) return { error: provider.baseUrlError };
  // The request's own model name is honoured only next to the provider it was
  // meant for. On its own it is whatever the browser last used somewhere else,
  // and an id from another catalogue is a 404 dressed up as a bad request.
  // The chat's model is a *preference* for a service that can already draw,
  // never the thing that makes one able to. A provider with no image model of
  // its own used to become a candidate purely by borrowing the chat's id --
  // so chatting on OmniRoute's `auto/minimax` router sent that id to an
  // images endpoint and spent a round trip being told
  //   400 "Invalid image model: auto/minimax. Use format: provider/model"
  // every single draw. It also made /api/llm/images/providers a liar: it
  // reported OmniRoute as not ready while the draw went on trying it.
  const own = imageModelFor(store, null);
  if (!own) {
    return { error: declared.label + ' has no image model named — set ' + (store.modelEnv || declared.envVar) + '.' };
  }
  //
  // Except on a store whose pictures are run by name on an API that serves
  // nothing else: there the conversation's model is not a weaker choice, it is a
  // request for a text model through an image endpoint, which answers 200 with
  // prose in it -- a failure this route reports as the service not doing the
  // job. The service's own model is the only one that means anything, and an
  // operator can still pin one with <PROVIDER>_IMAGE_MODEL.
  const model = imageModelFor(store, store.ownModel ? '' : (options && options.explicitModel));
  // A key restricted to free models cannot draw here, and asking anyway costs a
  // round trip to be told so. OpenRouter's Image API has no free tier at all --
  // the answer is
  //   402 "Insufficient credits. This account never purchased credits."
  // -- and that is a fact about the account, not this request, so every
  // subsequent attempt gets the same. The free-only switch already means "this
  // key buys nothing"; it now means that for pictures too.
  //
  // OPENROUTER_FREE_ONLY=0 is the way back in for a key with credits on it: the
  // same variable that opens the paid chat catalogue opens drawing.
  //
  // Read from the environment rather than from `declared.freeOnly`, which is
  // evaluated once when this module loads. Whether a provider may draw is a
  // per-request decision, the same as its key and base URL are.
  const freeOnlyVar = providerEnvName(declared.envVar, '_FREE_ONLY');
  if ('freeOnly' in declared && process.env[freeOnlyVar] !== '0') {
    return {
      error: declared.label + ' draws only with purchased credits, and this key is '
        + 'limited to free models. Add credits and set ' + freeOnlyVar + '=0 to draw with it.',
    };
  }
  return { id, store, model, provider };
}

// Every provider that could be asked to draw, in the order they would be tried.
//
// The seven keep their order, which is the one the README documents. A preferred
// provider leads when it can draw -- the conversation's own service is the one
// the user chose, and asking it first is what makes "generate an image" follow
// the model picker instead of a second decision. Behind them come the providers
// whose operator named an image model themselves: one variable away from drawing,
// and so part of "every key draws" rather than services this app has no opinion
// about. Declaration order, so the order is the same on every request.
function imageOrderIds(preferredId) {
  const preferred = String(preferredId || '').trim();
  const built = IMAGE_PROVIDER_ORDER.filter((id) => id !== preferred);
  const extras = Object.keys(LLM_PROVIDERS)
    .filter((id) => id !== preferred && !IMAGE_PROVIDER_ORDER.includes(id) && imageStoreFor(id));
  return [...(preferred && imageStoreFor(preferred) ? [preferred] : []), ...built, ...extras];
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
// configured: an OpenRouter key draws without NARA_API_KEY, an NVIDIA key
// draws without either, and so on down the order.
function imageDrawOrder(requested, options) {
  const settings = options || {};
  const explicitModel = String(settings.explicitModel || '').trim();
  const named = String(requested || process.env.IMAGE_PROVIDER || '').trim();
  if (named) {
    if (!LLM_PROVIDERS[named]) {
      return { error: 'Unknown image provider "' + named + '". Wired up: ' + imageOrderIds('').join(', ') + '.' };
    }
    // A named provider that cannot draw is answered with its own reason rather
    // than "no image provider is ready": an operator who named one asked a
    // question about that one.
    const candidate = imageCandidateFor(named, { explicitModel });
    if (candidate.error) return { error: candidate.error };
    return { candidates: [candidate] };
  }
  const preferred = String(settings.preferredProvider || '').trim();
  const order = imageOrderIds(preferred);
  const candidates = [];
  for (const id of order) {
    // The conversation's model is offered to the provider the conversation is on,
    // and to that one alone: ids come from per-provider catalogues, so an
    // OpenRouter name handed to Nara is a 404 dressed up as a bad request. A
    // provider further down the order draws with its own model.
    const candidate = imageCandidateFor(id, { explicitModel: id === preferred ? explicitModel : '' });
    if (!candidate.error) candidates.push(candidate);
  }
  if (!candidates.length) return { error: imageUnavailableMessage(preferred) };
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
// Every image model this service could be asked for, best first.
//
// A picker that can only offer the one model the server already chose is not a
// picker: on a gateway with several image models (OpenRouter, an OpenAI-shaped
// proxy, a Google key) the choice is real and the user can see it. The list is
// what this service actually has -- its own current model, the operator's
// naming, and whatever its catalogue publishes that can draw -- and never a
// model invented here, because sending an id a service does not serve is how a
// draw fails with someone else's error message.
function imageModelChoices(id, candidate, store) {
  const out = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  };
  push(candidate && candidate.model);
  if (store) {
    push(store.modelEnv ? process.env[store.modelEnv] : '');
    push(store.defaultModel);
    push(store.discoveredModel);
    for (const alt of (Array.isArray(store.models) ? store.models : [])) push(alt);
  }
  const warm = modelCache.get(id);
  if (warm && Array.isArray(warm.models)) {
    const rank = (text) => IMAGE_MODEL_MARKERS.findIndex((marker) => text.toLowerCase().includes(marker));
    const drawable = warm.models
      .map((m) => (typeof m === 'string' ? m : (m && m.id) || ''))
      .filter(Boolean)
      .filter((text) => {
        const lower = text.toLowerCase();
        if (IMAGE_MODEL_NOT.some((word) => lower.includes(word))) return false;
        return rank(text) >= 0;
      })
      // The same ranking discovery uses, so the model the server would pick is
      // the first row of the list rather than a separate opinion.
      .sort((a, b) => rank(a) - rank(b));
    for (const text of drawable) push(text);
  }
  return out.slice(0, 12);
}

function imageProviderRow(id, provider, candidate, store) {
  return {
    id,
    label: provider.label,
    ready: !candidate.error,
    model: candidate.model || '',
    // What the picker offers for this service. `model` stays as the one it is
    // ready to use, so an older client that reads only that is unaffected.
    models: imageModelChoices(id, candidate, store),
    reason: candidate.error || '',
    // Only the store that states its dimensions has any: everywhere else a size
    // is a preference the upstream may or may not know.
    sizes: store ? (store.sizes || []).map((s) => s.value) : [],
    edits: !store ? 'none' : store.edit === 'multipart' ? 'mask' : store.edit === 'references' ? 'reference' : 'none',
  };
}

async function imageProvidersReport(req) {
  // Every provider that would be tried, in order, plus each one's reason when it
  // cannot draw. A configured chat service with no image model of its own is in
  // this list rather than in a section of its own: it is a candidate, and the
  // one variable that makes it ready is named where the reader is already
  // looking for it.
  const ids = [];
  for (const id of imageOrderIds('')) {
    if (LLM_PROVIDERS[id] && imageStoreFor(id)) ids.push(id);
  }
  // Asked before answered, because "not ready" has to mean "its catalogue has
  // nothing to draw with" rather than "nobody has looked yet" -- the first is
  // advice an operator can act on, and the second sends them hunting for a model
  // id they never needed. Concurrent and cached for the catalogue's own
  // lifetime, so this is one round trip per service per TTL, and none of it is
  // on the draw path: the page does not call this route.
  await Promise.all(ids.map((id) => discoverImageModel(req, id)));
  return ids.map((id) => imageProviderRow(id, LLM_PROVIDERS[id], imageCandidateFor(id, {}), imageStoreFor(id)));
}

// What to say when nothing can draw, in the form an operator can act on: every
// provider that could, and the one variable each is missing. Naming only the
// first would send them round the loop one key at a time.
function imageUnavailableMessage(preferredId) {
  const rows = [];
  // The conversation's own service leads when it is the one this request was
  // about. A sentence listing services the operator does not have is advice
  // they cannot take, and it used to never once mention the provider they were
  // chatting on.
  const preferred = String(preferredId || '').trim();
  for (const id of new Set([preferred, ...imageOrderIds('')])) {
    const provider = LLM_PROVIDERS[id];
    if (!provider) continue;
    const declares = !!provider.image;
    // Only the built-in order, plus the one this request named: listing every chat
    // provider's missing variable would turn a sentence into a form.
    if (!declares && id !== preferred) continue;
    // A speech or search service is not a drawing service however it is keyed.
    if (!declares && provider.kind && provider.kind !== 'chat') continue;
    // The same answer imageCandidateFor gives, rather than a second guess at it.
    // Guessing produced "openrouter (set OPENROUTER_IMAGE_MODEL)" for a provider
    // that has a default model and was really being held back by its key being
    // limited to free models -- advice that could not have worked.
    const candidate = imageCandidateFor(id, {});
    if (!candidate.error) continue;
    if (!providerIsConfigured(provider)) rows.push(id + ' (add ' + provider.envVar + ')');
    else rows.push(id + ' (' + candidate.error + ')');
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
  const declared = override || withAccount(provider, store.baseUrl);
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
  // Every candidate stepped past for the one reason that is about the request
  // rather than about a service: this deployment has nothing that takes a source
  // picture. "cannot edit, only generate" says what happened and not what to do
  // about it.
  const editHint = failures.every((f) => f.reason === 'cannot edit, only generate')
    ? ' An edit needs a service that takes the picture being edited: add a key for one (Nara and OpenRouter both do), or turn on “Draw with Puter” to edit it in your browser.'
    : '';
  if (failures.length === 1) return what + ' failed on ' + failures[0].label + ': ' + failures[0].reason + '.' + editHint;
  return (
    what + ' failed on every provider that could draw: ' +
    failures.map((f) => f.label + ' (' + f.reason + ')').join('; ') + '.' + editHint
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
  // A keyless self-hosted gateway (OmniRoute) sends no auth header at all rather than a
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
  // The NVCF shape asks for a shape as `aspect_ratio` rather than a `size`, so
  // it never travelled in `extra` -- and that put it outside the one mechanism
  // that can take a preference back off a request. NVIDIA answered
  //   422 {"type":"extra_forbidden","loc":["body","aspect_ratio"]}
  // and the retry re-sent the field that caused it, every time, for every
  // model. It is a preference like the others and is now treated as one.
  const aspect = aspectForSize(requestedSize);
  // Whether this request carries anything droppable at all, in whichever shape
  // it ends up being sent. `extra` alone was the wrong test: the NVCF attempt
  // passes withExtra=false, so for that shape the aspect is the only preference
  // there has ever been.
  const sentPreference = Object.keys(extra).length > 0 || !!aspect;

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

    if (store.shape === 'cloudflare-run') {
      // Workers AI runs a model by name. FLUX.1 [schnell] takes a prompt and a
      // step count (at most 8; 4 is its documented default) and nothing else,
      // so sizes and counts are not sent at all rather than refused upstream.
      return [() => postJson(base + '/run/' + useModel, { prompt, steps: 4 }, false)];
    }
    if (store.shape === 'nvidia-genai') {
      return [
        (withExtra) => {
          // The hosted FLUX models: {prompt} in, {artifacts:[{base64}]} out.
          const body = { prompt, mode: 'base' };
          if (withExtra && aspect) body.aspect_ratio = aspect;
          if (withExtra && extra.n > 1) body.n = extra.n;
          return postJson(base + '/genai/' + useModel, body, false);
        },
        // A self-hosted visual-genai NIM documents an OpenAI-compatible images
        // API instead of that shape, so a 404 moves here.
        openaiAttempt('/images/generations'),
      ];
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
  // Which model produced the answer, as opposed to the one asked for first: the
  // ladder below may have moved on to the provider's own image model, and a
  // response that names the chat model as the one that drew is wrong about the
  // one fact it carries.
  let usedModel = models[0];
  for (let index = 0; index < models.length; index++) {
    usedModel = models[index];
    const attempts = attemptsFor(models[index]);
    const send = async (withExtra) => {
      for (const attempt of attempts) {
        response = await attempt(withExtra);
        if (response.status !== 404) return;
      }
    };
    await send(true);
    // 422 alongside 400: a FastAPI-shaped service -- which NVIDIA's is, hence
    // the pydantic `extra_forbidden` in its body -- reports an unknown field as
    // Unprocessable Entity rather than Bad Request. Only 400 was checked, so the
    // one service that most needed this retry never got it.
    if (sentPreference && response && (response.status === 400 || response.status === 422)) {
      // A 400 is never billed, which is what makes this second attempt free. The
      // first answer is the one kept when the second fails too: dropping a
      // preference answers "was it the preference?", and when the answer is no, the
      // sentence worth reporting is the refusal the service actually wrote.
      const carried = [...Object.keys(extra), ...(aspect ? ['aspect_ratio'] : [])].join(', ');
      console.warn('image ' + kind + ': ' + provider.label + ' refused a request carrying ' + carried + ' — retrying without them');
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

  // Bytes or JSON, whichever this service answers with: a service may return
  // the picture itself rather than a document that carries it.
  const mediaType = String(response.headers.get('content-type') || '').split(';')[0].trim();
  const notes = sizeForService.note ? [sizeForService.note] : [];
  if (/^image\//i.test(mediaType)) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      model: usedModel,
      notes,
      data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: bytes.toString('base64'), media_type: mediaType }] },
    };
  }
  const payload = await response.json().catch(() => null);
  // The NVCF shape ({artifacts:[{base64}]}) is normalized here rather than at
  // the caller, so there is one place a picture could be misread.
  if (payload && !payload.data && payload.result && typeof payload.result.image === 'string' && payload.result.image) {
    // Workers AI: {result:{image:<base64>}}. FLUX.1 [schnell] answers JPEG.
    return { status: response.status, model: usedModel, notes, data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: payload.result.image, media_type: 'image/jpeg' }] } };
  }
  if (payload && !payload.data) {
    const artifact = Array.isArray(payload.artifacts) ? payload.artifacts[0] : null;
    if (artifact && artifact.base64) {
      return { status: response.status, model: usedModel, notes, data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: artifact.base64, media_type: 'image/png' }] } };
    }
  }
  return { status: response.status, model: usedModel, notes, data: payload };
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
  // Redirects are followed by hand so every hop's addresses are checked again.
  let current = new URL(raw);
  let fetched = null;
  for (let hop = 0; hop < 5 && !fetched; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`Invalid ${label} image — expected a data URL or an http(s) link.`);
    }
    let addresses;
    try {
      addresses = await lookupAllAddresses(current.hostname);
    } catch {
      throw new Error(`Could not resolve the host for that ${label} image`);
    }
    if (!addresses.length || addresses.some(isNonPublicAddress)) {
      throw new Error(`That ${label} image address is not readable from here`);
    }
    const res = await fetch(current.href, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) current = new URL(location, current);
    else fetched = res;
  }
  if (!fetched) throw new Error(`Too many redirects for that ${label} image`);
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
    const preferred = String(body.preferProvider || '').trim();
    // Before the order is built, because a service that publishes an image model
    // in its own catalogue can draw without the operator naming one -- the
    // difference between a Google key or a proxy making a picture and being told
    // to set a variable for a model it already publishes. Cached either way, and
    // skipped for a service that has a model of its own.
    //
    // Whichever provider this request singles out: the one it named, the one the
    // conversation is on, or the one the deployment pinned. Discovering for the
    // preferred service only would make naming one a worse way to ask than
    // preferring it.
    const lead = String(body.provider || preferred || process.env.IMAGE_PROVIDER || '').trim();
    if (lead) await discoverImageModel(req, lead);
    const order = imageDrawOrder(body.provider, {
      explicitModel: body.model,
      preferredProvider: preferred,
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
    // Two clocks, not one. The budget is how long the whole request may take;
    // the slice is how long any one service gets before the walk moves on.
    // Sharing a single deadline across the order meant one unreachable
    // service -- a gateway behind a dead tunnel, a model that never answers --
    // consumed the whole budget, so every service after it went unasked and
    // the user was told "no image service answered", which named nobody and
    // was not true of the ones that were never tried.
    const budget = providerTimeoutMs().chat;
    // The slice protects the *other* services' turns. When only one service
    // can draw at all -- which is the ordinary case on free keys -- there is
    // nothing to protect it from, and capping it at the slice would fail a
    // request that had thirty unused seconds left in it.
    const slice = order.candidates.length > 1
      ? Math.min(providerTimeoutMs().image, budget)
      : budget;
    const deadline = Date.now() + budget;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    const failures = [];
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
      const notes = [];
      for (const candidate of order.candidates) {
        // An edit needs a service that can be handed the picture being edited --
        // as file parts, a reference URL, or an input beside the words. One that
        // generates and nothing else would draw a new picture from the words
        // alone and have it presented as the change that was requested, so it is
        // stepped past with the reason said instead.
        if (kind === 'edits' && !['multipart', 'references', 'parts'].includes(candidate.store.edit)) {
          failures.push({ label: candidate.provider.label, reason: 'cannot edit, only generate', status: 400 });
          continue;
        }
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
        // Don't start a service that cannot finish: a slice of a second or two
        // buys an abort rather than an answer, and saying so is more use than
        // one more timed-out row.
        const left = deadline - Date.now();
        if (left < 3000) {
          failures.push({
            label: candidate.provider.label,
            reason: 'not tried - the request ran out of time before reaching it',
            status: 504,
          });
          break;
        }
        const perCandidate = new AbortController();
        const onAbort = () => perCandidate.abort();
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const sliceTimer = setTimeout(() => perCandidate.abort(), Math.min(slice, left));
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
            signal: perCandidate.signal,
          });
        } catch (e) {
          // The whole request is out of time: stop, and let the catch below
          // report it with everything that was tried on the way.
          if (e && e.name === 'AbortError' && controller.signal.aborted) throw e;
          if (e && e.name === 'AbortError') {
            failures.push({
              label: candidate.provider.label,
              reason: 'did not answer within ' + Math.round(Math.min(slice, left) / 1000) + 's',
              status: 504,
            });
            continue;
          }
          // A socket failure is a fact about this service -- a host that does
          // not resolve, a port with nothing behind it -- and the next provider
          // is a real chance of a picture, so this is recorded and stepped past.
          failures.push({ label: candidate.provider.label, reason: e.message + fetchFailureReason(e) });
          continue;
        } finally {
          clearTimeout(sliceTimer);
          controller.signal.removeEventListener('abort', onAbort);
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
              // The model that drew, not the one the request opened with.
              model: drawn.model || candidate.model,
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
        const tried = failures.length
          ? ' Tried: ' + failures.map((f) => f.label + ' (' + f.reason + ')').join('; ') + '.'
          : '';
        return sendJson(res, 504, {
          error:
            what + ' ran out of time after ' + Math.round(budget / 1000) +
            's — a service was slow or unreachable, not your prompt.' + tried +
            ' Try again.',
          tried: failures.map((f) => f.label),
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
async function llmImageProviders(req, res) {
  const providers = await imageProvidersReport(req);
  sendJson(res, 200, {
    // Puter is not a server provider -- it draws in the browser on the visitor's
    // own account -- so it is reported here only so the picker can offer it in
    // the same list, and marked as what it is.
    browser: { id: 'puter', label: 'Puter', ready: false, note: 'Draws in your browser, billed to your Puter account when signed in.' },
    providers,
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

// Retryable statuses are one thing; the *words* are another. A hosting edge
// answers with its own sentence when its router cannot reach the container,
// and that sentence is the single most useful fact in the whole failure: the
// provider's own API never answered, so nothing about the request is wrong.
function isEdgeFailureMessage(message) {
  return /application failed to respond|no healthy upstream|upstream connect error|upstream request timeout/i.test(
    String(message || ''),
  );
}

function describeProviderError(status, data, provider) {
  const who = provider && provider.label ? provider.label : 'The provider';
  // Cloudflare's API wraps failures as {errors:[{code, message}]}.
  const envelope = data && Array.isArray(data.errors) && data.errors[0] ? data.errors[0] : null;
  const raw = data && (data.error || data.message || data.detail || envelope);
  let message = '';
  if (typeof raw === 'string') message = raw;
  else if (raw && typeof raw === 'object') message = raw.message || raw.code || JSON.stringify(raw);
  if (!message && data && typeof data === 'object') message = JSON.stringify(data).slice(0, 300);
  // A gateway error upstream usually arrives with no body, or an HTML one that
  // failed to parse. "request failed" told the user nothing, least of all
  // which of several configured providers had stalled.
  if (!message && status >= 500) message = `${who} returned a gateway error with no detail`;

  // A 502 that carries the edge's own words is about the deployment, not the
  // provider's capacity, so it gets its own sentence. The distinction is the
  // one that costs people the most time: "slow or unreachable" sends them to
  // check a provider that was never asked, while "nothing is listening on the
  // port this address names" points at the service's own settings.
  if ((status === 502 || status === 503) && isEdgeFailureMessage(message)) {
    return (
      `${status}: ${message} — the host's own router answered, not ${who}: nothing is listening on the port this address names, ` +
      'or that service is still starting. Check its logs and its PORT.'
    );
  }

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
    // What one image service gets before the walk moves on. Separate from
    // the whole request's budget on purpose: they used to be the same clock,
    // so the first service to hang spent every other service's time too.
    image: num(process.env.PROVIDER_TIMEOUT_IMAGE_MS, 22000),
    headers: num(process.env.PROVIDER_TIMEOUT_HEADERS_MS, 25000),
    stall: num(process.env.PROVIDER_STALL_MS, 60000),
  };
}

// Most use "Authorization: Bearer <key>", but not all: Deepgram wants
// "Token", AssemblyAI wants the bare key, You.com wants its own header,
// and a keyless self-hosted gateway (OmniRoute) sends no auth header at all rather
// than a bare "Bearer ".
function providerAuthHeaders(provider, req) {
  const extra = typeof provider.headers === 'function' ? provider.headers(req) : {};
  const headerName = provider.authHeader || 'Authorization';
  const scheme = provider.authScheme === undefined ? 'Bearer' : provider.authScheme;
  const auth = provider.key ? { [headerName]: scheme ? `${scheme} ${provider.key}` : provider.key } : {};
  return { ...auth, 'Content-Type': 'application/json', ...extra };
}

async function providerFetch(req, provider, path, init = {}, budgetMs = 0) {
  // A caller that knows this answer is worth less than the wait -- discovery in
  // front of a draw -- passes its own budget. Everyone else gets the picker's.
  const budget = budgetMs > 0 ? budgetMs : path.includes('chat') ? providerTimeoutMs().chat : providerTimeoutMs().models;
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
    // Read the body as text first, then parse: a body that is not JSON still
    // has words in it, and for a gateway behind a host's own edge those words
    // are the only diagnosis there is. Railway answers 502 "Application failed
    // to respond" when its router cannot reach the container, which is a
    // completely different problem from the gateway answering an error -- and
    // res.json() consumes the stream, so a failed parse used to throw that
    // sentence away and report "no detail" instead.
    let data = null;
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    if (bodyText) {
      try {
        data = JSON.parse(bodyText);
      } catch {
        // A failure's HTML page becomes one readable line rather than a wall of
        // markup, named after the provider it came from, because the message
        // built from it is the only place that fact appears. A *successful*
        // status with an unreadable body stays null on purpose: an answer this
        // app cannot parse is not an answer, and reporting it as one would be a
        // success it cannot stand behind.
        data = res.ok
          ? null
          : {
              error: `${provider.label}: ${bodyText
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 300)}`,
            };
      }
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
    // A keyless provider is one the operator runs themselves: the OmniRoute
    // gateway. There is no "their side" to blame and no key to check,
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

// Model lists are read from the provider at runtime rather than hardcoded, so
// they can't go stale and a renamed model can't silently break a request.
async function llmModels(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('provider');
  const provider = providerConfig(id);
  if (!provider) return sendJson(res, 400, { error: 'Unknown or unconfigured provider' });
  // A corrupt key would let the picker list models that can only fail on
  // send. Say why instead: the error names the variable and the character.
  if (provider.keyError) return sendJson(res, 400, { error: provider.keyError });
  if (provider.baseUrlError) return sendJson(res, 400, { error: provider.baseUrlError });
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
    return sendJson(res, 200, catalogueRowsForClient(id, provider, ids));
  }
  const ttl = modelsCacheTtlMs();
  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    // Annotated per request rather than cached: the free-tier label is settled,
    // but the observed latency behind a row moves, and a cached number would be
    // stale exactly when it is being used to choose.
    return sendJson(res, 200, catalogueRowsForClient(id, provider, cached.models));
  }
  try {
    const result = await fetchCatalogue(req, provider);
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
          return sendJson(res, 200, catalogueRowsForClient(id, provider, pinned));
        }
      }
      // Name the paths that were read. A gateway that answered nothing on its
      // deduplicated path *and* nothing on the plain one is a different problem
      // from one that never answered at all, and this message is the only place
      // that difference can reach whoever has to fix it.
      const where = result.fallbackUsed
        ? ` (read ${provider.modelsPath} and /models; neither answered)`
        : ` (read ${result.path || '/models'})`;
      return sendJson(res, status, { error: describeProviderError(status, data, provider) + where });
    }
    // Deduplicated here as well as at the source: a gateway version that ignores
    // `?prefix=alias` answers with both ids for one model, and one model shown
    // twice in a picker reads as a bug in this app rather than in the gateway.
    const models = collapseAliasedIds(catalogueRows(data, provider));
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
    // Free is a question about entitlement wherever the provider declares its
    // free tier, and about price everywhere else. isFreeModelId is only the
    // second half of that rule, which is how a keyless tier's priced catalogue
    // used to be filtered away entirely.
    if (provider.freeOnly) listed = listed.filter((m) => modelIsFreeOnProvider(provider, m));
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
        const free = models.filter((m) => modelIsFreeOnProvider(provider, m));
        if (free.length) listed = free;
      }
      // A declared list (PROVIDER_MODELS) that matches nothing is a typo or a
      // list left behind by an older gateway, and it used to land straight on
      // "serve the whole catalogue" -- which is how an OmniRoute picker came
      // to show 2,330 ids in the gateway's own order, with the build's own
      // ordering and its paid-model filter both silently skipped. The build's
      // own list is a far better answer than the raw catalogue, so try it
      // before giving up on ordering altogether.
      const builtIn = LLM_PROVIDERS[id] && LLM_PROVIDERS[id].models;
      if (!listed.length && builtIn && builtIn !== provider.models) {
        listed = Array.isArray(builtIn)
          ? builtIn.map((wanted) => models.find((m) => matchListEntry(m, wanted))).filter(Boolean)
          : selectAllowedModels(models, builtIn);
      }
      if (!listed.length && models.length) listed = models;
      if (!listed.length && Array.isArray(provider.models)) {
        listed = provider.models.map((id) => ({ id })).filter((m) => m && m.id);
      }
      // The same rescue for the other shape of allowlist. A rules object whose
      // `exact` list matched nothing -- every named id retired upstream, or a
      // catalogue that answered with a shape nothing here recognised -- used to
      // reach the client as an empty 200, which it renders as "this provider
      // returned no chat models" and blames the provider for. Serving the named
      // ids bare costs nothing when the catalogue is empty: they are what the
      // operator asked for, and a pickable id that fails on use is a better
      // answer than a picker with no rows and no reason.
      if (!listed.length && provider.models && Array.isArray(provider.models.exact)) {
        listed = provider.models.exact.map((id) => ({ id })).filter((m) => m && m.id);
      }
    }
    // Only a successful, non-empty answer is worth caching; errors rust
    // nothing, and an empty list would outlive the upstream hiccup that
    // caused it, pinning "no models" for the cache's whole lifetime.
    if (listed.length) modelCache.set(id, { fetchedAt: Date.now(), models: listed });
    sendJson(res, 200, catalogueRowsForClient(id, provider, listed));
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
// Puter's catalogue, for a client that talks to Puter itself.
//
// Puter answers in the browser on the visitor's own allowance, so this server
// never proxies it and has no provider row for it. The Android app reaches it
// through a hidden WebView (puter-bridge.html), and this is where it reads the
// list of models to offer -- the same curated list the web page uses, so the
// two cannot drift apart.
function llmPuterModels(req, res) {
  sendJson(res, 200, {
    provider: 'puter',
    label: 'Puter (your account)',
    defaultModel: DEFAULT_MODEL,
    models: MODELS.map((m) => ({ id: m.id, name: m.name, description: m.desc || '' })),
  });
}

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

// A provider's model catalogue, with one tolerance the OmniRoute gateway needs.
//
// A gateway's catalogue path is not this app's to fix. `?prefix=alias` was
// verified against OmniRoute 0.7.x and upstream is past 3.8.x, and the versions
// in between added providers, retired others, and changed how the list is
// deduplicated. A build pinned to one version's query string answers an empty
// picker on another -- and "OmniRoute cannot load models" is exactly what that
// looks like from the outside, with nothing anywhere saying that a query
// parameter was the reason.
//
// So the declared path is tried first, and plain /models is tried when the
// declared one does not answer *as a catalogue*. The order matters: the
// declared path is the one an operator configured, so it wins whenever it
// works, and the fallback only ever rescues a request that would otherwise have
// come back empty.
//
// The fallback is deliberately narrow, because a retry on every failure is how
// a second round trip gets spent on problems a different path cannot fix. Only
// two answers are signatures of version drift: a 404, which is a path the
// gateway does not serve, and a 200 carrying nothing this app can read as a
// catalogue. A 401 or 403 is about the key, a 5xx is about the gateway's state,
// and a 400 is the gateway rejecting the request for its own reasons -- all
// three get the same answer from the other path, so none of them pays for it.
//
// Which path answered rides back with the result. That is the fact that tells
// an operator their gateway ignored a parameter rather than being unreachable
// -- two failures with the same message and completely different fixes.
// --- Free tiers -------------------------------------------------------------
//
// Which models a provider will serve without being paid for, and what it meters
// while it does. This exists because "is it free?" cannot be answered from a
// price. OVHcloud publishes per-token prices for a funded account and still
// answers on a keyless anonymous tier, so its whole catalogue read as paid: the
// picker offered those rows with no free label, ranked them last, and said
// nothing about the two-requests-a-minute allowance that is the only thing
// standing between the user and a stalled turn.
//
// A declaration wins over the price. Everything not declared here keeps the
// price-based rule, including its documented assumption about a catalogue that
// publishes no prices at all.
function providerFreeTier(provider) {
  return provider && provider.freeTier && typeof provider.freeTier === 'object' ? provider.freeTier : null;
}

// "2/min · per IP", "10,000 neurons/day" -- one short line for a picker row.
function freeTierLimitText(tier) {
  const limits = (tier && tier.limits) || {};
  const parts = [];
  if (limits.requestsPerDay) parts.push(Number(limits.requestsPerDay).toLocaleString('en-US') + '/day');
  if (limits.requestsPerMinute) parts.push(limits.requestsPerMinute + '/min');
  if (limits.neuronsPerDay) parts.push(Number(limits.neuronsPerDay).toLocaleString('en-US') + ' neurons/day');
  // A tier with no published numbers still has a scope, and saying so beats an
  // empty label: "metered per IP" is the whole reason Kilo's pool is shared by
  // every visitor behind one address.
  if (limits.scope === 'ip') parts.push(parts.length ? 'per IP' : 'metered per IP');
  else if (limits.scope === 'account' && !parts.length) parts.push('metered per account');
  else if (!parts.length) parts.push('metered');
  if (limits.shared) parts.push('shared');
  return parts.join(' · ');
}

function freeTierCovers(tier, modelId) {
  if (!tier) return false;
  if (tier.all) return true;
  const id = String(modelId || '');
  const wanted = Array.isArray(tier.models) ? tier.models : [];
  // Three shapes, because three are what providers actually use: a bare `:free`
  // or `-free` is a suffix, `*` is a wildcard anywhere in the pattern, and
  // anything else is an exact id. Deliberately not a regex: the patterns here
  // are ids, and an id with a bracket in it should not become a pattern.
  return wanted.some((pattern) => {
    const text = String(pattern || '');
    if (!text) return false;
    if (text.startsWith(':') || text.startsWith('-')) return id.endsWith(text);
    if (text.includes('*')) {
      let from = 0;
      for (const part of text.split('*').filter((p) => p !== '')) {
        const at = id.indexOf(part, from);
        if (at === -1) return false;
        from = at + part.length;
      }
      return true;
    }
    return id === text;
  });
}

// Free is a question about entitlement, not price, wherever a provider declares
// its free tier. Everywhere else the price-based rule stands.
function modelIsFreeOnProvider(provider, model) {
  const tier = providerFreeTier(provider);
  if (tier && freeTierCovers(tier, model && model.id)) return true;
  return isFreeModelId(model && model.id);
}

// The catalogue rows as the picker should see them: free-ness settled by the
// provider's own declaration where there is one, the tier's limits spelled out,
// and the observed time for that model when this process has measured it.
// Fresh objects every time, because the list itself is cached and a cached
// latency reading would be a lie exactly when it mattered.
function annotateCatalogueRows(providerId, provider, rows) {
  const tier = providerFreeTier(provider);
  const limitText = tier ? freeTierLimitText(tier) : '';
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const free = modelIsFreeOnProvider(provider, row);
    const observedMs = providerModelLatency(providerId, row.id);
    const annotated = { ...row };
    if (free) annotated.free = true;
    if (free && limitText) annotated.limits = limitText;
    if (free && tier && tier.note) annotated.limitsNote = tier.note;
    if (observedMs !== null) annotated.observedMs = observedMs;
    return annotated;
  });
}

// The rows a response should carry: annotated with what the provider's free tier
// covers, and -- when FREE_MODELS_ONLY=1 asks for it -- filtered to those rows at
// the source, for a consumer that is not this page. The filter itself is
// chatlib's freeRowsOnly, the same function the picker calls, so "free only" and
// its "never filter down to nothing" rule exist once rather than twice. The
// variable is off by default: a provider the operator pays for is not a mistake.
function catalogueRowsForClient(providerId, provider, listed) {
  const rows = annotateCatalogueRows(providerId, provider, listed);
  if (String(process.env.FREE_MODELS_ONLY || '') !== '1') return rows;
  return freeRowsOnly(rows).rows;
}

// What the page needs to say about a provider's free tier without repeating the
// declaration: the limits in words, the note, and today's share of a cap the
// provider keeps.
function freeTierReport(providerId, provider) {
  const tier = providerFreeTier(provider);
  if (!tier) return null;
  const limits = tier.limits || {};
  const snapshot = providerLedgerSnapshot(providerId);
  const callsToday = snapshot ? snapshot.callsToday : 0;
  const cap = Number(limits.requestsPerDay) || null;
  return {
    limits,
    text: freeTierLimitText(tier),
    note: tier.note,
    scope: limits.scope,
    callsToday,
    cap,
    share: cap ? Math.min(1, callsToday / cap) : null,
  };
}

// A catalogue is read from a path this app chose for itself, and that path is
// the most version-sensitive thing in this file: OmniRoute's deduplicating
// `?prefix=alias` was verified against 0.7.x while upstream is past 3.8.x.
//
// Two failures follow from that, and one loop covers both. A gateway that no
// longer knows a parameter answers 404; one whose own edge dislikes the request
// answers a gateway error -- the same 502 a host's router sends when it cannot
// place a request at all, which is usually over by the next one. So the
// configured path is tried, a gateway error that came back *quickly* gets one
// more attempt at that same path (a slow one is an outage, and asking again just
// doubles the wait), and anything except a complaint about the key moves on to
// the plain path, which is what rules the query string out.
//
// A 401 or 403 stops there on purpose: a key is wrong on every path, so it does
// not pay for a second request. Only the catalogue is ever read twice -- a chat
// turn has nowhere else to go.
const CATALOGUE_RETRY_STATUSES = new Set([502, 503, 504]);
const CATALOGUE_RETRY_BUDGET_MS = 8000;
const CATALOGUE_FAST_FAILURE_MS = 2000;

// Read at call time so a test can shrink it, like every other wait in here.
function catalogueRetryDelayMs() {
  const n = Number(process.env.CATALOGUE_RETRY_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 600;
}

// Whether another path could plausibly answer where this one did not. A key
// complaint cannot be fixed by a different path, and neither can a rate limit.
function cataloguePathIsSuspect(result) {
  if (result.ok) return true; // a 200 that carried nothing readable is a shape problem
  return result.status === 404 || result.status >= 500;
}

async function fetchCatalogue(req, provider, budgetMs = 0) {
  const declared = provider.modelsPath || '/models';
  const paths = declared === '/models' ? [declared] : [declared, '/models'];
  const usable = (result) => result.ok && catalogueRows(result.data).length;
  let first = null;
  // Whether the second path was actually read, which is what the failure message
  // reports: a 401 that stopped at the first path must not claim both were tried.
  let triedOther = false;
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (index > 0) triedOther = true;
    const startedAt = Date.now();
    let result = await providerFetch(req, provider, path, {}, budgetMs);
    if (CATALOGUE_RETRY_STATUSES.has(result.status) && Date.now() - startedAt < CATALOGUE_FAST_FAILURE_MS) {
      await sleep(catalogueRetryDelayMs() + Math.floor(Math.random() * 400));
      const second = await providerFetch(
        req,
        provider,
        path,
        {},
        Math.min(budgetMs > 0 ? budgetMs : providerTimeoutMs().models, CATALOGUE_RETRY_BUDGET_MS),
      );
      // The first answer is the one worth reporting if both failed: it is what
      // the configured path said, and it is not a status this attempt invented.
      if (second.ok) result = second;
    }
    if (usable(result)) return { ...result, path, fallbackUsed: index > 0 };
    if (index === 0) first = result;
    if (!cataloguePathIsSuspect(result)) break;
  }
  // Neither path answered. Report the configured one, since that is whose
  // parameter the operator would change, and say both were read.
  return {
    ...(first || { ok: false, status: 502, data: { error: { message: 'no catalogue' } } }),
    path: declared,
    fallbackUsed: triedOther,
  };
}

// A gateway can publish one model twice: once under an alias namespace and once
// under the canonical provider one. OmniRoute documents a `cc/x` alias beside
// its `x`, which is why this app asks for the deduplicated catalogue in the
// first place -- but a gateway version that ignores that parameter hands back
// both, and a picker showing the same model twice is a bug report waiting to
// happen.
//
// The rule is deliberately narrow: an aliased row is dropped only when another
// row carries the same tail after its *own* namespace, and the canonical row is
// the survivor. Collapsing on the tail alone would take `openai/gpt-4` for
// `azure/gpt-4` -- different vendors, not aliases at all -- so the alias
// namespace has to be what identifies the duplicate. Keeping the canonical id
// also keeps the pinned list working, since that is written in canonical ids.
const CATALOGUE_ALIAS_NAMESPACES = ['cc/'];

function collapseAliasedIds(models) {
  const rows = Array.isArray(models) ? models : [];
  const isAlias = (id) => CATALOGUE_ALIAS_NAMESPACES.some((prefix) => String(id).startsWith(prefix));
  if (!rows.some((m) => m && isAlias(m.id))) return rows;
  const canonicalTails = new Set(
    rows
      .filter((m) => m && typeof m.id === 'string' && !isAlias(m.id))
      .map((m) => m.id.slice(m.id.indexOf('/') + 1)),
  );
  return rows.filter((m) => {
    const id = m && typeof m.id === 'string' ? m.id : '';
    const prefix = CATALOGUE_ALIAS_NAMESPACES.find((p) => id.startsWith(p));
    // An alias with nothing canonical behind it survives: dropping it would
    // remove a model the gateway serves rather than a duplicate of one.
    return !prefix || !canonicalTails.has(id.slice(prefix.length));
  });
}

// The rows in whatever shape a catalogue arrived in.
//
// OpenAI-compatible providers wrap the catalogue in { data: [...] }, but the
// wire occasionally disagrees -- a bare array, or Ollama-style
// { models: [...] }. Reading any of those beats reading the answer as nothing,
// which used to flow on as an empty 200 and the client's "this provider returned
// no chat models". One reader, because the picker and the image route's
// discovery both have to understand the same provider.
function catalogueRows(data) {
  let rows = [];
  if (data && Array.isArray(data.data)) rows = data.data;
  else if (data && Array.isArray(data.models)) rows = data.models;
  else if (Array.isArray(data)) rows = data;
  return rows
    // A catalogue can be a bare string array (Free-GPT4-WEB-API answers
    // /models with ["gpt-4", ...]). Those become bare ids; anything else
    // without one is still dropped rather than served unaddressable.
    .filter((m) => m && (m.id || (typeof m === 'string' && m.trim())))
    .map((m) => (typeof m === 'string' ? { id: m.trim() } : normalizeProviderModel(m)));
}

function normalizeProviderModel(m) {
  const architecture = m.architecture || {};
  const id = m.id;
  const inputModalities = m.input_modalities || architecture.input_modalities;
  return {
    id,
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

// Text out of OpenAI-shaped message content: plain strings pass through,
// part arrays contribute their text parts. Images are reported rather than
// silently dropped -- a text-only gateway must never swallow a picture.
function textQueryParts(content) {
  if (typeof content === 'string') return { text: content, hasImage: false };
  if (!Array.isArray(content)) return { text: '', hasImage: false };
  const texts = [];
  let hasImage = false;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.type === 'image_url' || part.type === 'image') hasImage = true;
  }
  return { text: texts.join('\n'), hasImage };
}

// Free-GPT4-WEB-API speaks plain text over GET /?text=, not OpenAI chat
// completions: one stateless turn, no tools, no vision, no streaming. The
// last user message goes out; the raw text comes back wrapped in the OpenAI
// shape the client already parses, so nothing downstream changes --
// including the stream path, which receives one SSE frame plus DONE.
async function llmChatTextQuery(req, res, id, provider, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const { text, hasImage } = textQueryParts(lastUser && lastUser.content);
  if (hasImage) {
    return sendJson(res, 400, { error: provider.label + ' answers text only and cannot see attached images. Pick a vision model for this turn.' });
  }
  if (!text.trim()) return sendJson(res, 400, { error: provider.label + ' needs a text message to send.' });
  const url = provider.baseUrl.replace(/\/+$/, '') + '/?text=' + encodeURIComponent(text);
  let result;
  try {
    result = await fetchProviderWithRetry(id, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), providerTimeoutMs().chat);
      try {
        const upstream = await fetch(url, { signal: controller.signal, headers: providerAuthHeaders(provider, req) });
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          return { ok: false, status: upstream.status, data: { error: { message: errText.slice(0, 300) || ('HTTP ' + upstream.status) } } };
        }
        return { ok: true, status: 200, data: { text: await upstream.text() } };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return { ok: false, status: 504, selfTimeout: true, data: { error: { message: provider.label + ' did not respond in time' } } };
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }, { model: body.model });
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
  if (!result.ok) {
    return sendJson(res, result.status, { error: describeProviderError(result.status, result.data, provider) });
  }
  const answer = result.data && typeof result.data.text === 'string' ? result.data.text : '';
  if (!answer.trim()) {
    return sendJson(res, 502, { error: provider.label + ' accepted the request but sent nothing readable back. Try again, or pick another model.' });
  }
  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: answer } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  sendJson(res, 200, { choices: [{ message: { role: 'assistant', content: answer } }] });
}

function llmChat(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('provider');
  const provider = providerConfig(id);
  if (!provider) return sendJson(res, 400, { error: 'Unknown or unconfigured provider' });
  if (provider.keyError) return sendJson(res, 400, { error: provider.keyError });
  if (provider.baseUrlError) return sendJson(res, 400, { error: provider.baseUrlError });
  readJsonBody(req, 1024 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    if (!body || !body.model || !Array.isArray(body.messages)) {
      return sendJson(res, 400, { error: 'model and messages are required' });
    }
    if (provider.chatShape === 'text-query') return llmChatTextQuery(req, res, id, provider, body);
    // An output limit only where the provider's own default is too small to
    // hold an answer: Workers AI stops at 256 tokens unless told otherwise,
    // which a reasoning model spends entirely on thinking, so the reply that
    // reached the page was a cut-off thought and no answer. Elsewhere the
    // provider's default stands, since a limit above a model's ceiling is an
    // error on some of them.
    const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0
      ? Math.floor(body.max_tokens)
      : (provider.defaultMaxTokens || 0);
    const upstreamBody = JSON.stringify({
      model: body.model,
      messages: body.messages,
      ...(body.tools ? { tools: body.tools } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
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
        }, { model: body.model });
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
        }), { model: body.model }
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
  // Vendored ES modules (mermaid) load through dynamic import(), which the
  // browser refuses unless the MIME type is a JavaScript one -- octet-stream
  // answers fail the module load with no further explanation.
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // The types a command in the server workspace is likely to produce. A file
  // served as octet-stream still downloads, but it downloads as a nameless blob
  // -- and "generate a PDF and hand it to the user" is the thing this was built
  // for, so the PDF has to arrive as a PDF.
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
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

// --- The server workspace: where a command can actually run ---
//
// The scratch space the model keeps notes in is browser-local on purpose, so it
// cannot be the place a script runs: a command needs a real filesystem. This is
// that filesystem, a directory beside the app, and it is the one capability in
// this app that can do something the user cannot take back -- so it is off
// until the operator asks for it, twice.
//
// WORKSPACE_RUN=1 says the operator wants it at all, which keeps a push from
// quietly turning a deployment into a shell. The second condition is the one
// that matters: the app must already have a login. `isAuthenticated` treats an
// app with no accounts configured as open to everyone, so on an open deployment
// this route would hand a shell to anybody who has the URL, and the container
// environment holds the operator's provider keys.
const WORKSPACE_RUN_DIR = 'workspace';
const WORKSPACE_RUN_DEFAULT_TIMEOUT_MS = 120000;
const WORKSPACE_RUN_MAX_TIMEOUT_MS = 600000;
const WORKSPACE_RUN_MAX_COMMAND_CHARS = 8000;
const WORKSPACE_RUN_MAX_OUTPUT_CHARS = 32000;
const WORKSPACE_RUN_MAX_FILES = 200;

// What a command is allowed to see of the container's environment. Deliberately
// a list of keys the process itself needs -- a shell, a cache directory, a
// locale -- and never a pattern match, because the environment this is filtered
// from holds the operator's provider keys, the GitHub token and the session
// secret, and a model-authored script that prints `process.env` would post them
// somewhere. NODE_OPTIONS and LD_PRELOAD are absent for the same reason: either
// one is a way to run code *around* the command that was approved.
const RUN_ENV_KEYS = [
  'PATH', 'LANG', 'LC_ALL', 'TZ', 'TEMP', 'TMP',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
];

function workspaceRunRoot(root) {
  return path.join(root, WORKSPACE_RUN_DIR);
}

// Why running is off, or an empty string when it is on. Two reasons rather than
// one boolean, because they need different fixes and a refusal that does not say
// which one is a refusal the operator cannot act on.
function workspaceRunRefusal(env) {
  if (String((env && env.WORKSPACE_RUN) || '').trim() !== '1') {
    return 'Running commands is off on this server. Set WORKSPACE_RUN=1 to enable it.';
  }
  if (getConfiguredAccounts(env || {}).length === 0) {
    return 'Running commands needs a login to be configured first: with no accounts set, every visitor would get a shell on this container.';
  }
  return '';
}

function workspaceRunTimeoutMs(env) {
  const wanted = Math.round(Number((env && env.WORKSPACE_RUN_TIMEOUT_MS) || 0));
  if (!Number.isFinite(wanted) || wanted <= 0) return WORKSPACE_RUN_DEFAULT_TIMEOUT_MS;
  return Math.min(WORKSPACE_RUN_MAX_TIMEOUT_MS, Math.max(1000, wanted));
}

function runEnvironment(env, home) {
  const out = {};
  for (const key of RUN_ENV_KEYS) {
    const value = env && env[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  // A cache directory inside the workspace, not the operator's home: npm, pip
  // and git all write here, and this directory is the one this app owns.
  out.HOME = home;
  out.USERPROFILE = home;
  return out;
}

function capRunOutput(text, limit = WORKSPACE_RUN_MAX_OUTPUT_CHARS) {
  const value = String(text == null ? '' : text);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

// Where in the workspace a command may run. Anything that resolves outside it is
// refused rather than clamped: `cwd: '../..'` from a model is a mistake or an
// attempt, and neither one should be answered by quietly running somewhere else.
function resolveWorkspaceCwd(root, rel) {
  const wanted = String(rel == null ? '' : rel).trim();
  if (!wanted || wanted === '.' || wanted === './') return root;
  const resolved = path.resolve(root, wanted);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// Everything under the workspace, so what a command produced is visible to the
// model that ran it and downloadable by the user who approved it. Sorted, so a
// second run reads as a change rather than a reshuffle.
function listWorkspaceFiles(root, limit = WORKSPACE_RUN_MAX_FILES) {
  const out = [];
  const walk = (dir, prefix) => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        out.push({ path: rel, bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      } catch { /* vanished between the listing and the stat */ }
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// A shell command is a tree: the timeout has to reach the child the shell
// started, not just the shell, or a killed `npm test` leaves its runner behind
// holding the port and the CPU it was told to release.
function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function runWorkspaceCommand({ command, cwd, env, timeoutMs, extraEnv }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...runEnvironment(env, cwd), ...(extraEnv || {}) },
      windowsHide: true,
      // Its own process group, so the kill below reaches the whole tree.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const finish = (extra) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, durationMs: Date.now() - started, ...extra });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    // An unrunnable command is an answer, not an exception: the model reads the
    // reason and corrects itself, which it cannot do from a 500.
    child.on('error', (error) => finish({ exitCode: null, stderr: stderr + String((error && error.message) || error) }));
    child.on('close', (code) => finish({ exitCode: typeof code === 'number' ? code : null }));
  });
}

// One command at a time. A shell that hung -- an install waiting on the network
// -- would otherwise let the model stack up four more of them behind it.
let workspaceRunBusy = false;

function handleWorkspaceRun(req, res, root) {
  const refusal = workspaceRunRefusal(process.env);
  if (refusal) return sendJson(res, 403, { error: refusal, enabled: false });
  readJsonBody(req, 128 * 1024, async (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const command = String((body && body.command) || '').trim();
    if (!command) return sendJson(res, 400, { error: 'command is required' });
    if (command.length > WORKSPACE_RUN_MAX_COMMAND_CHARS) {
      return sendJson(res, 400, { error: 'That command is too long (' + command.length + ' characters).' });
    }
    const gitRefusal = refusedGit(command);
    if (gitRefusal) return sendJson(res, 400, { error: 'Refused: ' + gitRefusal });
    // git acts as the GitHub account the user connected, the same way a build's
    // does; the token never appears in the command or its output.
    const git = /\bgit\b/.test(command) ? buildRequestContext(req).git : null;
    const runRoot = workspaceRunRoot(root);
    try {
      fs.mkdirSync(runRoot, { recursive: true });
    } catch (error) {
      return sendJson(res, 500, { error: 'The workspace could not be created: ' + error.message });
    }
    const cwd = resolveWorkspaceCwd(runRoot, body && body.cwd);
    if (!cwd) return sendJson(res, 400, { error: 'cwd has to stay inside the workspace.' });
    if (workspaceRunBusy) {
      return sendJson(res, 429, { error: 'A command is already running. Wait for it to finish.' });
    }
    workspaceRunBusy = true;
    try {
      const result = await runWorkspaceCommand({
        command,
        cwd,
        env: process.env,
        timeoutMs: workspaceRunTimeoutMs(process.env),
        extraEnv: gitRunEnv(git),
      });
      const token = git && git.token;
      const stdout = capRunOutput(scrubToken(result.stdout, token));
      const stderr = capRunOutput(scrubToken(result.stderr, token));
      sendJson(res, 200, {
        enabled: true,
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        cwd: path.relative(runRoot, cwd) || '.',
        // Named because it decides the syntax: a heredoc works in bash and not in
        // cmd, and a model that knows which one it is writing for gets it right
        // the first time instead of reading a parse error and starting again.
        shell: process.platform === 'win32' ? 'cmd' : 'bash',
        stdout: stdout.text,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text,
        stderrTruncated: stderr.truncated,
        files: listWorkspaceFiles(runRoot),
      });
    } finally {
      workspaceRunBusy = false;
    }
  });
}

// Answered whether or not running is enabled, because a surface that can list
// what a command produced has to be able to say why it is not listing anything.
function handleWorkspaceFiles(req, res, root) {
  const refusal = workspaceRunRefusal(process.env);
  const runRoot = workspaceRunRoot(root);
  const files = refusal ? [] : listWorkspaceFiles(runRoot);
  sendJson(res, 200, { enabled: !refusal, reason: refusal, dir: WORKSPACE_RUN_DIR, files });
}

// --- The server workspace as files the page's tools can act on ---
//
// In Build mode the page's workspace tools point here instead of at the
// browser, so the file the model writes is the file its command runs and git
// commits. Same gate as the shell (WORKSPACE_RUN plus a login), same folder,
// same rules as a build: nothing outside it, nothing in .git, no .env.
const WORKSPACE_FILE_MAX_BYTES = 512 * 1024;
const WORKSPACE_READ_MAX_CHARS = 120000;

function workspaceFileTarget(root, wanted) {
  const runRoot = workspaceRunRoot(root);
  try { fs.mkdirSync(runRoot, { recursive: true }); } catch { /* reported by the caller's read or write */ }
  const target = resolveInside(runRoot, wanted);
  if (!target || target === runRoot) return { error: 'path has to name a file inside the workspace.' };
  const rel = path.relative(runRoot, target).split(path.sep).join('/');
  const blocked = protectedPath(rel);
  if (blocked) return { error: blocked };
  return { runRoot, target, rel };
}

function handleWorkspaceRead(req, res, root) {
  const refusal = workspaceRunRefusal(process.env);
  if (refusal) return sendJson(res, 403, { error: refusal });
  const wanted = new URL(req.url, 'http://x').searchParams.get('path') || '';
  const where = workspaceFileTarget(root, wanted);
  if (where.error) return sendJson(res, 400, { error: where.error });
  let stat;
  try { stat = fs.statSync(where.target); } catch { return sendJson(res, 404, { error: 'No such file in the workspace: ' + where.rel }); }
  if (!stat.isFile()) return sendJson(res, 400, { error: where.rel + ' is a folder, not a file.' });
  const text = fs.readFileSync(where.target, 'utf8');
  if (text.includes('\0')) return sendJson(res, 415, { error: where.rel + ' is not a text file.' });
  const content = text.length > WORKSPACE_READ_MAX_CHARS ? text.slice(0, WORKSPACE_READ_MAX_CHARS) + '\n…[' + (text.length - WORKSPACE_READ_MAX_CHARS) + ' more characters]' : text;
  sendJson(res, 200, { path: where.rel, content, chars: text.length, bytes: stat.size });
}

function handleWorkspaceSearch(req, res, root) {
  const refusal = workspaceRunRefusal(process.env);
  if (refusal) return sendJson(res, 403, { error: refusal });
  const params = new URL(req.url, 'http://x').searchParams;
  const query = String(params.get('query') || '');
  if (!query.trim()) return sendJson(res, 400, { error: 'query is required' });
  const runRoot = workspaceRunRoot(root);
  const target = resolveInside(runRoot, params.get('path') || '.');
  if (!target) return sendJson(res, 400, { error: 'path has to stay inside the workspace.' });
  let matcher = null;
  if (params.get('regex') === '1') {
    try { matcher = new RegExp(query, 'i'); } catch (err) { return sendJson(res, 400, { error: 'That regular expression is not valid: ' + err.message }); }
  }
  const found = fs.existsSync(target) ? searchFolder(runRoot, target, { query, matcher, glob: params.get('glob') || '' }) : { matches: [], files: 0, truncated: false };
  sendJson(res, 200, found);
}

function handleWorkspaceFileChange(req, res, root) {
  const refusal = workspaceRunRefusal(process.env);
  if (refusal) return sendJson(res, 403, { error: refusal });
  // A JSON body on every change, so a cross-site form cannot make one: an HTML
  // form cannot send application/json, and DELETE cannot be a form at all.
  if (req.method === 'DELETE') {
    const wanted = new URL(req.url, 'http://x').searchParams.get('path') || '';
    const where = workspaceFileTarget(root, wanted);
    if (where.error) return sendJson(res, 400, { error: where.error });
    let stat;
    try { stat = fs.statSync(where.target); } catch { return sendJson(res, 404, { error: 'No such file in the workspace: ' + where.rel }); }
    if (!stat.isFile()) return sendJson(res, 400, { error: where.rel + ' is a folder; delete files one at a time.' });
    fs.unlinkSync(where.target);
    return sendJson(res, 200, { path: where.rel, deleted: true });
  }
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return sendJson(res, 415, { error: 'Send JSON (Content-Type: application/json).' });
  readJsonBody(req, WORKSPACE_FILE_MAX_BYTES + 64 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const where = workspaceFileTarget(root, body && body.path);
    if (where.error) return sendJson(res, 400, { error: where.error });
    const exists = fs.existsSync(where.target);
    let before = '';
    if (exists) {
      try {
        if (!fs.statSync(where.target).isFile()) return sendJson(res, 400, { error: where.rel + ' is a folder.' });
        before = fs.readFileSync(where.target, 'utf8');
      } catch (error) { return sendJson(res, 500, { error: 'Could not read ' + where.rel + ': ' + error.message }); }
    }
    let after;
    let replaced = 0;
    if (req.method === 'PUT') {
      if (typeof (body && body.content) !== 'string') return sendJson(res, 400, { error: 'content must be the whole file as a string.' });
      after = body.content;
    } else {
      if (!exists) return sendJson(res, 404, { error: 'No such file in the workspace: ' + where.rel + '. Write it first.' });
      const oldText = String((body && body.old_text) == null ? '' : body.old_text);
      const newText = String((body && body.new_text) == null ? '' : body.new_text);
      if (!oldText) return sendJson(res, 400, { error: 'old_text is required: the exact text to replace.' });
      const count = before.split(oldText).length - 1;
      if (count === 0) return sendJson(res, 409, { error: 'old_text was not found in ' + where.rel + '. Read the file and copy the text exactly.' });
      if (count > 1 && !(body && body.all)) return sendJson(res, 409, { error: 'old_text appears ' + count + ' times in ' + where.rel + '. Include more surrounding lines so it is unique, or set all to true.' });
      replaced = body && body.all ? count : 1;
      after = body && body.all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
    }
    if (Buffer.byteLength(after, 'utf8') > WORKSPACE_FILE_MAX_BYTES) return sendJson(res, 413, { error: 'Files over ' + (WORKSPACE_FILE_MAX_BYTES / 1024) + ' KB are not written this way; use run_command.' });
    try {
      fs.mkdirSync(path.dirname(where.target), { recursive: true });
      fs.writeFileSync(where.target, after);
    } catch (error) { return sendJson(res, 500, { error: 'Could not write ' + where.rel + ': ' + error.message }); }
    sendJson(res, 200, { path: where.rel, bytes: Buffer.byteLength(after, 'utf8'), created: !exists, replaced });
  });
}

function handleWorkspaceFile(req, res, root) {
  const refusal = workspaceRunRefusal(process.env);
  if (refusal) return sendJson(res, 403, { error: refusal });
  const wanted = new URL(req.url, 'http://x').searchParams.get('path') || '';
  const runRoot = workspaceRunRoot(root);
  const file = resolveWorkspaceCwd(runRoot, wanted);
  if (!file || file === runRoot) return sendJson(res, 400, { error: 'path has to name a file inside the workspace.' });
  fs.promises.readFile(file).then((data) => {
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': 'attachment; filename="' + path.basename(file).replace(/"/g, '') + '"',
    });
    res.end(data);
  }).catch(() => sendJson(res, 404, { error: 'No such file in the workspace.' }));
}

// --- Remote build sessions ---
//
// The engine lives in agent-sessions.js; what is here is only what it needs from
// this server: which configured provider and model to drive, how to call it, and
// the web search, page reader and command runner the rest of the app already
// trusts. Builds happen in workspace/builds/<id>, beside the workspace the run
// route uses, so a build's output can be downloaded the same way.

// Tried in order when neither the request nor BUILD_AGENT_PROVIDER names one.
// Coding-capable models with native tool calls first; an empty model means the
// provider's first listed model.
const BUILD_MODEL_PREFERENCE = [
  ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct'],
  ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  ['openrouter', ''],
  ['nara', ''],
  ['custom', ''],
];

function providerModelIds(models) {
  if (Array.isArray(models)) return models.filter((m) => typeof m === 'string' && m);
  if (models && Array.isArray(models.exact)) return models.exact.filter((m) => typeof m === 'string' && m);
  return [];
}

function buildCapableProvider(id) {
  const provider = providerConfig(id);
  if (!provider || provider.keyError || provider.baseUrlError) return null;
  if (provider.chatShape === 'text-query' || (provider.kind && provider.kind !== 'chat')) return null;
  return provider;
}

function pickBuildModel(requested = {}) {
  const wantProvider = String(requested.provider || process.env.BUILD_AGENT_PROVIDER || '').trim();
  const wantModel = String(requested.model || process.env.BUILD_AGENT_MODEL || '').trim();
  if (wantProvider) {
    const provider = buildCapableProvider(wantProvider);
    if (!provider) return null;
    const model = wantModel || providerModelIds(provider.models)[0];
    return model ? { provider: wantProvider, model } : null;
  }
  for (const [id, preferred] of BUILD_MODEL_PREFERENCE) {
    const provider = buildCapableProvider(id);
    if (!provider) continue;
    const ids = providerModelIds(provider.models);
    const model = preferred && (!ids.length || ids.includes(preferred)) ? preferred : ids[0];
    if (model) return { provider: id, model };
  }
  return null;
}

// One non-streaming turn. A 400/422 while tools were offered is reported as a
// possible tools refusal, which the engine answers by switching to tool calls
// written as JSON -- the free models this app runs on often reject `tools`.
async function callBuildModel({ provider: id, model, messages, tools, ctx }) {
  const provider = buildCapableProvider(id);
  if (!provider) return { ok: false, error: 'The ' + id + ' provider is not configured on this server any more.' };
  const body = JSON.stringify({ model, messages, ...(tools ? { tools } : {}), temperature: 0.2 });
  const pseudoReq = { headers: (ctx && ctx.headers) || {} };
  const result = await fetchProviderWithRetry(id, () =>
    providerFetch(pseudoReq, provider, '/chat/completions', { method: 'POST', body }), { model },
  );
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: describeProviderError(result.status, result.data, provider),
      toolsRejected: !!tools && (result.status === 400 || result.status === 422),
    };
  }
  const choice = result.data && Array.isArray(result.data.choices) ? result.data.choices[0] : null;
  if (!choice || !choice.message) return { ok: false, error: provider.label + ' answered without a message.' };
  return { ok: true, message: choice.message };
}

// What a model call needs from the request that started the build: the origin
// headers some providers attribute traffic with. Never the cookie.
function buildRequestContext(req, repo) {
  const pick = ['host', 'x-forwarded-proto', 'x-forwarded-host'];
  const headers = {};
  for (const key of pick) if (req.headers[key]) headers[key] = String(req.headers[key]);
  // The GitHub account a build's git commands run as, decided once, here,
  // while the request that started the build is still in hand. The token
  // stays in the session's memory: it is never in an event, a view or a file.
  let git = null;
  const gh = getGithubSession(req);
  if (gh) {
    const picked = pickAccount(gh, repo || '', null);
    const account = picked.account || (accountsOf(gh)[0] || null);
    if (account && account.token) git = { token: account.token, login: account.login || '' };
  }
  return { headers, git };
}

// What a build's git needs to act as the connected account: a credential for
// github.com and an identity for commits, both as git configuration passed in
// the environment, so the token is never in the command line or a file. Only
// commands that mention git get it; every other command sees nothing.
function gitRunEnv(git) {
  if (!git || !git.token) return {};
  const login = String(git.login || 'neuraos').replace(/[^A-Za-z0-9-]/g, '') || 'freeai4u';
  const pairs = [
    ['url.https://x-access-token:' + git.token + '@github.com/.insteadOf', 'https://github.com/'],
    ['user.name', login],
    ['user.email', login + '@users.noreply.github.com'],
    ['credential.helper', ''],
  ];
  const env = { GIT_CONFIG_COUNT: String(pairs.length), GIT_TERMINAL_PROMPT: '0' };
  pairs.forEach(([key, value], i) => {
    env['GIT_CONFIG_KEY_' + i] = key;
    env['GIT_CONFIG_VALUE_' + i] = value;
  });
  return env;
}

// `git config -l` and a failed clone both print the remote URL, token and all.
function scrubToken(text, token) {
  if (!token || !text) return text;
  return String(text).split(token).join('***');
}

// Addresses a build must never read: everything isPrivateIp covers, plus the
// IPv6 local ranges, IPv4-mapped private addresses and carrier-grade NAT.
function isNonPublicAddress(addr) {
  const value = String(addr || '').toLowerCase();
  if (!value || isPrivateIp(value)) return true;
  if (value === '::' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped && isPrivateIp(mapped[1])) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(value);
  if (v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127) return true;
  return false;
}

function lookupAllAddresses(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, list) => (err ? reject(err) : resolve((list || []).map((a) => a.address))));
  });
}

// Read a public page for the build agent. Redirects are followed by hand so each
// hop's host is checked again -- a public URL that redirects to 169.254.169.254
// is the classic way past a check made only on the first address.
async function readPublicPage(raw) {
  let current;
  try {
    current = new URL(String(raw || '').trim());
  } catch {
    throw new Error('A valid http(s) url is required');
  }
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('Only http(s) pages can be read');
    let addresses;
    try {
      addresses = await lookupAllAddresses(current.hostname);
    } catch {
      throw new Error('Could not resolve that host');
    }
    if (!addresses.length || addresses.some(isNonPublicAddress)) throw new Error('That address is not readable from here');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'NeuraOS/1.0 (+https://github.com/tradernonymous/freeopenai)', Accept: 'text/html,*/*' },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      if (html.length > WEB_FETCH_MAX_BYTES) throw new Error('That page is too large to read here');
      const { title, text } = extractPageText(html);
      return { url: current.href, title, text: text.slice(0, 8000) };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The page took too long to answer');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects');
}

// Instant push for a build waiting on its owner, so an approval shows up even
// with the app fully closed -- the SSE stream in agent-sessions.js already
// covers an open app instantly, so this only has to matter when that stream
// is not running. Entirely optional: FCM_SERVICE_ACCOUNT is the service
// account JSON a free Firebase project issues; unset, this parses to null and
// every call below is a silent no-op. See fcm-push.js for why this needs no
// firebase-admin package. Read fresh per call, like every other provider's
// env var here, rather than cached once at startup.
function configuredFcmAccount() {
  return parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT);
}

/** Device tokens per signed-in username, in memory only -- like every other
 * piece of build state, this does not need to survive a redeploy: a device
 * re-registers the next time its app opens. Multiple tokens per user covers
 * more than one phone signed into the same account. */
function createPushRegistry() {
  const tokensByUser = new Map();
  return {
    register(username, token) {
      if (!username || !token) return;
      if (!tokensByUser.has(username)) tokensByUser.set(username, new Set());
      tokensByUser.get(username).add(token);
    },
    unregister(username, token) {
      tokensByUser.get(username)?.delete(token);
    },
    tokensFor(username) {
      return [...(tokensByUser.get(username) || [])];
    },
  };
}

const pushRegistry = createPushRegistry();

/** The notifyOwner build sessions call. Fire-and-forget by contract (see
 * agent-sessions.js's notify()): a stale token is dropped from the registry
 * so it stops being tried, anything else is swallowed -- a push failing must
 * never surface as a build failing. */
function notifyOwnerByPush(owner, notification) {
  const account = configuredFcmAccount();
  if (!account) return;
  for (const token of pushRegistry.tokensFor(owner)) {
    sendPush(account, token, notification).catch((err) => {
      if (err && err.staleToken) pushRegistry.unregister(owner, token);
    });
  }
}

function handlePushRegister(req, res) {
  const owner = currentAppUser(req);
  if (!owner) return sendJson(res, 401, { error: 'Not signed in' });
  readJsonBody(req, 4096, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const token = String((body && body.token) || '').trim();
    if (!token || token.length > 4096) return sendJson(res, 400, { error: 'token is required' });
    pushRegistry.register(owner, token);
    sendJson(res, 200, { ok: true, configured: !!configuredFcmAccount() });
  });
}

function handlePushUnregister(req, res) {
  const owner = currentAppUser(req);
  if (!owner) return sendJson(res, 401, { error: 'Not signed in' });
  readJsonBody(req, 4096, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    pushRegistry.unregister(owner, String((body && body.token) || '').trim());
    sendJson(res, 200, { ok: true });
  });
}

function createBuildStore(root) {
  return createBuildSessions({
    rootDir: workspaceRunRoot(root),
    pickModel: pickBuildModel,
    callModel: callBuildModel,
    runRefusal: () => workspaceRunRefusal(process.env),
    runCommand: async ({ command, cwd, git }) => {
      const result = await runWorkspaceCommand({
        command,
        cwd,
        env: process.env,
        timeoutMs: workspaceRunTimeoutMs(process.env),
        extraEnv: gitRunEnv(git),
      });
      const token = git && git.token;
      return { ...result, stdout: scrubToken(result.stdout, token), stderr: scrubToken(result.stderr, token) };
    },
    webSearch: async (query) => ({ results: await searchWebResults(String(query).slice(0, 300)) }),
    webFetch: readPublicPage,
    notifyOwner: notifyOwnerByPush,
  });
}

// --- Design tab: systematic graphic design workspace ---
// In-memory store for design projects and brand profiles.
// A real deploy would back this with SQLite or the GitHub tools;
// this is the working prototype layer for the Design tab.
const designProjects = new Map();
const designBrandProfiles = new Map();

const DESIGN_TEMPLATES = [
  { id: 'a4-document', label: 'A4 Document', category: 'document', width: 210, height: 297, unit: 'mm', description: 'Print-ready A4 document with title page, TOC, body pages, and export to PDF/PPTX.' },
  { id: 'social-post', label: 'Social Media Post', category: 'social', width: 1080, height: 1080, unit: 'px', description: 'Square post optimized for Twitter/LinkedIn/Instagram with brand palette and typography.' },
  { id: 'web-landing', label: 'Web Landing Page', category: 'web', width: 1440, height: 900, unit: 'px', description: 'Responsive landing page prototype with hero, features, and CTA sections.' },
  { id: 'deck', label: 'Presentation Deck', category: 'deck', width: 1280, height: 720, unit: 'px', description: '16:9 slide deck with title, bullet, image, and divider layouts; exports to PPTX/PDF.' },
  { id: 'infographic', label: 'Infographic', category: 'infographic', width: 1200, height: 1800, unit: 'px', description: 'Vertical infographic with timeline, stats, and icon flow; exports to PNG/SVG/PDF.' },
];

function designTemplates(req, res) {
  sendJson(res, 200, DESIGN_TEMPLATES);
}

function designListProjects(req, res) {
  const user = currentAppUser(req);
  const list = [];
  for (const [id, project] of designProjects) {
    if (!user || project.owner === user) list.push({ id, ...project });
  }
  sendJson(res, 200, list);
}

function designCreateProject(req, res) {
  readJsonBody(req, 512 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const name = String((body && body.name) || '').trim();
    const template = String((body && body.template) || '').trim();
    const prompt = String((body && body.prompt) || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    const id = crypto.randomBytes(6).toString('hex');
    const project = {
      id,
      name,
      template,
      prompt,
      owner: currentAppUser(req),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      canvas: {},
      brand: null,
      status: 'draft',
    };
    designProjects.set(id, project);
    sendJson(res, 200, { id, ...project });
  });
}

function designGetProject(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = url.pathname.split('/').pop();
  const project = id ? designProjects.get(id) : null;
  if (!project) return sendJson(res, 404, { error: 'Project not found' });
  sendJson(res, 200, project);
}

function designUpdateProject(req, res) {
  readJsonBody(req, 512 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const url = new URL(req.url, 'http://x');
    const id = url.pathname.split('/').pop();
    const project = designProjects.get(id);
    if (!project) return sendJson(res, 404, { error: 'Project not found' });
    const allowed = ['name', 'template', 'prompt', 'canvas', 'brand', 'status'];
    let changed = false;
    for (const key of allowed) {
      if (body && Object.prototype.hasOwnProperty.call(body, key)) {
        project[key] = body[key];
        changed = true;
      }
    }
    if (changed) project.updatedAt = Date.now();
    sendJson(res, 200, project);
  });
}

function designDeleteProject(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = url.pathname.split('/').pop();
  if (!designProjects.has(id)) return sendJson(res, 404, { error: 'Project not found' });
  designProjects.delete(id);
  sendJson(res, 200, { ok: true });
}

function designGenerate(req, res) {
  readJsonBody(req, 512 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const projectId = String((body && body.projectId) || '').trim();
    const prompt = String((body && body.prompt) || '').trim();
    const provider = String((body && body.provider) || '').trim();
    const model = String((body && body.model) || '').trim();
    const project = designProjects.get(projectId);
    if (!project) return sendJson(res, 404, { error: 'Project not found' });
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' });
    project.prompt = prompt;
    project.status = 'generating';
    project.updatedAt = Date.now();
    // Placeholder: hand the request back to the caller as a token.
    // A real implementation would call an image/design model here
    // and write the resulting HTML/canvas JSON into project.canvas.
    sendJson(res, 200, {
      projectId,
      status: 'queued',
      message: 'Design generation is queued. Connect a design-capable provider to render the canvas.',
      prompt,
      provider: provider || 'auto',
      model: model || 'auto',
    });
  });
}

function designExport(req, res) {
  readJsonBody(req, 512 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const projectId = String((body && body.projectId) || '').trim();
    const format = String((body && body.format) || 'html').trim().toLowerCase();
    const project = designProjects.get(projectId);
    if (!project) return sendJson(res, 404, { error: 'Project not found' });
    const allowed = ['html', 'pdf', 'pptx', 'png', 'svg', 'mp4'];
    if (!allowed.includes(format)) return sendJson(res, 400, { error: 'Unsupported export format. Use: ' + allowed.join(', ') });
    const exportRecord = {
      projectId,
      format,
      requestedAt: Date.now(),
      url: '/api/design/export/' + projectId + '/' + format,
    };
    project.status = 'export-' + format;
    project.updatedAt = Date.now();
    sendJson(res, 200, exportRecord);
  });
}

function designBrandProfile(req, res) {
  const url = new URL(req.url, 'http://x');
  const projectId = url.searchParams.get('projectId');
  const key = url.searchParams.get('key');
  const profile = key ? designBrandProfiles.get(key) : null;
  if (profile) return sendJson(res, 200, profile);
  if (projectId) {
    const project = designProjects.get(projectId);
    if (project && project.brand) return sendJson(res, 200, project.brand);
  }
  sendJson(res, 200, {});
}

function designSaveBrandProfile(req, res) {
  readJsonBody(req, 512 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Invalid request' });
    const key = String((body && body.key) || '').trim() || crypto.randomBytes(8).toString('hex');
    const profile = {
      key,
      url: String((body && body.url) || '').trim(),
      palette: Array.isArray(body && body.palette) ? body.palette.slice(0, 8) : [],
      fontStack: String((body && body.fontStack) || '').trim(),
      semanticRoles: body && body.semanticRoles || {},
      source: String((body && body.source) || '').trim(),
      updatedAt: Date.now(),
    };
    designBrandProfiles.set(key, profile);
    const projectId = String((body && body.projectId) || '').trim();
    if (projectId) {
      const project = designProjects.get(projectId);
      if (project) {
        project.brand = profile;
        project.updatedAt = Date.now();
      }
    }
    sendJson(res, 200, profile);
  });
}

function createRequestHandler(root) {
  const buildStore = createBuildStore(root);
  const buildHelpers = {
    currentUser: currentAppUser,
    gateOn: () => getConfiguredAccounts(process.env).length > 0,
    runRefusal: () => workspaceRunRefusal(process.env),
    readJsonBody,
    sendJson,
    contextFor: buildRequestContext,
  };
  return (req, res) => {
    const urlPath = req.url.split('?')[0];

    // ---- desktop CORS -------------------------------------------------
    // The Tauri webview is a different origin from the engine site, so the
    // browser blocks every fetch unless the response carries
    // Access-Control-Allow-Origin -- and any non-simple request (the JSON
    // login POST, PUT/DELETE routes) needs the OPTIONS preflight answered,
    // which previously fell through the router as 405 and killed those
    // calls before auth ever ran.
    const allowOrigin = corsOriginFor(req.headers.origin);
    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

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

    // A share reader is meant to be opened by anyone holding the link, the
    // same reasoning that puts /api/health on PUBLIC_PATHS. Only the read side
    // is exempt: the /s/<id> reader shell and the GET that feeds it. Publishing
    // (PUT) and revoking (DELETE) stay behind the sign-in below.
    const isShareRead = (urlPath === '/s' || urlPath.startsWith('/s/'))
      || (urlPath.startsWith('/api/share/') && req.method === 'GET');
    // The reader page is served for any /s/<id>, so its script resolves for an
    // anonymous visitor too: chatlib.js is required by share.html to render the
    // transcript the way the app wrote it. It carries no secrets -- it ships to
    // every signed-in browser anyway.
    const isShareAsset = urlPath === '/chatlib.js';
    if (!PUBLIC_PATHS.has(urlPath) && !isShareRead && !isShareAsset && !isAuthenticated(req)) {
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
    if (urlPath === '/api/session' && req.method === 'GET') return sessionStatus(req, res);
    if (urlPath === '/api/share' && req.method === 'PUT') return handleSharePublish(req, res);
    if (urlPath.startsWith('/api/share/') && req.method === 'DELETE') return handleShareRevoke(req, res);
    if (urlPath === '/s' || urlPath.startsWith('/s/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      return handleShareRead(req, res);
    }
    if (urlPath === '/api/github/authorize' && req.method === 'GET') return githubAuthorize(req, res);
    if (urlPath === '/api/github/callback' && req.method === 'GET') return githubCallback(req, res);
    if (urlPath === '/api/github/status' && req.method === 'GET') return githubStatus(req, res);
    if (urlPath === '/api/github/disconnect' && req.method === 'POST') return githubDisconnect(req, res);
    if (urlPath === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return llmHealth(req, res);
    if (urlPath === '/api/llm/providers' && req.method === 'GET') return llmProviders(req, res);
    if (urlPath === '/api/llm/puter/models' && req.method === 'GET') return llmPuterModels(req, res);
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
    if (urlPath === '/api/github/branches' && req.method === 'GET') return githubListBranches(req, res);
    if (urlPath === '/api/github/branch' && req.method === 'POST') return githubCreateBranch(req, res);
    if (urlPath === '/api/workspace/run' && req.method === 'POST') return handleWorkspaceRun(req, res, root);
    if (urlPath === '/api/workspace/files' && req.method === 'GET') return handleWorkspaceFiles(req, res, root);
    if (urlPath === '/api/workspace/read' && req.method === 'GET') return handleWorkspaceRead(req, res, root);
    if (urlPath === '/api/workspace/search' && req.method === 'GET') return handleWorkspaceSearch(req, res, root);
    if (urlPath === '/api/workspace/file' && (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) return handleWorkspaceFileChange(req, res, root);
    if (urlPath === '/api/workspace/file' && req.method === 'GET') return handleWorkspaceFile(req, res, root);
    if (urlPath === '/api/build/sessions' || urlPath.startsWith('/api/build/sessions/')) {
      return handleBuildRoute(req, res, urlPath, buildStore, buildHelpers);
    }
    if (urlPath === '/api/push/register' && req.method === 'POST') return handlePushRegister(req, res);
    if (urlPath === '/api/push/unregister' && req.method === 'POST') return handlePushUnregister(req, res);
    if (urlPath === '/api/tts' && req.method === 'POST') return llmTts(req, res);
    if (urlPath === '/api/memory' && req.method === 'GET') return handleMemoryList(req, res);
    if (urlPath === '/api/memory' && req.method === 'PUT') return handleMemoryUpsert(req, res);
    if (urlPath === '/api/memory' && req.method === 'DELETE') return handleMemoryDelete(req, res);
    if (urlPath.startsWith('/api/share/') && req.method === 'GET') return handleShareData(req, res);

    // --- Design tab: systematic graphic design workspace ---
    if (urlPath === '/api/design/templates' && req.method === 'GET') return designTemplates(req, res);
    if (urlPath === '/api/design/projects' && req.method === 'GET') return designListProjects(req, res);
    if (urlPath === '/api/design/projects' && req.method === 'POST') return designCreateProject(req, res);
    if (urlPath.startsWith('/api/design/projects/') && req.method === 'GET') return designGetProject(req, res);
    if (urlPath.startsWith('/api/design/projects/') && req.method === 'PUT') return designUpdateProject(req, res);
    if (urlPath.startsWith('/api/design/projects/') && req.method === 'DELETE') return designDeleteProject(req, res);
    if (urlPath === '/api/design/generate' && req.method === 'POST') return designGenerate(req, res);
    if (urlPath === '/api/design/export' && req.method === 'POST') return designExport(req, res);
    if (urlPath === '/api/design/brand' && req.method === 'GET') return designBrandProfile(req, res);
    if (urlPath === '/api/design/brand' && req.method === 'POST') return designSaveBrandProfile(req, res);

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
  corsOriginFor,
  githubApiHeaders,
  resolveSafePath,
  isAssetPath,
  workspaceRunRoot,
  workspaceRunRefusal,
  workspaceRunTimeoutMs,
  runEnvironment,
  gitRunEnv,
  scrubToken,
  capRunOutput,
  resolveWorkspaceCwd,
  listWorkspaceFiles,
  LLM_PROVIDERS,
  createRequestHandler,
  normalizeProviderModel,
  normalizePricing,
  normalizeProviderBaseUrl,
  providerConfig,
  parseRetryAfterMs,
  retryBackoffMs,
  describeProviderError,
  fetchFailureReason,
  fetchProviderWithRetry,
  fetchStreamWithRetry,
  clearModelCache,
  // The ledger and the cooldowns are process state, so a test that leaves a
  // provider cooling would slow every test after it.
  clearProviderLedger: () => {
    providerLedger.clear();
    providerCooldownUntil.clear();
  },
  clearImageDiscoveryCache,
  imageModelFromCatalogue,
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
  // Share-store seams: the file lifecycle runs at require time and on a
  // debounce, so a test drives these directly -- flush settles the write,
  // restart is what a reboot does.
  flushShareStoreNow: () => {
    if (shareStoreTimer) { clearTimeout(shareStoreTimer); shareStoreTimer = null; }
    shareStoreDirty = true;
    return flushShareStore();
  },
  shareStoreRestartForTest: () => {
    shareStore.clear();
    shareStoreDirty = false;
    if (shareStoreTimer) { clearTimeout(shareStoreTimer); shareStoreTimer = null; }
    loadShareStore();
  },
  shareStoreOnDisk: () => !!shareStorePath(),
};
