// Application-layer field encryption for PII at rest (SOC 2 CC6.1 / C1.1).
//
// Two primitives:
//   - encryptField / decryptField: AES-256-GCM (authenticated) with a random
//     per-value IV. Randomized ⇒ not usable for equality lookups or a UNIQUE
//     constraint. Stored as a self-describing envelope:
//         enc:1:<keyId>:<iv_b64>:<tag_b64>:<ct_b64>
//     The `enc:1:` prefix versions the scheme and lets decryptField pass
//     legacy plaintext through untouched during a backfill. keyId is embedded
//     so decrypt selects the right key and ciphertext-key rotation is lazy.
//   - blindIndex: keyed HMAC-SHA256 over the canonical email. Deterministic ⇒
//     it carries the lookup and the UNIQUE constraint (users.email_hash). Keyed
//     (not bare SHA-256) so the column is not an offline-enumerable oracle.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { keyProvider } from './keyProvider.js';
import { normalizeEmail } from '../normalizeEmail.js';

const SCHEME = 'enc:1';
const ENVELOPE_PREFIX = `${SCHEME}:`;
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV — the GCM standard, safe with random IVs at our volume.
// Additional authenticated data binds ciphertext to this field/context so a
// value can't be lifted and replayed into a different column with a different
// AAD. Bump alongside SCHEME if the context ever changes.
const AAD = Buffer.from('user.email:1');
const ENVELOPE_PARTS = 6; // enc : 1 : keyId : iv : tag : ct

export function isEncrypted(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(ENVELOPE_PREFIX);
}

// keyId embedded in a stored value, or null for legacy plaintext. Lets callers
// decide whether a row needs re-encryption to the active key.
export function keyIdOf(stored: string): string | null {
  if (!isEncrypted(stored)) return null;
  return stored.split(':')[2] ?? null;
}

export function encryptField(plaintext: string): string {
  const keyId = keyProvider.activeEncryptionKeyId();
  const key = keyProvider.encryptionKey(keyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SCHEME,
    keyId,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptField(stored: string): string {
  // Legacy/unencrypted rows (mid-backfill) pass through unchanged.
  if (!isEncrypted(stored)) return stored;

  const parts = stored.split(':');
  if (parts.length !== ENVELOPE_PARTS) {
    throw new Error('decryptField: malformed ciphertext envelope');
  }
  const keyId = parts[2];
  const ivB64 = parts[3];
  const tagB64 = parts[4];
  const ctB64 = parts[5];
  // ctB64 may legitimately be '' (empty-string plaintext), so only guard undefined.
  if (!keyId || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error('decryptField: malformed ciphertext envelope');
  }

  const key = keyProvider.encryptionKey(keyId); // throws UnknownKeyIdError if retired
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64')); // GCM tag mismatch ⇒ final() throws
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

// Deterministic keyed hash of the canonical email. Same input (across Unicode
// variants) ⇒ same output, so it backs both findByEmail and the UNIQUE index.
export function blindIndex(email: string): string {
  return createHmac('sha256', keyProvider.blindIndexKey())
    .update(normalizeEmail(email))
    .digest('base64');
}
