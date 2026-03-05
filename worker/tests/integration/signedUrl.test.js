const { generate, validate } = require('../../src/services/signedUrl');

describe('Signed URLs', () => {
  const project = {
    id: 'proj-123',
    signing_secret: 'a'.repeat(64),
  };
  const storageKey = 'proj-123/image.webp';

  describe('generate', () => {
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
  });

  describe('validate', () => {
    it('should validate a correctly signed URL', () => {
      const result = generate(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validate(project.signing_secret, storageKey, token, expires)).toBe(true);
    });

    it('should reject an expired URL', () => {
      const expires = String(Math.floor(Date.now() / 1000) - 100); // 100s ago
      const { hmacSha256 } = require('../../src/utils/crypto');
      const token = hmacSha256(project.signing_secret, `${storageKey}:${expires}`);

      expect(validate(project.signing_secret, storageKey, token, expires)).toBe(false);
    });

    it('should reject a tampered token', () => {
      const result = generate(project, storageKey, 3600);
      const url = new URL(result.url);
      const expires = url.searchParams.get('expires');

      expect(validate(project.signing_secret, storageKey, 'tampered', expires)).toBe(false);
    });

    it('should reject wrong signing secret', () => {
      const result = generate(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validate('wrong-secret', storageKey, token, expires)).toBe(false);
    });

    it('should reject wrong storage key', () => {
      const result = generate(project, storageKey, 3600);
      const url = new URL(result.url);
      const token = url.searchParams.get('token');
      const expires = url.searchParams.get('expires');

      expect(validate(project.signing_secret, 'wrong/key.webp', token, expires)).toBe(false);
    });
  });
});
