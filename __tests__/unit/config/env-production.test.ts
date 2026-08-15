import { assertProductionEnv, ENCRYPTION_DEV_PLACEHOLDER_KEY } from '@/config/env.js';

const STRONG_TOKEN = 'a'.repeat(40);
// Real (non-placeholder) 32-byte base64 keys — distinct from the dev placeholder.
const STRONG_KEYRING = 'k1:xUDmpBXSU0GOwiXb21JUx+TmbrLCvRq2H/FnzNHpa8k=';
const STRONG_BLIND_INDEX_KEY = '77aSVJcRkCMYdHdn/ZgEUhWU035vPNWcvuPPbAgN1/Y=';

const baseProdCfg = (overrides: Partial<Parameters<typeof assertProductionEnv>[0]> = {}) => ({
  NODE_ENV: 'production',
  METRICS_TOKEN: STRONG_TOKEN,
  DISABLE_RATE_LIMIT: false,
  DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM: false,
  ENABLE_ECHO_ROUTES: false,
  ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: false,
  CORS_ORIGIN: 'https://example.com',
  CORS_CREDENTIALS: 'false',
  ENCRYPTION_KEYRING: STRONG_KEYRING,
  ENCRYPTION_BLIND_INDEX_KEY: STRONG_BLIND_INDEX_KEY,
  RESEND_API_KEY: 're_test_key',
  MAIL_FROM: 'Todo API <noreply@example.com>',
  APP_BASE_URL: 'https://app.example.com',
  ALLOW_LOG_MAIL_TRANSPORT_PRODUCTION_CONFIRM: false,
  ...overrides,
});

describe('assertProductionEnv', () => {
  it('returns no errors or warnings for a clean production config', () => {
    const result = assertProductionEnv(baseProdCfg());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('flags missing METRICS_TOKEN in production', () => {
    const result = assertProductionEnv(baseProdCfg({ METRICS_TOKEN: undefined }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/METRICS_TOKEN is required/)]),
    );
  });

  it('flags short METRICS_TOKEN in production', () => {
    const result = assertProductionEnv(baseProdCfg({ METRICS_TOKEN: 'short' }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/at least 32 characters/)]),
    );
  });

  it('errors when DISABLE_RATE_LIMIT=true without the confirmation flag', () => {
    const result = assertProductionEnv(baseProdCfg({ DISABLE_RATE_LIMIT: true }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM=true/)]),
    );
  });

  it('accepts DISABLE_RATE_LIMIT=true paired with the confirmation flag (warning only)', () => {
    const result = assertProductionEnv(
      baseProdCfg({
        DISABLE_RATE_LIMIT: true,
        DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM: true,
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/DISABLE_RATE_LIMIT=true in production with CONFIRM/),
      ]),
    );
  });

  it('flags CORS_ORIGIN="*" with CORS_CREDENTIALS=true', () => {
    const result = assertProductionEnv(baseProdCfg({ CORS_ORIGIN: '*', CORS_CREDENTIALS: 'true' }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/incompatible with CORS_CREDENTIALS/)]),
    );
  });

  it('errors when ENABLE_ECHO_ROUTES=true without the confirmation flag', () => {
    const result = assertProductionEnv(baseProdCfg({ ENABLE_ECHO_ROUTES: true }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM=true/)]),
    );
  });

  it('accepts ENABLE_ECHO_ROUTES=true paired with the confirmation flag (warning only)', () => {
    const result = assertProductionEnv(
      baseProdCfg({
        ENABLE_ECHO_ROUTES: true,
        ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: true,
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ENABLE_ECHO_ROUTES=true in production with CONFIRM/),
      ]),
    );
  });

  it('does NOT flag a bare confirmation flag without ENABLE_ECHO_ROUTES (harmless no-op)', () => {
    // The confirm flag alone is harmless but indicates operator confusion —
    // assertProductionEnv deliberately does not flag it. Documenting the intent:
    // the *combination* is what matters, not the confirm flag in isolation.
    const result = assertProductionEnv(
      baseProdCfg({ ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: true }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('flags an empty ENCRYPTION_KEYRING in production', () => {
    const result = assertProductionEnv(baseProdCfg({ ENCRYPTION_KEYRING: '' }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/ENCRYPTION_KEYRING must be real/)]),
    );
  });

  it('flags the committed dev placeholder key inside ENCRYPTION_KEYRING', () => {
    const result = assertProductionEnv(
      baseProdCfg({ ENCRYPTION_KEYRING: `dev:${ENCRYPTION_DEV_PLACEHOLDER_KEY}` }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/ENCRYPTION_KEYRING must be real/)]),
    );
  });

  it('flags the committed dev placeholder ENCRYPTION_BLIND_INDEX_KEY', () => {
    const result = assertProductionEnv(
      baseProdCfg({ ENCRYPTION_BLIND_INDEX_KEY: ENCRYPTION_DEV_PLACEHOLDER_KEY }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/ENCRYPTION_BLIND_INDEX_KEY must be real/)]),
    );
  });

  it('errors when mail is unconfigured in production', () => {
    const result = assertProductionEnv(baseProdCfg({ RESEND_API_KEY: undefined }));
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/RESEND_API_KEY and MAIL_FROM are required/)]),
    );
  });

  it('errors when APP_BASE_URL is still localhost in production', () => {
    const result = assertProductionEnv(baseProdCfg({ APP_BASE_URL: 'http://localhost:3000' }));
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/APP_BASE_URL must be the real public origin/),
      ]),
    );
  });

  // The docker-compose / e2e shape: production mode, no mail vendor, link read
  // from the log. Both mail checks relax together — a localhost APP_BASE_URL is
  // the right link target when the transport is the log.
  it('accepts unconfigured mail paired with the log-transport confirm flag (warning only)', () => {
    const result = assertProductionEnv(
      baseProdCfg({
        RESEND_API_KEY: undefined,
        MAIL_FROM: undefined,
        APP_BASE_URL: 'http://localhost:3000',
        ALLOW_LOG_MAIL_TRANSPORT_PRODUCTION_CONFIRM: true,
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALLOW_LOG_MAIL_TRANSPORT_PRODUCTION_CONFIRM=true in production/),
      ]),
    );
  });

  it('does NOT warn when the confirm flag is set but mail is fully configured', () => {
    const result = assertProductionEnv(
      baseProdCfg({ ALLOW_LOG_MAIL_TRANSPORT_PRODUCTION_CONFIRM: true }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accumulates multiple errors in a single call', () => {
    const result = assertProductionEnv(
      baseProdCfg({
        METRICS_TOKEN: undefined,
        DISABLE_RATE_LIMIT: true,
      }),
    );
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('returns no errors or warnings outside production (test/dev pass through)', () => {
    expect(
      assertProductionEnv(
        baseProdCfg({
          NODE_ENV: 'development',
          METRICS_TOKEN: undefined,
          DISABLE_RATE_LIMIT: true,
        }),
      ),
    ).toEqual({ errors: [], warnings: [] });

    expect(
      assertProductionEnv(
        baseProdCfg({
          NODE_ENV: 'test',
          METRICS_TOKEN: undefined,
        }),
      ),
    ).toEqual({ errors: [], warnings: [] });
  });
});
