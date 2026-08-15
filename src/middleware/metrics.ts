import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export const register = new Registry();

register.setDefaultLabels({ service: 'todo-api' });

// Skipped under Jest: prom-client's setInterval samplers fire after VM teardown
// and crash with "import after Jest environment has been torn down."
if (env.NODE_ENV !== 'test') {
  collectDefaultMetrics({ register });
}

// --- Custom Metrics ---

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['limiter_type'] as const,
  registers: [register],
});

// Requests served by the per-instance memory fallback because Redis was
// unavailable. Alert on a sustained non-zero rate — caps are degraded from
// global to per-instance while this climbs.
export const rateLimitStoreFallbackTotal = new Counter({
  name: 'rate_limit_store_fallback_total',
  help: 'Rate-limit checks served by the in-memory fallback store (Redis unavailable)',
  labelNames: ['limiter_type'] as const,
  registers: [register],
});

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'model'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const activeConnections = new Gauge({
  name: 'active_connections',
  help: 'Number of active HTTP connections',
  registers: [register],
});

// Audit-event writes outside a $transaction (auth events) cannot roll back
// the user-facing flow on failure, so failures are caught and counted here
// instead. Alert on this counter — a non-zero rate means audit trail gaps.
export const auditWriteFailuresTotal = new Counter({
  name: 'audit_write_failures_total',
  help: 'Audit-log writes that failed outside a $transaction (auth events)',
  labelNames: ['reason'] as const,
  registers: [register],
});

// Verification email send failures. Login is gated on verification, so a silent
// mail outage means every new account is unusable with nothing failing loudly
// in the request path — alert on any sustained non-zero rate.
export const verificationEmailFailuresTotal = new Counter({
  name: 'verification_email_failures_total',
  help: 'Verification emails that failed to send (affected users cannot complete signup)',
  registers: [register],
});

// db_pool_* gauges live in lib/prisma.ts (next to the pool they observe) and
// register against the shared `register` exported above.

// --- Middleware: instrument every request ---

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  activeConnections.inc();
  const end = httpRequestDuration.startTimer();

  res.on('finish', () => {
    const route = normalizeRoute(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
    activeConnections.dec();
  });

  next();
};

// --- Middleware: guard GET /metrics with optional bearer token ---
// Token is read from `Authorization: Bearer …` only. Accepting it via query
// string would leak it into access logs, proxy logs, and browser history.
//
// Hoist the expected-token Buffer once: env.METRICS_TOKEN is immutable
// post-boot, and per-request Buffer.from() is wasted work.
const expectedTokenBuffer: Buffer | null = env.METRICS_TOKEN
  ? Buffer.from(env.METRICS_TOKEN, 'utf8')
  : null;

export const metricsAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (!expectedTokenBuffer) {
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  const provided =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;

  if (provided === undefined) {
    res.status(401).json({
      error: { code: 'NO_TOKEN', message: 'METRICS_TOKEN required' },
    });
    return;
  }

  // timingSafeEqual throws on length mismatch — the length comparison is not
  // a side channel because expectedTokenBuffer.length is fixed at boot time
  // and reveals nothing the operator doesn't already know.
  const providedBuffer = Buffer.from(provided, 'utf8');
  const valid =
    providedBuffer.length === expectedTokenBuffer.length &&
    timingSafeEqual(providedBuffer, expectedTokenBuffer);

  if (!valid) {
    res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Invalid METRICS_TOKEN' },
    });
    return;
  }

  next();
};

// --- Handler: GET /metrics ---

export const metricsHandler = async (_req: Request, res: Response): Promise<void> => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
};

// --- Helpers ---

// Unmatched requests share a single label so scans/typos/trailing-slash quirks
// can't blow up Prometheus cardinality. The actual path is still in access logs
// if you need to investigate a specific 404.
const UNMATCHED_ROUTE = 'unmatched';

const normalizeRoute = (req: Request): string => {
  if (req.route?.path) {
    return req.baseUrl + (req.route.path === '/' ? '' : req.route.path);
  }
  return UNMATCHED_ROUTE;
};
