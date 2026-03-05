const { hmacSha256, constantTimeCompare } = require('../utils/crypto');
const config = require('../config');

function generate(project, storageKey, expiresIn = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `${storageKey}:${expires}`;
  const token = hmacSha256(project.signing_secret, payload);

  return {
    url: `${config.publicUrl}/f/${storageKey}?token=${token}&expires=${expires}`,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

function validate(signingSecret, storageKey, token, expires) {
  // Check expiry
  if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const payload = `${storageKey}:${expires}`;
  const expected = hmacSha256(signingSecret, payload);
  return constantTimeCompare(token, expected);
}

module.exports = { generate, validate };
