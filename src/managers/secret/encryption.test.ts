import { encrypt, decrypt, deriveKey, generateKey, generateSalt } from './encryption';

describe('Encryption', () => {
  const key = generateKey();

  it('should encrypt and decrypt a string', () => {
    const plaintext = 'my-secret-value-123';
    const encrypted = encrypt(plaintext, key);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    expect(encrypted.ciphertext).not.toBe(plaintext);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same plaintext', () => {
    const plaintext = 'same-value';
    const enc1 = encrypt(plaintext, key);
    const enc2 = encrypt(plaintext, key);

    // IVs should differ
    expect(enc1.iv).not.toBe(enc2.iv);
    // Ciphertext should differ (due to different IV)
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

    // Both should decrypt to the same value
    expect(decrypt(enc1, key)).toBe(plaintext);
    expect(decrypt(enc2, key)).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', () => {
    const plaintext = 'sensitive-data';
    const encrypted = encrypt(plaintext, key);
    const wrongKey = generateKey();

    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('should fail to decrypt with tampered ciphertext', () => {
    const encrypted = encrypt('test', key);
    encrypted.ciphertext = Buffer.from('tampered').toString('base64');

    expect(() => decrypt(encrypted, key)).toThrow();
  });

  it('should fail to decrypt with tampered tag', () => {
    const encrypted = encrypt('test', key);
    encrypted.tag = Buffer.from('0000000000000000').toString('base64');

    expect(() => decrypt(encrypted, key)).toThrow();
  });

  it('should handle empty strings', () => {
    const encrypted = encrypt('', key);
    expect(decrypt(encrypted, key)).toBe('');
  });

  it('should handle unicode strings', () => {
    const plaintext = 'Hello 世界! 🎉 Ñoño';
    const encrypted = encrypt(plaintext, key);
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it('should derive consistent keys from passphrase + salt', () => {
    const salt = generateSalt();
    const key1 = deriveKey('my-passphrase', salt);
    const key2 = deriveKey('my-passphrase', salt);

    expect(key1.equals(key2)).toBe(true);
  });

  it('should derive different keys for different passphrases', () => {
    const salt = generateSalt();
    const key1 = deriveKey('passphrase-1', salt);
    const key2 = deriveKey('passphrase-2', salt);

    expect(key1.equals(key2)).toBe(false);
  });

  it('should derive different keys for different salts', () => {
    const key1 = deriveKey('same-pass', generateSalt());
    const key2 = deriveKey('same-pass', generateSalt());

    expect(key1.equals(key2)).toBe(false);
  });
});
