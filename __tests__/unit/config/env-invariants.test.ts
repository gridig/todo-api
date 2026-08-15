import { assertEnvInvariants } from '@/config/env.js';

const baseCfg = (overrides: Partial<Parameters<typeof assertEnvInvariants>[0]> = {}) => ({
  SHUTDOWN_DELAY_MS: 5000,
  SHUTDOWN_TIMEOUT_MS: 10000,
  DB_POOL_MAX: 10,
  DB_POOL_MIN: 2,
  JWT_SECRET: 'a'.repeat(40),
  JWT_SECRET_PREVIOUS: undefined,
  ...overrides,
});

describe('assertEnvInvariants', () => {
  it('returns no errors for the shipped defaults', () => {
    expect(assertEnvInvariants(baseCfg())).toEqual([]);
  });

  it('rejects a shutdown timeout at or below the drain delay', () => {
    // Equal is still wrong: the force-exit timer is armed before the drain
    // starts, so the drain window would be exactly zero.
    expect(assertEnvInvariants(baseCfg({ SHUTDOWN_TIMEOUT_MS: 5000 }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/must exceed SHUTDOWN_DELAY_MS/)]),
    );
    expect(assertEnvInvariants(baseCfg({ SHUTDOWN_TIMEOUT_MS: 4000 }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/must exceed SHUTDOWN_DELAY_MS/)]),
    );
  });

  it('accepts a shutdown timeout above the drain delay', () => {
    expect(assertEnvInvariants(baseCfg({ SHUTDOWN_TIMEOUT_MS: 5001 }))).toEqual([]);
  });

  it('rejects a pool max below 1', () => {
    expect(assertEnvInvariants(baseCfg({ DB_POOL_MAX: 0, DB_POOL_MIN: 0 }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/DB_POOL_MAX \(0\) must be at least 1/)]),
    );
  });

  it('rejects a pool min above the pool max', () => {
    expect(assertEnvInvariants(baseCfg({ DB_POOL_MAX: 2, DB_POOL_MIN: 5 }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/DB_POOL_MIN \(5\) must not exceed/)]),
    );
  });

  it('rejects a rotation window where both JWT secrets are identical', () => {
    const secret = 'b'.repeat(40);
    expect(
      assertEnvInvariants(baseCfg({ JWT_SECRET: secret, JWT_SECRET_PREVIOUS: secret })),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/JWT_SECRET_PREVIOUS must differ/)]));
  });

  it('accepts a rotation window with two distinct secrets', () => {
    expect(
      assertEnvInvariants(
        baseCfg({ JWT_SECRET: 'b'.repeat(40), JWT_SECRET_PREVIOUS: 'c'.repeat(40) }),
      ),
    ).toEqual([]);
  });

  it('reports every violation at once rather than stopping at the first', () => {
    const errors = assertEnvInvariants(
      baseCfg({ SHUTDOWN_TIMEOUT_MS: 1000, DB_POOL_MAX: 0, DB_POOL_MIN: 3 }),
    );

    expect(errors).toHaveLength(3);
  });
});
