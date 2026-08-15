import type { Router } from 'express';
import authRoutes from '@/routes/auth.js';
import todoRoutes from '@/routes/todos.js';
import userRoutes from '@/routes/user.js';
import adminRoutes from '@/routes/admin.js';
import { auth } from '@/middleware/auth.js';
import { requireAdmin } from '@/middleware/authorize.js';
import {
  authLimiter,
  emailChangeLimiter,
  loginEmailLimiter,
  loginIpLimiter,
  exportLimiter,
  registerLimiter,
  refreshLimiter,
  resendVerificationLimiter,
  verifyEmailLimiter,
  readLimiter,
  writeLimiter,
} from '@/middleware/rateLimiter.js';

// Rate limiting is compiled out under NODE_ENV=test, so no integration test
// can catch a limiter being unmounted from a route — this file guards the
// WIRING by identity: each route's middleware stack must contain the exact
// limiter (and auth/requireAdmin) instances the security model requires.
// Deleting `authLimiter` from the login route fails here, not in production.

/* eslint-disable @typescript-eslint/no-explicit-any */
interface RouteInfo {
  path: string;
  methods: Record<string, boolean>;
  handlers: unknown[];
}

const routesOf = (router: Router): RouteInfo[] =>
  (router as any).stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      path: layer.route.path,
      methods: layer.route.methods,
      handlers: layer.route.stack.map((l: any) => l.handle),
    }));

const findRoute = (router: Router, method: string, path: string): RouteInfo => {
  const match = routesOf(router).find((r) => r.path === path && r.methods[method]);
  if (!match) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
  return match;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('route middleware wiring', () => {
  describe('auth routes', () => {
    it('POST /register mounts registerLimiter', () => {
      expect(findRoute(authRoutes, 'post', '/register').handlers).toContain(registerLimiter);
    });

    it('POST /login mounts all three login limiters', () => {
      const { handlers } = findRoute(authRoutes, 'post', '/login');
      expect(handlers).toContain(authLimiter);
      expect(handlers).toContain(loginEmailLimiter);
      // Without this one, rotating the target email defeats the compound key.
      expect(handlers).toContain(loginIpLimiter);
    });

    it('POST /verify mounts verifyEmailLimiter', () => {
      expect(findRoute(authRoutes, 'post', '/verify').handlers).toContain(verifyEmailLimiter);
    });

    it('POST /resend-verification mounts resendVerificationLimiter', () => {
      // Unmounting this one turns the endpoint into a mail-bomb primitive
      // against any address, so guard the wiring explicitly.
      expect(findRoute(authRoutes, 'post', '/resend-verification').handlers).toContain(
        resendVerificationLimiter,
      );
    });

    it('POST /verify-email-change mounts verifyEmailLimiter', () => {
      expect(findRoute(authRoutes, 'post', '/verify-email-change').handlers).toContain(
        verifyEmailLimiter,
      );
    });

    it('POST /refresh and /logout mount refreshLimiter', () => {
      expect(findRoute(authRoutes, 'post', '/refresh').handlers).toContain(refreshLimiter);
      expect(findRoute(authRoutes, 'post', '/logout').handlers).toContain(refreshLimiter);
    });

    it('POST /logout-all mounts writeLimiter and auth', () => {
      const { handlers } = findRoute(authRoutes, 'post', '/logout-all');
      expect(handlers).toContain(writeLimiter);
      expect(handlers).toContain(auth);
    });
  });

  describe('todo routes', () => {
    it.each([
      ['get', '/', readLimiter],
      ['post', '/', writeLimiter],
      ['get', '/:id', readLimiter],
      ['patch', '/:id', writeLimiter],
      ['delete', '/:id', writeLimiter],
    ])('%s %s mounts auth and the correct limiter', (method, path, limiter) => {
      const { handlers } = findRoute(todoRoutes, method as string, path as string);
      expect(handlers).toContain(auth);
      expect(handlers).toContain(limiter);
    });
  });

  describe('user routes', () => {
    it.each([
      ['get', '/me', readLimiter],
      ['patch', '/me', writeLimiter],
      ['patch', '/me/email', writeLimiter],
      ['patch', '/me/password', writeLimiter],
      ['delete', '/me', writeLimiter],
      ['get', '/me/export', exportLimiter],
    ])('%s %s mounts auth and the correct limiter', (method, path, limiter) => {
      const { handlers } = findRoute(userRoutes, method as string, path as string);
      expect(handlers).toContain(auth);
      expect(handlers).toContain(limiter);
    });

    it('PATCH /me/email also mounts the per-address email-change limiter', () => {
      // writeLimiter bounds the caller; this one bounds mail sent to the address
      // the caller names, which is the abuse that reaches someone else's inbox.
      expect(findRoute(userRoutes, 'patch', '/me/email').handlers).toContain(emailChangeLimiter);
    });
  });

  describe('admin routes', () => {
    it.each([
      ['get', '/users', readLimiter],
      ['get', '/users/:id', readLimiter],
      ['patch', '/users/:id/role', writeLimiter],
      ['delete', '/users/:id', writeLimiter],
    ])('%s %s mounts auth, requireAdmin, and the correct limiter', (method, path, limiter) => {
      const { handlers } = findRoute(adminRoutes, method as string, path as string);
      expect(handlers).toContain(auth);
      expect(handlers).toContain(requireAdmin);
      expect(handlers).toContain(limiter);
    });

    it('every admin route is behind requireAdmin (no unguarded additions)', () => {
      for (const route of routesOf(adminRoutes)) {
        expect(route.handlers).toContain(requireAdmin);
      }
    });
  });
});
