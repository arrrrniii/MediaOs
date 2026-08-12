/**
 * Authenticated encryption for storage-backend credentials.
 *
 * A remote storage backend's whole connection config — endpoint, region,
 * bucket, access key id, secret access key, forcePathStyle — is stored as a
 * SINGLE encrypted JSON blob in storage_backends.configuration_encrypted, so
 * no secret ever lands in a plaintext column. This module is the seal.
 *
 * Scheme: AES-256-GCM with a 32-byte key from STORAGE_ENCRYPTION_KEY (accepted
 * as 64 hex chars or 44-char base64). A fresh 12-byte IV is generated per
 * encrypt; the output is base64( IV(12) || authTag(16) || ciphertext ). GCM's
 * auth tag makes tampering detectable — decrypt throws rather than returning
 * forged plaintext, so a mutated configuration_encrypted fails loudly instead
 * of building a client against attacker-chosen creds.
 *
 * This is intentionally its own module rather than utils/crypto's encrypt():
 * that one derives its key by SHA-256'ing an arbitrary secret string, whereas
 * backend credentials use a dedicated, operator-managed 32-byte key so they
 * can be rotated independently of MASTER_KEY / signing secrets.
 */

const crypto = require('crypto');
const config = require('../config');

const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16; // GCM auth tag length
const KEY_LEN = 32; // AES-256

/**
 * Resolve the 32-byte key from STORAGE_ENCRYPTION_KEY. Accepts hex (64 chars)
 * or base64 (decodes to 32 bytes). Throws — loudly — when the key is missing
 * or the wrong length, so a misconfigured deployment cannot silently write
 * credentials under a truncated/derived key.
 */
function loadKey() {
  const raw = (config.storageEncryptionKey || '').trim();
  if (!raw) {
    throw new Error(
      'STORAGE_ENCRYPTION_KEY is not set. A 32-byte key (hex or base64) is ' +
      'required to read or write encrypted storage-backend credentials.'
    );
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `STORAGE_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length}). ` +
      'Provide 64 hex chars or 32 bytes base64.'
    );
  }
  return key;
}

/**
 * Encrypt a JSON-serializable object into a base64 string.
 * @param {object} obj
 * @returns {string} base64( iv || authTag || ciphertext )
 */
function encryptJson(obj) {
  const key = loadKey();
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a string produced by encryptJson back into its object. Throws if the
 * key is missing, the blob is malformed, or the auth tag does not verify
 * (tampering / wrong key).
 * @param {string} blob base64( iv || authTag || ciphertext )
 * @returns {object}
 */
function decryptJson(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('decryptJson: expected a non-empty base64 string');
  }
  const key = loadKey();
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('decryptJson: ciphertext is too short to be valid');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

/** Whether a usable STORAGE_ENCRYPTION_KEY is configured (no throw). */
function hasKey() {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

module.exports = { encryptJson, decryptJson, hasKey };
