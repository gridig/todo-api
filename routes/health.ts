import express, { Response, Router } from 'express';
import os from 'os';
import { env } from '../config/env.js';
import { getPoolMetrics, POOL_UTILIZATION_WARN_THRESHOLD, probeDatabase } from '../lib/prisma.js';
import { healthLimiter } from '../middleware/rateLimiter.js';
import { metricsAuthMiddleware } from '../middleware/metrics.js';
import type { RequestWithLogger } from '../types/index.js';

const router: Router = express.Router();

// Track server start time for uptime calculation
const startTime = Date.now();

// Thresholds for health checks (configurable)
const MEMORY_THRESHOLD_PERCENT = 90; // Warn if heap usage exceeds 90%
const CPU_LOAD_THRESHOLD = os.cpus().length; // Warn if load average exceeds CPU count

// Helper to format bytes to human-readable
const formatBytes = (bytes: number): string => {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(2)} MB`;
};

// Liveness probe - is the server running?
router.get('/', (req: RequestWithLogger, res: Response) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const { log } = req;

  log.debug({ uptime }, 'Health check - liveness probe');

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime,
    version: '1.0.0',
    environment: env.NODE_ENV,
  });
});

// Build the rich readiness payload. Extracted so /ready and /ready/detailed
// share the underlying probe + assembly logic; the two endpoints differ only
// in which slice of this payload reaches the wire.
interface ReadinessOutcome {
  isReady: boolean;
  isDatabaseReady: boolean;
  payload: Record<string, unknown>;
}

async function buildReadinessPayload(log: RequestWithLogger['log']): Promise<ReadinessOutcome> {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  let isDatabaseReady = false;
  let databaseState: string;
  try {
    await probeDatabase();
    isDatabaseReady = true;
    databaseState = 'connected';
  } catch (error) {
    databaseState = 'error';
    log.error({ err: error }, 'Database health check failed');
  }

  const memoryUsage = process.memoryUsage();
  const heapUsedPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
  const isMemoryOk = heapUsedPercent < MEMORY_THRESHOLD_PERCENT;

  const loadAverage = os.loadavg();
  const cpuCount = os.cpus().length;
  const load1m = loadAverage[0] ?? 0;
  const load5m = loadAverage[1] ?? 0;
  const load15m = loadAverage[2] ?? 0;
  const isCpuOk = load1m < CPU_LOAD_THRESHOLD;

  // Saturation IS a readiness failure: a reachable DB but a full pool with
  // queued clients means the next request has to wait. Memory and CPU stay
  // observational — load lingers ~60s after a burst; OOM is a liveness
  // concern, not readiness.
  const poolMetrics = getPoolMetrics();
  const isPoolSaturated =
    poolMetrics.idleConnections === 0 &&
    poolMetrics.totalConnections >= poolMetrics.maxConnections &&
    poolMetrics.waitingClients > 0;
  const poolStatus = isPoolSaturated
    ? 'error'
    : poolMetrics.utilization >= POOL_UTILIZATION_WARN_THRESHOLD
      ? 'warning'
      : 'ok';

  const isReady = isDatabaseReady && !isPoolSaturated;

  const payload = {
    status: isReady ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime,
    version: '1.0.0',
    environment: env.NODE_ENV,
    checks: {
      database: {
        status: isDatabaseReady ? 'ok' : 'error',
        state: databaseState,
      },
      memory: {
        status: isMemoryOk ? 'ok' : 'warning',
        heapUsed: formatBytes(memoryUsage.heapUsed),
        heapTotal: formatBytes(memoryUsage.heapTotal),
        heapUsedPercent: `${heapUsedPercent.toFixed(1)}%`,
        rss: formatBytes(memoryUsage.rss),
        external: formatBytes(memoryUsage.external),
      },
      cpu: {
        status: isCpuOk ? 'ok' : 'warning',
        loadAverage: {
          '1m': load1m.toFixed(2),
          '5m': load5m.toFixed(2),
          '15m': load15m.toFixed(2),
        },
        cpuCount,
        threshold: CPU_LOAD_THRESHOLD,
      },
      pool: {
        status: poolStatus,
        total: poolMetrics.totalConnections,
        idle: poolMetrics.idleConnections,
        waiting: poolMetrics.waitingClients,
        max: poolMetrics.maxConnections,
        utilization: `${poolMetrics.utilization.toFixed(1)}%`,
        threshold: `${POOL_UTILIZATION_WARN_THRESHOLD}%`,
      },
    },
  };

  return { isReady, isDatabaseReady, payload };
}

// Set the Retry-After hint for degraded responses. Pool saturation typically
// resolves in seconds (queue drains as queries complete); a DB outage
// typically takes longer — shorter hint for the recoverable case.
function setRetryAfter(res: Response, isDatabaseReady: boolean): void {
  res.setHeader('Retry-After', isDatabaseReady ? '5' : '30');
}

// Public readiness probe — lean response for orchestrators (k8s, ALB).
// Returns only `{ status, timestamp }` plus 200/503; rich pool/CPU/memory
// internals live behind /ready/detailed so unauthenticated callers cannot
// recon process-internal load for DoS targeting. See security-audit-2026-05-18.md.
router.get('/ready', healthLimiter, async (req: RequestWithLogger, res: Response) => {
  const { log } = req;
  const { isReady, isDatabaseReady, payload } = await buildReadinessPayload(log);

  if (!isReady) {
    log.warn(payload, 'Health check - readiness probe failed');
    setRetryAfter(res, isDatabaseReady);
  } else {
    log.debug(payload, 'Health check - readiness probe passed');
  }

  res.status(isReady ? 200 : 503).json({
    status: payload.status,
    timestamp: payload.timestamp,
  });
});

// Authenticated detailed readiness — same gate as /metrics (METRICS_TOKEN
// bearer). Used by operators and dashboards; not by orchestrators.
router.get(
  '/ready/detailed',
  healthLimiter,
  metricsAuthMiddleware,
  async (req: RequestWithLogger, res: Response) => {
    const { log } = req;
    const { isReady, isDatabaseReady, payload } = await buildReadinessPayload(log);

    if (!isReady) {
      setRetryAfter(res, isDatabaseReady);
    }

    res.status(isReady ? 200 : 503).json(payload);
  },
);

export default router;
