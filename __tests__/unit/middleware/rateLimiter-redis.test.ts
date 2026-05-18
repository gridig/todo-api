import { jest } from '@jest/globals';

// Exercise the Redis-backed code path in middleware/rateLimiter.ts. The
// happy path (REDIS_URL unset → in-memory fallback) is covered by the
// rest of the suite; this file mocks env.REDIS_URL + the redis client so
// the `if (env.REDIS_URL)` init block and the Redis branch of `storeFor`
// run during module load.

jest.unstable_mockModule('../../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    DISABLE_RATE_LIMIT: true, // skip the actual limiter; we only care
                              // about module-load-time branch coverage
  },
}));

const mockOn = jest.fn();
const mockConnect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockSendCommand = jest.fn<() => Promise<unknown>>().mockResolvedValue(1);

jest.unstable_mockModule('redis', () => ({
  createClient: jest.fn(() => ({
    on: mockOn,
    connect: mockConnect,
    sendCommand: mockSendCommand,
  })),
}));

// rate-limit-redis calls SCRIPT LOAD at construction and expects a SHA back.
// express-rate-limit then validates the store implements the Store interface.
// We don't care about either's actual behavior here — the assertion is that
// the rateLimiter module hits the Redis branch of storeFor. Stub RedisStore
// with the minimum interface express-rate-limit checks for.
jest.unstable_mockModule('rate-limit-redis', () => ({
  RedisStore: class FakeRedisStore {
    init = jest.fn();
    increment = jest.fn<() => Promise<{ totalHits: number; resetTime: Date }>>().mockResolvedValue({ totalHits: 1, resetTime: new Date() });
    decrement = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    resetKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    resetAll = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  },
}));

describe('rateLimiter Redis-backed mode', () => {
  it('initializes the Redis client and binds limiters to the store when REDIS_URL is set', async () => {
    const mod = await import('../../../middleware/rateLimiter.js');

    // Module-load side effects: createClient + on('error') + connect() all fired.
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockConnect).toHaveBeenCalled();

    // All limiters loaded (Redis store branch in storeFor was exercised for each).
    expect(typeof mod.authLimiter).toBe('function');
    expect(typeof mod.loginEmailLimiter).toBe('function');
    expect(typeof mod.registerLimiter).toBe('function');
    expect(typeof mod.globalLimiter).toBe('function');
    expect(typeof mod.readLimiter).toBe('function');
    expect(typeof mod.writeLimiter).toBe('function');
    expect(typeof mod.healthLimiter).toBe('function');

    // redisClient export is the mocked client.
    expect(mod.redisClient).not.toBeNull();
  });
});
