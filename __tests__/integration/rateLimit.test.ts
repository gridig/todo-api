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
