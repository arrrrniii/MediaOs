const { hmacSha256, constantTimeCompare } = require('../utils/crypto');
const config = require('../config');

// --- Original file URLs ---

function generateOriginal(project, storageKey, expiresIn = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `${storageKey}:${expires}`;
  const token = hmacSha256(project.signing_secret, payload);

  return {
    url: `${config.publicUrl}/f/${storageKey}?token=${token}&expires=${expires}`,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

function validateOriginal(signingSecret, storageKey, token, expires) {
  if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const payload = `${storageKey}:${expires}`;
  const expected = hmacSha256(signingSecret, payload);
  return constantTimeCompare(token, expected);
}

// --- Transform URLs (resized images) ---

function generateTransform(project, storageKey, { mode, width, height, format }, expiresIn = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const fmt = format || 'webp';
  const payload = `${storageKey}:${mode}:${width}:${height}:${fmt}:${expires}`;
  const token = hmacSha256(project.signing_secret, payload);

  const url = `${config.publicUrl}/img/${mode}/${width}/${height}/f/${storageKey}?token=${token}&expires=${expires}`;
  return {
    url,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

function validateTransform(signingSecret, storageKey, { mode, width, height, format }, token, expires) {
  if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const fmt = format || 'webp';
  const payload = `${storageKey}:${mode}:${width}:${height}:${fmt}:${expires}`;
  const expected = hmacSha256(signingSecret, payload);
  return constantTimeCompare(token, expected);
}

// --- Named-variant transform URLs ---
// Signed over the storage key, the variant name, and the chosen output
// format, so a signed variant URL cannot be replayed for a different variant
// or format. Kept separate from generateTransform so the two signing schemes
// never collide.

function generateVariant(project, storageKey, { variant, format }, expiresIn = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const fmt = format || 'auto';
  const payload = `v:${storageKey}:${variant}:${fmt}:${expires}`;
  const token = hmacSha256(project.signing_secret, payload);

  const url = `${config.publicUrl}/img/v/${variant}/f/${storageKey}?token=${token}&expires=${expires}`;
  return {
    url,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

function validateVariant(signingSecret, storageKey, { variant, format }, token, expires) {
  if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const fmt = format || 'auto';
  const payload = `v:${storageKey}:${variant}:${fmt}:${expires}`;
  const expected = hmacSha256(signingSecret, payload);
  return constantTimeCompare(token, expected);
}

// --- HLS manifests + segments ---
// Every HLS object (master playlist, media playlist, segment, poster,
// subtitle) is protected by the SAME token scheme as an original file:
// token = HMAC(secret, `${storageKey}:${expires}`), validated by
// validateOriginal. A signed master URL therefore validates exactly like any
// /f/ URL; when we serve a signed playlist we REWRITE each child URI to carry
// a token computed over the CHILD's storage key and the same expiry, so the
// player fetches signed children and every segment is independently checked.

function signStorageKey(signingSecret, storageKey, expires) {
  return hmacSha256(signingSecret, `${storageKey}:${expires}`);
}

/**
 * Rewrite an HLS playlist so its child URIs (media playlists, segments,
 * #EXT-X-MEDIA / #EXT-X-MAP URI="…" attributes) each carry a token+expires
 * derived from the child's own storage key. Relative URIs are resolved against
 * `playlistDir` (the storage-key directory the playlist lives in) so the token
 * is signed over the exact key the segment request will present.
 *
 * @param {string} text          the raw playlist body
 * @param {string} playlistDir   storage-key dir of THIS playlist (no trailing /)
 * @param {string} signingSecret
 * @param {number|string} expires unix seconds; the shared session deadline
 * @returns {string} the rewritten playlist
 */
function rewriteHlsPlaylist(text, playlistDir, signingSecret, expires) {
  const dir = playlistDir.replace(/\/+$/, '');
  const signUri = (uri) => {
    // Leave absolute URLs and already-signed URIs untouched.
    if (/^https?:\/\//i.test(uri)) return uri;
    const [pathPart, existingQuery] = uri.split('?');
    if (existingQuery && /(^|&)token=/.test(existingQuery)) return uri;
    const childKey = `${dir}/${pathPart}`;
    const token = signStorageKey(signingSecret, childKey, expires);
    const sep = existingQuery ? '&' : '?';
    return `${uri}${sep}token=${token}&expires=${expires}`;
  };

  return text
    .split('\n')
    .map((line) => {
      if (line === '' || line.startsWith('#')) {
        // Rewrite a URI="…" attribute if the tag carries one (EXT-X-MEDIA/MAP).
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${signUri(uri)}"`);
      }
      // A bare URI line (media playlist or segment reference).
      return signUri(line.trim());
    })
    .join('\n');
}

// Backward-compatible aliases
const generate = generateOriginal;
const validate = validateOriginal;

module.exports = {
  generate,
  validate,
  generateOriginal,
  validateOriginal,
  generateTransform,
  validateTransform,
  generateVariant,
  validateVariant,
  signStorageKey,
  rewriteHlsPlaylist,
};
