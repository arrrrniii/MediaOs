const {
  generate, validate,
  generateOriginal, validateOriginal,
  generateTransform, validateTransform,
} = require('../../src/services/signedUrl');

describe('Signed URLs', () => {
  const project = {
    id: 'proj-123',
    signing_secret: 'a'.repeat(64),
  };
  const storageKey = 'proj-123/image.webp';

  // --- Original URLs (backward-compatible aliases) ---

  describe('generate / validate (backward-compat aliases)', () => {
    it('should return url and expires_at', () => {
      const result = generate(project, storageKey, 3600);

      expect(result.url).toContain('/f/');
      expect(result.url).toContain('token=');
      expect(result.url).toContain('expires=');
      expect(result.expires_at).toBeDefined();
    });

    it('should set correct expiry', () => {
      const result = generate(project, storageKey, 300);
      const expiresAt = new Date(result.expires_at).getTime();
      const now = Date.now();

      // Should be about 300 seconds from now (±5s tolerance)
      expect(expiresAt - now).toBeGreaterThan(295000);
      expect(expiresAt - now).toBeLessThan(305000);
    });

    it('should validate a correctly signed URL', () => {
      const result = generate(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validate(project.signing_secret, storageKey, token, expires)).toBe(true);
    });
  });

  // --- Original URLs ---

  describe('generateOriginal / validateOriginal', () => {
    it('should generate and validate correctly', () => {
      const result = generateOriginal(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(result.url).toContain('/f/');
      expect(validateOriginal(project.signing_secret, storageKey, token, expires)).toBe(true);
    });

    it('should reject an expired URL', () => {
      const expires = String(Math.floor(Date.now() / 1000) - 100);
      const { hmacSha256 } = require('../../src/utils/crypto');
      const token = hmacSha256(project.signing_secret, `${storageKey}:${expires}`);

      expect(validateOriginal(project.signing_secret, storageKey, token, expires)).toBe(false);
    });

    it('should reject a tampered token', () => {
      const result = generateOriginal(project, storageKey, 3600);
      const url = new URL(result.url);
      const expires = url.searchParams.get('expires');

      expect(validateOriginal(project.signing_secret, storageKey, 'tampered', expires)).toBe(false);
    });

    it('should reject wrong signing secret', () => {
      const result = generateOriginal(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validateOriginal('wrong-secret', storageKey, token, expires)).toBe(false);
    });

    it('should reject wrong storage key', () => {
      const result = generateOriginal(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validateOriginal(project.signing_secret, 'wrong/key.webp', token, expires)).toBe(false);
    });
  });

  // --- Transform URLs ---

  describe('generateTransform / validateTransform', () => {
    const transform = { mode: 'fit', width: 400, height: 300, format: 'webp' };

    it('should generate a URL with transform params in the path', () => {
      const result = generateTransform(project, storageKey, transform, 3600);

      expect(result.url).toContain('/img/fit/400/300/f/');
      expect(result.url).toContain('token=');
      expect(result.url).toContain('expires=');
      expect(result.expires_at).toBeDefined();
    });

    it('should validate a correctly signed transform URL', () => {
      const result = generateTransform(project, storageKey, transform, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validateTransform(project.signing_secret, storageKey, transform, token, expires)).toBe(true);
    });

    it('should reject when resize mode differs', () => {
      const result = generateTransform(project, storageKey, transform, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      const wrongTransform = { ...transform, mode: 'fill' };
      expect(validateTransform(project.signing_secret, storageKey, wrongTransform, token, expires)).toBe(false);
    });

    it('should reject when dimensions differ', () => {
      const result = generateTransform(project, storageKey, transform, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      const wrongDims = { ...transform, width: 1200, height: 0 };
      expect(validateTransform(project.signing_secret, storageKey, wrongDims, token, expires)).toBe(false);
    });

    it('should reject when format differs', () => {
      const result = generateTransform(project, storageKey, transform, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      const wrongFormat = { ...transform, format: 'png' };
      expect(validateTransform(project.signing_secret, storageKey, wrongFormat, token, expires)).toBe(false);
    });

    it('should reject an expired transform URL', () => {
      const expires = String(Math.floor(Date.now() / 1000) - 100);
      const { hmacSha256 } = require('../../src/utils/crypto');
      const payload = `${storageKey}:fit:400:300:webp:${expires}`;
      const token = hmacSha256(project.signing_secret, payload);

      expect(validateTransform(project.signing_secret, storageKey, transform, token, expires)).toBe(false);
    });

    it('should not accept an original token for a transform', () => {
      const result = generateOriginal(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      // Original token should not work for transform validation
      expect(validateTransform(project.signing_secret, storageKey, transform, token, expires)).toBe(false);
    });

    it('should default format to webp', () => {
      const noFormat = { mode: 'fit', width: 400, height: 300 };
      const result = generateTransform(project, storageKey, noFormat, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      // Should validate with explicit webp since that's the default
      const withWebp = { ...noFormat, format: 'webp' };
      expect(validateTransform(project.signing_secret, storageKey, withWebp, token, expires)).toBe(true);
    });
  });
});
