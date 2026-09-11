const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const PUBLIC_PATHS = new Set(['/login.html', '/api/login']);
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

// A 429 from a provider means the request arrived before the free tier was
// ready for it, so it is worth waiting and trying again rather than surfacing
// an error the user has to act on. Retries are bounded and back off, and a
// short cooldown stops a burst of tool calls from hammering the same provider.
// The base delay reads at call time so tests can shrink it via env.
const RATE_LIMIT_MAX_ATTEMPTS = 4;
const providerCooldownUntil = new Map();

function retryBaseDelayMs() {
  return Number(process.env.RATE_LIMIT_BASE_DELAY_MS) || 2500;
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
// `{ ok, status, data }` packet or a raw `Response`), retrying only on 429.
async function retryProviderRequest(providerId, attempt) {
  let result;
  for (let tryNum = 0; tryNum < RATE_LIMIT_MAX_ATTEMPTS; tryNum += 1) {
    const wait = providerCooldownRemaining(providerId);
    if (wait > 0) await sleep(wait);
    result = await attempt();
    let status = result && typeof result.status === 'number' ? result.status : 0;
    if (result && typeof result.status !== 'number') status = result.ok ? 200 : 599;
    if (status !== 429) return result;
    const backoff = retryBaseDelayMs() * 2 ** tryNum;
    markProviderCooldown(providerId, Math.min(backoff * 2, 15000) + retryBaseDelayMs());
    if (tryNum < RATE_LIMIT_MAX_ATTEMPTS - 1) await sleep(backoff);
  }
  return result;
}

// Retries an idempotent provider call (chat completions) only on 429. Anything
// else is final and returned as-is, and if the provider keeps refusing the
// last 429 is returned too, so the caller can describe it normally.
async function fetchProviderWithRetry(providerId, fetchOnce) {
  return retryProviderRequest(providerId, fetchOnce);
}

// The streaming sibling: each attempt resolves to a raw Response so the caller
// can pipe the upstream body through. The 429 arrives as the initial status,
// before any body is read, so the same retry/cooldown logic applies. When the
// client cancels, `onAbort` aborts the in-flight upstream read immediately.
async function fetchStreamWithRetry(providerId, fetchRaw) {
  return retryProviderRequest(providerId, async () => {
    const response = await fetchRaw();
    if (!response || typeof response.status !== 'number' || response.status !== 429) return response;
    // Drain 429 bodies so the socket is reusable before we retry.
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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
  nara: {
    label: 'Nara',
    baseUrl: 'https://router.bynara.id/v1',
    envVar: 'NARA_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    // Optional attribution headers OpenRouter documents for its leaderboards.
    headers: (req) => ({ 'HTTP-Referer': requestOrigin(req), 'X-Title': 'FreeOpenAI' }),
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envVar: 'NVIDIA_API_KEY',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envVar: 'MISTRAL_API_KEY',
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

function providerConfig(id) {
  const provider = LLM_PROVIDERS[id];
  if (!provider) return null;
  const key = process.env[provider.envVar];
  if (!key) return null;
  // A base URL override lets the same adapter reach a self-hosted NIM or a
  // proxy, and lets the tests point at a local stand-in.
  const baseUrl = process.env[provider.envVar.replace(/_API_KEY$/, '_BASE_URL')] || provider.baseUrl;
  return { ...provider, key, baseUrl };
}

// Which providers the user can actually pick. A provider with no key stays out
// of the list rather than appearing and failing on first use.
function llmProviders(req, res) {
  sendJson(res, 200, Object.entries(LLM_PROVIDERS).map(([id, provider]) => ({
    id,
    label: provider.label,
    configured: !!process.env[provider.envVar],
    // 'speech' and 'search' services have no chat models. Saying so beats an
    // empty dropdown that looks like a bug.
    kind: provider.kind || 'chat',
    note: provider.note,
  })));
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
const PROVIDER_TIMEOUT_MS = { models: 20000, chat: 55000 };

async function providerFetch(req, provider, path, init = {}) {
  const extra = typeof provider.headers === 'function' ? provider.headers(req) : {};
  const budget = path.includes('chat') ? PROVIDER_TIMEOUT_MS.chat : PROVIDER_TIMEOUT_MS.models;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  // Most use "Authorization: Bearer <key>", but not all: Deepgram wants
  // "Token", AssemblyAI wants the bare key, You.com wants its own header.
  const headerName = provider.authHeader || 'Authorization';
  const scheme = provider.authScheme === undefined ? 'Bearer' : provider.authScheme;
  try {
    const res = await fetch(provider.baseUrl + path, {
      ...init,
      signal: controller.signal,
      headers: {
        [headerName]: scheme ? `${scheme} ${provider.key}` : provider.key,
        'Content-Type': 'application/json',
        ...extra,
        ...(init.headers || {}),
      },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // Report our own deadline as such. A generic network error here would look
    // identical to the provider refusing us, which sends the user hunting
    // through their key when nothing is wrong with it.
    if (err.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        data: { error: { message: `${provider.label} did not respond within ${Math.round(budget / 1000)}s` } },
      };
    }
    return { ok: false, status: 502, data: { error: { message: `Could not reach ${provider.label}: ${err.message}` } } };
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
  const ttl = modelsCacheTtlMs();
  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return sendJson(res, 200, cached.models);
  }
  try {
    const { ok, status, data } = await providerFetch(req, provider, '/models');
    if (!ok) return sendJson(res, status, { error: describeProviderError(status, data, provider) });
    const models = (data && Array.isArray(data.data) ? data.data : [])
      .filter((m) => m && m.id)
      .map(normalizeProviderModel);
    // Only a successful catalogue is worth caching; errors rust nothing.
    modelCache.set(id, { fetchedAt: Date.now(), models });
    sendJson(res, 200, models);
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

function normalizeProviderModel(m) {
  const architecture = m.architecture || {};
  return {
    id: m.id,
    name: m.name || m.display_name,
    ownedBy: m.owned_by,
    pricing: normalizePricing(m),
    contextLength: m.context_length,
    supportedParameters: m.supported_parameters,
    outputModalities: m.output_modalities || architecture.output_modalities,
  };
}

function llmChat(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('provider');
  const provider = providerConfig(id);
  if (!provider) return sendJson(res, 400, { error: 'Unknown or unconfigured provider' });
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
    const extra = typeof provider.headers === 'function' ? provider.headers(req) : {};
    const headerName = provider.authHeader || 'Authorization';
    const scheme = provider.authScheme === undefined ? 'Bearer' : provider.authScheme;
    const headers = {
      [headerName]: scheme ? `${scheme} ${provider.key}` : provider.key,
      'Content-Type': 'application/json',
      ...extra,
    };
    if (body.stream) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS.chat);
      const onClientClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      // Use the socket close event rather than req.on('close'), because
      // req (IncomingMessage/Readable) emits 'close' when the request body
      // is fully consumed — which happens before we start streaming.
      req.socket.on('close', onClientClose);
      let upstreamConsumed = false;
      try {
        const upstream = await fetchStreamWithRetry(id, () =>
          fetch(provider.baseUrl + '/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers,
            body: upstreamBody,
          })
        );
        res.writeHead(upstream.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          // Some reverse proxies (Railway, nginx, Cloudflare) buffer SSE by
          // default. This header tells them to flush the data through.
          'X-Accel-Buffering': 'no',
        });
        // Non-retryable or non-streamable failures still get a readable body.
        if (!upstream.ok) {
          const data = await upstream.json().catch(() => null);
          res.write(`data: ${JSON.stringify({ error: describeProviderError(upstream.status, data, provider) })}\n\n`);
        } else {
          for await (const chunk of upstream.body) {
            res.write(chunk);
          }
          upstreamConsumed = true;
        }
      } catch (e) {
        res.writeHead(e.name === 'AbortError' ? 499 : 502, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ error: e.name === 'AbortError' ? 'Request aborted' : e.message })}\n\n`);
      } finally {
        clearTimeout(timer);
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
    if (urlPath === '/api/llm/providers' && req.method === 'GET') return llmProviders(req, res);
    if (urlPath === '/api/llm/models' && req.method === 'GET') return llmModels(req, res);
    if (urlPath === '/api/llm/chat' && req.method === 'POST') return llmChat(req, res);
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : html);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
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
  createRequestHandler,
  normalizeProviderModel,
  normalizePricing,
  describeProviderError,
  fetchProviderWithRetry,
  fetchStreamWithRetry,
  clearModelCache,
  modelsCacheTtlMs,
};
