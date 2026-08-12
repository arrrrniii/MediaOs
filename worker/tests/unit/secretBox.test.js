// Activates the mock config (storageEncryptionKey = '0'*64) before requiring
// secretBox, which reads the key from config at call time.
require('../setup');
const config = require('../../src/config');
const secretBox = require('../../src/utils/secretBox');

describe('secretBox (AES-256-GCM backend credential seal)', () => {
  const original = config.storageEncryptionKey;
  afterEach(() => { config.storageEncryptionKey = original; });

  it('round-trips a JSON object', () => {
    const obj = {
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'cold-bucket',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-value',
      forcePathStyle: true,
    };
    const blob = secretBox.encryptJson(obj);
    expect(typeof blob).toBe('string');
    // Ciphertext must not expose the plaintext secret.
    expect(blob).not.toContain('super-secret-value');
    expect(secretBox.decryptJson(blob)).toEqual(obj);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = secretBox.encryptJson({ x: 1 });
    const b = secretBox.encryptJson({ x: 1 });
    expect(a).not.toBe(b);
    expect(secretBox.decryptJson(a)).toEqual({ x: 1 });
    expect(secretBox.decryptJson(b)).toEqual({ x: 1 });
  });

  it('detects tampering — a flipped byte fails the auth tag', () => {
    const blob = secretBox.encryptJson({ secret: 'value' });
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    const tampered = buf.toString('base64');
    expect(() => secretBox.decryptJson(tampered)).toThrow();
  });

  it('accepts a base64 32-byte key as well as hex', () => {
    config.storageEncryptionKey = Buffer.alloc(32, 7).toString('base64');
    const blob = secretBox.encryptJson({ ok: true });
    expect(secretBox.decryptJson(blob)).toEqual({ ok: true });
  });

  it('fails loudly when the key is missing', () => {
    config.storageEncryptionKey = '';
    expect(secretBox.hasKey()).toBe(false);
    expect(() => secretBox.encryptJson({ a: 1 })).toThrow(/STORAGE_ENCRYPTION_KEY/);
    expect(() => secretBox.decryptJson('AAAA')).toThrow(/STORAGE_ENCRYPTION_KEY/);
  });

  it('rejects a key of the wrong length', () => {
    config.storageEncryptionKey = 'abcd';
    expect(() => secretBox.encryptJson({ a: 1 })).toThrow(/32 bytes/);
  });
});
