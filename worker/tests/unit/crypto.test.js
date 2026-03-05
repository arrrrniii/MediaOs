const crypto = require('crypto');

// Test crypto utils directly (no mocks needed)
const { sha256, constantTimeCompare, hmacSha256, randomHex } = require('../../src/utils/crypto');

describe('Crypto Utils', () => {
  describe('sha256', () => {
    it('should return a 64-char hex hash', () => {
      const result = sha256('hello');
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce consistent results', () => {
      expect(sha256('test')).toBe(sha256('test'));
    });

    it('should produce different hashes for different inputs', () => {
      expect(sha256('a')).not.toBe(sha256('b'));
    });

    it('should match Node.js crypto output', () => {
      const expected = crypto.createHash('sha256').update('test123').digest('hex');
      expect(sha256('test123')).toBe(expected);
    });
  });

  describe('constantTimeCompare', () => {
    it('should return true for equal strings', () => {
      expect(constantTimeCompare('abc123', 'abc123')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(constantTimeCompare('abc', 'xyz')).toBe(false);
    });

    it('should return false for different-length strings', () => {
      expect(constantTimeCompare('short', 'longer-string')).toBe(false);
    });

    it('should return false for non-string inputs', () => {
      expect(constantTimeCompare(null, 'abc')).toBe(false);
      expect(constantTimeCompare('abc', undefined)).toBe(false);
      expect(constantTimeCompare(123, 'abc')).toBe(false);
    });
  });

  describe('hmacSha256', () => {
    it('should return a 64-char hex string', () => {
      const result = hmacSha256('secret', 'data');
      expect(result).toHaveLength(64);
      expect(result).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce consistent results', () => {
      expect(hmacSha256('s', 'd')).toBe(hmacSha256('s', 'd'));
    });

    it('should produce different results for different secrets', () => {
      expect(hmacSha256('secret1', 'data')).not.toBe(hmacSha256('secret2', 'data'));
    });

    it('should match Node.js crypto output', () => {
      const expected = crypto.createHmac('sha256', 'key').update('msg').digest('hex');
      expect(hmacSha256('key', 'msg')).toBe(expected);
    });
  });

  describe('randomHex', () => {
    it('should return a hex string of the expected length', () => {
      const result = randomHex(16);
      expect(result).toHaveLength(32); // 16 bytes = 32 hex chars
    });

    it('should produce different values each time', () => {
      const a = randomHex(16);
      const b = randomHex(16);
      expect(a).not.toBe(b);
    });

    it('should only contain hex characters', () => {
      expect(randomHex(32)).toMatch(/^[a-f0-9]+$/);
    });
  });
});
