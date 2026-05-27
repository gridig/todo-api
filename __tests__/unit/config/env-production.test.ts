import { assertProductionEnv } from '@/config/env.js';

const STRONG_TOKEN = 'a'.repeat(40);

const baseProdCfg = (overrides: Partial<Parameters<typeof assertProductionEnv>[0]> = {}) => ({
  NODE_ENV: 'production',
  METRICS_TOKEN: STRONG_TOKEN,
  DISABLE_RATE_LIMIT: false,
  DISABLE_RATE_LIMIT_PRODUCTION_CONFIRM: false,
  ENABLE_ECHO_ROUTES: false,
  ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: false,
  CORS_ORIGIN: 'https://example.com',
  CORS_CREDENTIALS: 'false',
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

  it('errors when the confirmation flag is set without ENABLE_ECHO_ROUTES (no-op left bare)', () => {
    // The confirm flag alone is harmless but indicates operator confusion —
    // assertProductionEnv currently does not flag it. Documenting the intent:
    // the *combination* is what matters, not the confirm flag in isolation.
    const result = assertProductionEnv(
      baseProdCfg({ ENABLE_ECHO_ROUTES_PRODUCTION_CONFIRM: true }),
    );
    expect(result.errors).toEqual([]);
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
