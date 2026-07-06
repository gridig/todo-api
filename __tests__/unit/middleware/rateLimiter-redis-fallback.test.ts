import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Redis configured but unavailable: connect() rejects and isReady stays false.
// The limiters must keep answering from the per-instance memory fallback —
// counting and 429ing normally, never surfacing a store error as a 500.

jest.unstable_mockModule('@/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379',
    DISABLE_RATE_LIMIT: false,
  },
}));

const mockOn = jest.fn();
const mockConnect = jest
  .fn<() => Promise<void>>()
  .mockRejectedValue(new Error('ECONNREFUSED'));

jest.unstable_mockModule('redis', () => ({
  createClient: jest.fn(() => ({
    on: mockOn,
    connect: mockConnect,
    isReady: false,
    sendCommand: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('not connected')),
  })),
}));

// A RedisStore whose every operation rejects — mimics rate-limit-redis when
// the client never connected. FallbackStore must route around it.
jest.unstable_mockModule('rate-limit-redis', () => ({
  RedisStore: class DeadRedisStore {
    init = jest.fn();
    increment = jest
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error('Redis unavailable'));
    decrement = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('Redis unavailable'));
    resetKey = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('Redis unavailable'));
  },
}));

describe('rateLimiter with unreachable Redis', () => {
  it('serves limiting from the memory fallback instead of erroring', async () => {
    const { buildLimiter, redisClient } = await import('@/middleware/rateLimiter.js');

    // Client kept (not nulled) so a later reconnect can restore delegation.
    expect(redisClient).not.toBeNull();

    const app = express();
    app.use(express.json());
    app.post('/login', buildLimiter('auth', { skip: () => false }), (_req, res) => {
      res.status(401).json({ error: 'invalid' });
    });

    const attempt = () => request(app).post('/login').send({ email: 'a@b.c' });

    for (let i = 0; i < 3; i++) {
      const res = await attempt();
      expect(res.status).toBe(401); // memory fallback counts, no 500
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
  });
});
