// Pure encrypt/decrypt logic for the GitHub connector's token cookie, kept
// separate from server.js so it can run under node:test without an HTTP
// server. The stored value is AES-256-GCM sealed with a key derived from
// SESSION_SECRET, so the OAuth access token never reaches client JS and
// can't be read or forged without that secret.
const crypto = require('crypto');

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptJson(secret, obj) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

// Returns the decrypted object, or null if the value is missing, malformed,
// or fails authentication (tampered, or sealed with a different secret).
function decryptJson(secret, value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, dataB64] = parts;
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

// A sealed GitHub session belongs to exactly one app account. Without this
// check the token cookie outlives a logout, so the next person to sign in on
// the same browser inherits the previous user's GitHub access.
//
// appUser is null when the login gate is off (no AUTH_USER_* configured), so
// null must match null. It deliberately does not match a named user: enabling
// the gate later invalidates cookies sealed while the app was open.
function sessionMatchesUser(session, appUser) {
  if (!session) return false;
  const sealed = session.appUser === undefined ? null : session.appUser;
  return sealed === (appUser === undefined ? null : appUser);
}

// How many GitHub accounts one app user may connect. Three sealed accounts
// come to roughly 850 bytes once encrypted, against a ~4KB cookie limit.
const MAX_GITHUB_ACCOUNTS = 3;

// The cookie originally held a single {token, login, avatarUrl}. It now holds
// an accounts array. Old cookies are read as a one-account list rather than
// being thrown away, so nobody is forced to reconnect by this change alone.
function normalizeGithubSession(session) {
  if (!session) return null;
  if (Array.isArray(session.accounts)) return session;
  if (!session.token) return null;
  const { token, login, avatarUrl, ...rest } = session;
  return { ...rest, accounts: [{ token, login, avatarUrl }] };
}

function accountsOf(session) {
  const normalized = normalizeGithubSession(session);
  return normalized ? normalized.accounts.filter((a) => a && a.token) : [];
}

// Decides which connected account a repo operation runs as. Guessing wrong on
// a write means committing under the wrong identity, so this never falls back
// to "just try them all": an unresolvable repo returns a reason instead, and
// the caller asks for an explicit account.
function pickAccount(session, repo, requestedLogin) {
  const accounts = accountsOf(session);
  if (!accounts.length) return { error: 'GitHub not connected' };

  if (requestedLogin) {
    const named = accounts.find((a) => a.login === requestedLogin);
    return named ? { account: named } : { error: `No connected GitHub account named "${requestedLogin}"` };
  }

  if (accounts.length === 1) return { account: accounts[0] };

  // "owner/name" — an account can always act on repos under its own owner.
  const owner = String(repo || '').split('/')[0];
  const byOwner = accounts.find((a) => a.login && a.login.toLowerCase() === owner.toLowerCase());
  if (byOwner) return { account: byOwner };

  return {
    error:
      `"${repo}" is not owned by any connected account, so it is unclear which to use. ` +
      `Pass account as one of: ${accounts.map((a) => a.login).join(', ')}.`,
  };
}

module.exports = {
  encryptJson,
  decryptJson,
  sessionMatchesUser,
  MAX_GITHUB_ACCOUNTS,
  normalizeGithubSession,
  accountsOf,
  pickAccount,
};
