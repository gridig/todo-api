import express, { Response, Router } from 'express';
import os from 'os';
import { env } from '../config/env.js';
import prisma from '../lib/prisma.js';
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

  // Check PostgreSQL connection
  let isDatabaseReady = false;
  let databaseState: string;

  try {
    await prisma.$executeRaw`SELECT 1`;
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

  // Overall readiness
  const isReady = isDatabaseReady && isMemoryOk && isCpuOk;

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
    },
  };

  if (!isReady) {
    log.warn(healthStatus, 'Health check - readiness probe failed');
  } else {
    log.debug(healthStatus, 'Health check - readiness probe passed');
  }

  if (!isDatabaseReady) {
    res.setHeader('Retry-After', '30');
  }

  res.status(isDatabaseReady ? 200 : 503).json(healthStatus);
});

export default router;
