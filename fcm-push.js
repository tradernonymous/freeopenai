// Push notifications through Firebase Cloud Messaging's HTTP v1 API,
// authenticated with a Google service-account key -- no firebase-admin
// package, so this stays the same zero-runtime-dependency shape every other
// provider in this app already has. The only thing FCM needs from a server
// is a short-lived OAuth2 access token, and that token comes from signing one
// JWT with the service account's own private key (RFC 7523's "JWT bearer"
// grant) -- Node's built-in crypto does that without a library.

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
// Access tokens last an hour; refreshing this early avoids a request landing
// in the last few seconds of a token's life and racing the clock skew between
// this server and Google's.
const REFRESH_SKEW_MS = 60_000;

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The service account JSON Firebase's console issues, parsed and checked for
 * the three fields this module actually uses. Anything else -- missing env
 * var, malformed JSON, a key with the wrong shape -- comes back null, which
 * is what turns push into a silent no-op rather than a startup crash. */
function parseServiceAccount(raw) {
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { client_email: clientEmail, private_key: privateKey, project_id: projectId } = data;
  if (!clientEmail || !privateKey || !projectId) return null;
  return { clientEmail, privateKey, projectId };
}

/** A self-signed assertion this exchanges for an access token: no refresh
 * token or client secret in play, just proof of holding the private key. */
function signAssertion(account, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claims), account.privateKey);
  return header + '.' + claims + '.' + base64url(signature);
}

/** One cached token per service account (by project id, which is unique per
 * Firebase project) so a burst of pushes signs one JWT, not one per push. */
const tokenCache = new Map();

async function getAccessToken(account, fetchImpl, now) {
  const cached = tokenCache.get(account.projectId);
  if (cached && cached.expiresAt - REFRESH_SKEW_MS > now()) return cached.value;
  const assertion = signAssertion(account, Math.floor(now() / 1000));
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('FCM auth failed: HTTP ' + res.status);
  const data = await res.json();
  const value = String(data.access_token || '');
  if (!value) throw new Error('FCM auth returned no access token');
  tokenCache.set(account.projectId, { value, expiresAt: now() + (Number(data.expires_in) || 3600) * 1000 });
  return value;
}

/** Sends one data-less notification to one device token. Firebase rejects an
 * unregistered or expired token with its own error rather than a generic
 * failure, which the caller uses to drop that token from the registry. */
async function sendPush(account, deviceToken, notification, fetchImpl = fetch, now = Date.now) {
  const accessToken = await getAccessToken(account, fetchImpl, now);
  const res = await fetchImpl(
    'https://fcm.googleapis.com/v1/projects/' + account.projectId + '/messages:send',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: deviceToken, notification } }),
    },
  );
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  const stale = res.status === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(text);
  const error = new Error('FCM send failed: HTTP ' + res.status + ' ' + text.slice(0, 300));
  error.staleToken = stale;
  throw error;
}

/** Clears the cached token -- a test-only escape hatch, since the cache is
 * otherwise process-lifetime and would leak one run's token into the next. */
function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  parseServiceAccount,
  signAssertion,
  getAccessToken,
  sendPush,
  clearTokenCache,
  base64url,
};
