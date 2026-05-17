import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
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

// db_pool_* gauges live in lib/prisma.ts (next to the pool they observe) and
// register against the shared `register` exported above.

// --- Middleware: instrument every request ---

export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
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

export const metricsAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!env.METRICS_TOKEN) {
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

  if (provided !== env.METRICS_TOKEN) {
    res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Invalid METRICS_TOKEN' },
    });
    return;
  }

  next();
};

// --- Handler: GET /metrics ---

export const metricsHandler = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
};

// --- Helpers ---

const normalizeRoute = (req: Request): string => {
  // Use the matched Express route pattern if available, otherwise fall back to path
  if (req.route?.path) {
    return req.baseUrl + (req.route.path === '/' ? '' : req.route.path);
  }
  // Collapse UUID-like segments to :id to avoid high-cardinality labels
  return req.path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id',
  );
};
