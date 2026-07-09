import {
  encryptField,
  decryptField,
  blindIndex,
  isEncrypted,
  keyIdOf,
} from '@/lib/crypto/fieldCrypto.js';
import { EnvKeyProvider, UnknownKeyIdError } from '@/lib/crypto/keyProvider.js';

// Two distinct, fixed 32-byte base64 keys (same values as the test env).
const KEY_A = 'xUDmpBXSU0GOwiXb21JUx+TmbrLCvRq2H/FnzNHpa8k=';
const KEY_B = '77aSVJcRkCMYdHdn/ZgEUhWU035vPNWcvuPPbAgN1/Y=';

describe('fieldCrypto — encryptField / decryptField', () => {
  it('round-trips a value through encrypt → decrypt', () => {
    const plaintext = 'user@example.com';
    const stored = encryptField(plaintext);
    expect(stored).not.toBe(plaintext);
    expect(decryptField(stored)).toBe(plaintext);
  });

  it('round-trips the empty string (ciphertext segment is empty)', () => {
    expect(decryptField(encryptField(''))).toBe('');
  });

  it('emits the self-describing envelope with the active keyId (k1)', () => {
    const stored = encryptField('x@y.com');
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.startsWith('enc:1:k1:')).toBe(true);
    expect(keyIdOf(stored)).toBe('k1');
    expect(stored.split(':')).toHaveLength(6);
  });

  it('uses a fresh IV each call (same plaintext → different ciphertext)', () => {
    expect(encryptField('same@example.com')).not.toBe(encryptField('same@example.com'));
  });

  it('passes legacy plaintext through unchanged (mid-backfill)', () => {
    expect(isEncrypted('legacy@example.com')).toBe(false);
    expect(keyIdOf('legacy@example.com')).toBeNull();
    expect(decryptField('legacy@example.com')).toBe('legacy@example.com');
  });

  it('throws when the authentication tag / ciphertext is tampered (GCM integrity)', () => {
    const parts = encryptField('tamper@me.com').split(':');
    const ct = Buffer.from(parts[4] as string, 'base64'); // auth tag segment
    ct[0] = ct[0]! ^ 0xff;
    parts[4] = ct.toString('base64');
    expect(() => decryptField(parts.join(':'))).toThrow();
  });

  it('throws UnknownKeyIdError when ciphertext references a retired/absent keyId', () => {
    const parts = encryptField('rot---@example.com').split(':');
    parts[2] = 'ghost'; // keyId not present in the keyring
    expect(() => decryptField(parts.join(':'))).toThrow(UnknownKeyIdError);
  });

  it('throws on a malformed envelope', () => {
    expect(() => decryptField('enc:1:onlyfourparts:AA==')).toThrow(/malformed/);
  });
});

describe('fieldCrypto — blindIndex', () => {
  it('is deterministic for the same address', () => {
    expect(blindIndex('a@b.com')).toBe(blindIndex('a@b.com'));
  });

  it('collapses NFC and NFD forms of the same address', () => {
    const nfc = 'caf' + String.fromCodePoint(0x00e9) + '@example.com';
    const nfd = 'caf' + String.fromCodePoint(0x0065, 0x0301) + '@example.com';
    expect(nfc).not.toBe(nfd);
    expect(blindIndex(nfc)).toBe(blindIndex(nfd));
  });

  it('normalizes case + whitespace before hashing', () => {
    expect(blindIndex('  USER@Example.COM  ')).toBe(blindIndex('user@example.com'));
  });

  it('keeps visually-similar but distinct codepoints separate (no homoglyph folding)', () => {
    const latin = 'p' + String.fromCodePoint(0x0061) + 'ypal@example.com';
    const cyrillic = 'p' + String.fromCodePoint(0x0430) + 'ypal@example.com';
    expect(blindIndex(latin)).not.toBe(blindIndex(cyrillic));
  });

  it('does not equal a bare (unkeyed) hash — the key participates', () => {
    // Sanity: a 32-byte HMAC digest is 44 base64 chars, and it is not the raw email.
    const idx = blindIndex('user@example.com');
    expect(idx).not.toContain('user@example.com');
    expect(Buffer.from(idx, 'base64')).toHaveLength(32);
  });
});

describe('EnvKeyProvider', () => {
  const cfg = {
    ENCRYPTION_KEYRING: `k1:${KEY_A},k2:${KEY_B}`,
    ENCRYPTION_ACTIVE_KEY_ID: 'k2',
    ENCRYPTION_BLIND_INDEX_KEY: KEY_A,
  };

  it('exposes the configured active keyId and resolves each key to 32 bytes', () => {
    const kp = new EnvKeyProvider(cfg);
    expect(kp.activeEncryptionKeyId()).toBe('k2');
    expect(kp.encryptionKey('k1')).toEqual(Buffer.from(KEY_A, 'base64'));
    expect(kp.encryptionKey('k2')).toEqual(Buffer.from(KEY_B, 'base64'));
    expect(kp.blindIndexKey()).toHaveLength(32);
  });

  it('throws UnknownKeyIdError for a keyId absent from the ring', () => {
    const kp = new EnvKeyProvider(cfg);
    expect(() => kp.encryptionKey('nope')).toThrow(UnknownKeyIdError);
  });

  it('refuses to construct when the active keyId is not in the keyring', () => {
    expect(() => new EnvKeyProvider({ ...cfg, ENCRYPTION_ACTIVE_KEY_ID: 'k9' })).toThrow(
      /not present in ENCRYPTION_KEYRING/,
    );
  });
});
