import { jest } from '@jest/globals';
import type { Request } from 'express';
import {
  logRateLimitHandler,
  loginEmailKey,
  authLimiterKeyGenerator,
  authLimiter,
  loginEmailLimiter,
  registerLimiter,
  globalLimiter,
  readLimiter,
  writeLimiter,
  healthLimiter,
} from '../../../middleware/rateLimiter.js';

describe('Rate Limiter Middleware', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let req: any;
  let res: any;
  let next: jest.Mock;
  let options: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    req = {
      userId: 'test-user',
      ip: '127.0.0.1',
      path: '/test',
      get: jest.fn().mockReturnValue('test-agent'),
      log: {
        warn: jest.fn(),
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    options = {
      message: { error: 'Rate limit exceeded' },
    };
  });

  describe('logRateLimitHandler', () => {
    it.each(['auth', 'write', 'read', 'global', 'register', 'login-email'])(
      'should log and return 429 for %s rate limit',
      (type) => {
        const handler = logRateLimitHandler(type);

        handler(req, res, next, options);

        expect(req.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'test-user',
            ip: '127.0.0.1',
            path: '/test',
            limitType: type,
            userAgent: 'test-agent',
          }),
          `Rate limit exceeded - ${type}`,
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith(options.message);
      },
    );

    it('should use module logger when req.log is not available', () => {
      delete req.log;

      const handler = logRateLimitHandler('auth');

      expect(() => handler(req, res, next, options)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(options.message);
    });
  });

  describe('loginEmailKey', () => {
    const asReq = (body: unknown): Request => ({ body }) as Request;

    it('normalizes email to lowercase + trimmed', () => {
      expect(loginEmailKey(asReq({ email: '  Test@EXAMPLE.com  ' }))).toBe('test@example.com');
    });

    it('returns "" when body is missing', () => {
      expect(loginEmailKey({ body: undefined } as unknown as Request)).toBe('');
    });

    it('returns "" when body has no email field', () => {
      expect(loginEmailKey(asReq({ password: 'x' }))).toBe('');
    });

    it('returns "" when email is not a string (defensive against malformed JSON)', () => {
      expect(loginEmailKey(asReq({ email: 42 }))).toBe('');
      expect(loginEmailKey(asReq({ email: null }))).toBe('');
      expect(loginEmailKey(asReq({ email: { nested: 'x' } }))).toBe('');
    });

    it('returns "" when body is not an object (e.g. raw string body)', () => {
      expect(loginEmailKey(asReq('not-an-object'))).toBe('');
    });

    describe('Unicode normalization (NFC)', () => {
      it('produces the same key for NFC and NFD forms of the same email', () => {
        // Build forms via fromCodePoint so source literals can't be coalesced.
        // NFC: U+00E9. NFD: U+0065 + U+0301 (combining acute).
        const nfc = 'caf' + String.fromCodePoint(0x00e9) + '@example.com';
        const nfd = 'caf' + String.fromCodePoint(0x0065, 0x0301) + '@example.com';
        expect(nfc).not.toBe(nfd);
        expect(loginEmailKey(asReq({ email: nfc }))).toBe(loginEmailKey(asReq({ email: nfd })));
      });

      it('does not coalesce visually-similar but distinct codepoints (homoglyphs survive intentionally)', () => {
        // Canonicalization is not visual matching. Cyrillic 'a' (U+0430) vs
        // Latin 'a' (U+0061) remain distinct under NFC. The DB unique
        // constraint enforces single-form ownership; the rate-limit key
        // treats them as separate accounts.
        const latin = 'p' + String.fromCodePoint(0x0061) + 'ypal@example.com';
        const cyrillic = 'p' + String.fromCodePoint(0x0430) + 'ypal@example.com';
        expect(latin).not.toBe(cyrillic);
        expect(loginEmailKey(asReq({ email: latin }))).not.toBe(
          loginEmailKey(asReq({ email: cyrillic })),
        );
      });
    });
  });

  describe('authLimiterKeyGenerator', () => {
    const asReq = (overrides: Partial<Request>): Request => ({ body: {}, ...overrides }) as Request;

    it('composes the IPv4 IP with normalized email', () => {
      const key = authLimiterKeyGenerator(
        asReq({ ip: '203.0.113.7', body: { email: ' Foo@Example.com ' } }),
      );
      expect(key).toBe('203.0.113.7:foo@example.com');
    });

    it('collapses IPv6 /64 via ipKeyGenerator (defeats /64-walking bypass)', () => {
      const key = authLimiterKeyGenerator(
        asReq({ ip: '2001:db8:abcd:1234::1', body: { email: 'a@b.com' } }),
      );
      // Anything in the same /64 must produce the same prefix; we just
      // check the email tail and that the prefix is non-trivial.
      expect(key.endsWith(':a@b.com')).toBe(true);
      expect(key.split(':a@')[0]?.length).toBeGreaterThan(0);
    });

    it('falls back to "unknown" when req.ip is undefined', () => {
      const key = authLimiterKeyGenerator(asReq({ ip: undefined, body: { email: 'x@y.com' } }));
      expect(key).toBe('unknown:x@y.com');
    });

    it('produces a stable key when email is missing (empty-key bucket)', () => {
      const key = authLimiterKeyGenerator(asReq({ ip: '127.0.0.1', body: {} }));
      expect(key).toBe('127.0.0.1:');
    });
  });

  describe('exported limiters', () => {
    it('exports all expected limiters including loginEmailLimiter', () => {
      // Regression guard: if any of these are renamed/removed, route mounts
      // break at import time. The new loginEmailLimiter is explicitly listed
      // because its absence would silently disable per-email brute-force
      // protection on /auth/login.
      expect(typeof authLimiter).toBe('function');
      expect(typeof loginEmailLimiter).toBe('function');
      expect(typeof registerLimiter).toBe('function');
      expect(typeof globalLimiter).toBe('function');
      expect(typeof readLimiter).toBe('function');
      expect(typeof writeLimiter).toBe('function');
      expect(typeof healthLimiter).toBe('function');
    });
  });
});
