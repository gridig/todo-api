import { config } from 'dotenv';

config({ path: '.env.test' });

// Set test environment variables
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.NODE_ENV = 'test';

// Field-encryption keys. Set here (in addition to .env.test) so they are present
// before src/config/env.ts is imported, exactly like JWT_SECRET above. Fixed
// non-secret 32-byte base64 test keys — safe to commit.
process.env.ENCRYPTION_KEYRING ??= 'k1:xUDmpBXSU0GOwiXb21JUx+TmbrLCvRq2H/FnzNHpa8k=';
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.ENCRYPTION_BLIND_INDEX_KEY ??= '77aSVJcRkCMYdHdn/ZgEUhWU035vPNWcvuPPbAgN1/Y=';
