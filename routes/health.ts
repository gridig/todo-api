import express, { Response, Router } from 'express';
import os from 'os';
import { env } from '../config/env.js';
import {
  getPoolMetrics,
  POOL_UTILIZATION_WARN_THRESHOLD,
  probeDatabase,
} from '../lib/prisma.js';
import { healthLimiter } from '../middleware/rateLimiter.js';
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

// Readiness probe - is the server ready to handle requests?
router.get('/ready', healthLimiter, async (req: RequestWithLogger, res: Response) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const { log } = req;

  // Check PostgreSQL connection via the dedicated probe pool (insulated from
  // application pool exhaustion; bounded by DB_PROBE_TIMEOUT_MS so probe
  // latency stays well under k8s readiness/liveness timeoutSeconds).
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

  // Check memory usage
  const memoryUsage = process.memoryUsage();
  const heapUsedPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
  const isMemoryOk = heapUsedPercent < MEMORY_THRESHOLD_PERCENT;

  // Check CPU load (1-minute average)
  const loadAverage = os.loadavg();
  const cpuCount = os.cpus().length;
  const load1m = loadAverage[0] ?? 0;
  const load5m = loadAverage[1] ?? 0;
  const load15m = loadAverage[2] ?? 0;
  const isCpuOk = load1m < CPU_LOAD_THRESHOLD;

  // Pool state — three-valued status. Saturation IS a readiness failure:
  // "Postgres reachable" is a weaker signal than "the server can serve a
  // request right now." If every connection is busy, the pool has fully
  // grown, and clients are already queued, the next incoming request has to
  // wait — that's degraded readiness regardless of DB connectivity. Use
  // integer comparisons against canonical pg.Pool counters (no float
  // rounding); `utilization` stays the display metric.
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

  // Overall readiness only tracks binding constraints: can we reach the DB,
  // and does the pool have headroom to serve another request? Memory and CPU
  // are observational — load average lingers ~60s after a burst and would
  // otherwise spam WARN per probe; OOM is a liveness concern, not readiness.
  const isReady = isDatabaseReady && !isPoolSaturated;

  const healthStatus = {
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

  if (!isReady) {
    log.warn(healthStatus, 'Health check - readiness probe failed');
  } else {
    log.debug(healthStatus, 'Health check - readiness probe passed');
  }

  if (!isReady) {
    // Pool saturation typically resolves in seconds (queue drains as queries
    // complete); a DB outage typically takes longer. Use a shorter hint for
    // the recoverable case so clients retry sooner.
    res.setHeader('Retry-After', isDatabaseReady ? '5' : '30');
  }

  res.status(isReady ? 200 : 503).json(healthStatus);
});

export default router;
