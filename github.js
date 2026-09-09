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

module.exports = { encryptJson, decryptJson };
