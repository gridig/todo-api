import express from 'express';
import request from 'supertest';
import { buildLimiter } from '@/middleware/rateLimiter.js';

// End-to-end limiter semantics. Limiters are compile-time skipped in the test
// env (NODE_ENV=test), so these tests build live instances via buildLimiter
// with `skip` disabled and drive a scratch app — real counting, real 429s.
const buildLoginApp = () => {
  const app = express();
  app.use(express.json());
  app.post('/login', buildLimiter('auth', { skip: () => false }), (req, res) => {
    if (req.body.ok === true) {
      res.status(200).json({ token: 'x' });
    } else {
      res.status(401).json({ error: 'invalid' });
    }
  });
  return app;
};

describe('auth limiter (live instance)', () => {
  it('returns 429 with draft-7 headers on the 4th failed login', async () => {
    const app = buildLoginApp();
    const attempt = () => request(app).post('/login').send({ email: 'a@b.c', ok: false });

    for (let i = 0; i < 3; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['ratelimit']).toBeDefined();
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
    expect(blocked.body).toEqual({ error: 'Too many login attempts, please try again later.' });
  });

  it('does not count successful logins toward the failed-attempt cap', async () => {
    const app = buildLoginApp();
    const attempt = (ok: boolean) => request(app).post('/login').send({ email: 'a@b.c', ok });

    // Successes are decremented (skipSuccessfulRequests) — a user logging in
    // repeatedly with the right password must never hit the cap.
    for (let i = 0; i < 5; i++) {
      const res = await attempt(true);
      expect(res.status).toBe(200);
    }

    // The failed-attempt budget is still fully available afterwards.
    for (let i = 0; i < 3; i++) {
      const res = await attempt(false);
      expect(res.status).toBe(401);
    }
    const blocked = await attempt(false);
    expect(blocked.status).toBe(429);
  });

  it('keys per (ip, email): one account hitting the cap does not block another', async () => {
    const app = buildLoginApp();

    for (let i = 0; i < 4; i++) {
      await request(app).post('/login').send({ email: 'victim@example.com', ok: false });
    }
    const other = await request(app).post('/login').send({ email: 'other@example.com', ok: false });
    expect(other.status).toBe(401);
  });
});

// The gap the compound (ip, email) key leaves open: rotating the target email
// mints a fresh bucket, so nothing above bounds one IP stuffing many accounts.
describe('login-ip limiter (live instance)', () => {
  const buildIpLimitedApp = () => {
    const app = express();
    app.use(express.json());
    app.post('/login', buildLimiter('login-ip', { skip: () => false, max: 5 }), (req, res) => {
      if (req.body.ok === true) {
        res.status(200).json({ token: 'x' });
      } else {
        res.status(401).json({ error: 'invalid' });
      }
    });
    return app;
  };

  it('caps failed logins per IP even when every attempt targets a different account', async () => {
    const app = buildIpLimitedApp();
    const attempt = (n: number) =>
      request(app)
        .post('/login')
        .send({ email: `victim-${n}@example.com`, ok: false });

    for (let i = 0; i < 5; i++) {
      expect((await attempt(i)).status).toBe(401);
    }

    const blocked = await attempt(99);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: 'Too many failed login attempts from this network. Please try again later.',
    });
  });

  it('does not count successful logins, so a shared egress IP is unaffected', async () => {
    const app = buildIpLimitedApp();

    // Ten distinct accounts logging in successfully from one NAT'd address.
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/login')
        .send({ email: `user-${i}@example.com`, ok: true });
      expect(res.status).toBe(200);
    }

    // The failure budget is untouched.
    for (let i = 0; i < 5; i++) {
      expect(
        (await request(app).post('/login').send({ email: 'x@example.com', ok: false })).status,
      ).toBe(401);
    }
    expect(
      (await request(app).post('/login').send({ email: 'x@example.com', ok: false })).status,
    ).toBe(429);
  });
});

describe('user-export limiter (live instance)', () => {
  // One app, therefore one limiter and one store — otherwise the per-user
  // keying assertion below would pass simply because each app had a fresh
  // counter, whatever the key generator did.
  const buildExportApp = () => {
    const app = express();
    // Stands in for the auth middleware, which populates req.userId before the
    // limiter's key generator reads it.
    app.use((req, _res, next) => {
      req.userId = (req.headers['x-test-user'] as string) ?? 'anonymous';
      next();
    });
    app.get('/export', buildLimiter('user-export', { skip: () => false, max: 2 }), (_req, res) => {
      res.status(200).json({ todos: [] });
    });
    return app;
  };

  const exportAs = (app: express.Express, user: string) =>
    request(app).get('/export').set('x-test-user', user);

  it('caps exports per user and reports the export-specific message', async () => {
    const app = buildExportApp();

    expect((await exportAs(app, 'user-a')).status).toBe(200);
    expect((await exportAs(app, 'user-a')).status).toBe(200);

    const blocked = await exportAs(app, 'user-a');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many export requests. Please try again later.' });
  });

  it('keys by user, not IP: one account exhausting its budget does not block another', async () => {
    const app = buildExportApp();

    for (let i = 0; i < 3; i++) await exportAs(app, 'user-a');
    expect((await exportAs(app, 'user-a')).status).toBe(429);

    // Same source IP, same limiter instance, different account.
    expect((await exportAs(app, 'user-b')).status).toBe(200);
  });
});
