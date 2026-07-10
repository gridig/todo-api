// Key custody for field-level encryption. Today keys come from env vars
// (Railway per-environment secrets); the KeyProvider interface exists so a
// managed KMS (AWS KMS, Vault) can be dropped in later — implement the same
// interface and swap the exported `keyProvider` — without touching any call
// site in fieldCrypto.ts. The env parsing happens once at module load (the
// same "hoist the secret once" idiom as middleware/metrics.ts), so no per-call
// base64 decode and a malformed active keyId fails at boot, not first use.
import { env } from '../../config/env.js';

export interface KeyProvider {
  /** keyId used to encrypt new values. */
  activeEncryptionKeyId(): string;
  /** 32-byte AES key for a given keyId. Throws UnknownKeyIdError if retired/absent. */
  encryptionKey(keyId: string): Buffer;
  /** 32-byte HMAC key for the deterministic blind index. */
  blindIndexKey(): Buffer;
}

// Thrown when ciphertext embeds a keyId no longer present in the keyring — i.e.
// a key was retired before its rows were re-encrypted. Surfaced distinctly so
// the runbook's "retire only after a re-encryption sweep" rule is diagnosable.
export class UnknownKeyIdError extends Error {
  constructor(keyId: string) {
    super(`No encryption key in the keyring for keyId "${keyId}"`);
    this.name = 'UnknownKeyIdError';
  }
}

const parseKeyring = (raw: string): Map<string, Buffer> => {
  const map = new Map<string, Buffer>();
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const sep = entry.indexOf(':');
    const keyId = entry.slice(0, sep);
    const keyB64 = entry.slice(sep + 1);
    map.set(keyId, Buffer.from(keyB64, 'base64'));
  }
  return map;
};

export interface KeyProviderConfig {
  ENCRYPTION_KEYRING: string;
  ENCRYPTION_ACTIVE_KEY_ID: string;
  ENCRYPTION_BLIND_INDEX_KEY: string;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keyring: Map<string, Buffer>;
  private readonly activeKeyId: string;
  private readonly biKey: Buffer;

  constructor(config: KeyProviderConfig) {
    this.keyring = parseKeyring(config.ENCRYPTION_KEYRING);
    this.activeKeyId = config.ENCRYPTION_ACTIVE_KEY_ID;
    // Cross-field invariant cleanEnv can't express per-variable: the active
    // keyId must resolve to a key in the ring, or every new write would throw.
    if (!this.keyring.has(this.activeKeyId)) {
      throw new Error(
        `ENCRYPTION_ACTIVE_KEY_ID "${this.activeKeyId}" is not present in ENCRYPTION_KEYRING`,
      );
    }
    this.biKey = Buffer.from(config.ENCRYPTION_BLIND_INDEX_KEY, 'base64');
  }

  activeEncryptionKeyId(): string {
    return this.activeKeyId;
  }

  encryptionKey(keyId: string): Buffer {
    const key = this.keyring.get(keyId);
    if (!key) throw new UnknownKeyIdError(keyId);
    return key;
  }

  blindIndexKey(): Buffer {
    return this.biKey;
  }
}

export const keyProvider: KeyProvider = new EnvKeyProvider(env);
