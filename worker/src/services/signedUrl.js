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
};
