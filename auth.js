// Pure login/session logic, kept separate from server.js so it can run under
// node:test without spinning up an HTTP server. No DOM/Node-http APIs here
// beyond `crypto`, which is available in both the server and the test runner.
const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'fo_auth';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Reads up to 3 username/password pairs from AUTH_USER_1/AUTH_PASS_1 .. _3.
// Unset or empty pairs are skipped. An empty return means auth is disabled
// (the app is open) — that's intentional so a fresh deploy isn't locked out
// before the user has set any Railway variables.
function getConfiguredAccounts(env) {
  const accounts = [];
  for (let i = 1; i <= 3; i++) {
    const username = env[`AUTH_USER_${i}`];
    const password = env[`AUTH_PASS_${i}`];
    if (username && password) accounts.push({ username, password });
  }
  return accounts;
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so this branch doesn't return
    // measurably faster than a same-length mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyCredentials(accounts, username, password) {
  if (!username || !password) return false;
  return accounts.some(
    (acct) => timingSafeStringEqual(acct.username, username) && timingSafeStringEqual(acct.password, password)
  );
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function signSession(secret, username, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  const payload = base64UrlEncode(JSON.stringify({ u: username, exp: now + ttlMs }));
  return `${payload}.${hmac(secret, payload)}`;
}

// Returns the session's username if the cookie value is well-formed,
// correctly signed, and not expired; otherwise null.
function verifySession(secret, cookieValue, now = Date.now()) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = hmac(secret, payload);
  if (!timingSafeStringEqual(expected, signature)) return null;
  try {
    const { u, exp } = JSON.parse(base64UrlDecode(payload));
    if (typeof u !== 'string' || typeof exp !== 'number' || exp <= now) return null;
    return u;
  } catch {
    return null;
  }
}

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

// Sliding-window-ish fixed-window rate limiter. `store` is a plain Map the
// caller owns (so tests can pass a throwaway one); returns true if the
// request identified by `key` is allowed to proceed.
function checkRateLimit(store, key, now, limit, windowMs) {
  const entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  getConfiguredAccounts,
  verifyCredentials,
  signSession,
  verifySession,
  parseCookieHeader,
  checkRateLimit,
};
