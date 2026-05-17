import { Pool } from 'pg';
import { Gauge } from 'prom-client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../prisma/generated/prisma/client.js';
import { dbQueryDuration, register } from '../middleware/metrics.js';
import logger from '../middleware/logger.js';
import { env } from '../config/env.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  min: env.DB_POOL_MIN,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  query_timeout: env.DB_QUERY_TIMEOUT_MS,
});

// Pool events — frequencies vary wildly, so log levels do too.
//   acquire/release: one per query → debug (silent in prod by default)
//   connect:         pool warmup / replacement → debug
//   remove:          connection evicted/closed → warn (rare; worth seeing)
//   error:           idle-client error → error
pool.on('connect', () => logger.debug('pg pool: connect'));
pool.on('acquire', () => logger.debug('pg pool: acquire'));
pool.on('release', () => logger.debug('pg pool: release'));
pool.on('remove', () => logger.warn('pg pool: remove'));
pool.on('error', (err) => logger.error({ err }, 'pg pool: idle client error'));

// Dedicated probe pool — single warm connection reserved for /health/ready.
// Lives outside the application pool so probe latency is independent of app
// traffic: an exhausted application pool still gets an instant DB reachability
// check via this pool, and the probe never consumes a slot real requests are
// queueing for. `query_timeout` is tighter than DB_QUERY_TIMEOUT_MS so that
// successive slow probes can't accumulate latency past k8s
// `failureThreshold * timeoutSeconds` under sustained saturation + jitter + GC.
const probePool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 1,
  min: 1,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  query_timeout: env.DB_PROBE_TIMEOUT_MS,
});

probePool.on('error', (err) =>
  logger.error({ err }, 'pg probe pool: idle client error'),
);

export async function probeDatabase(): Promise<void> {
  await probePool.query('SELECT 1');
}

// Prometheus gauges read live pool state at scrape time — single source of
// truth (the pool itself), no drift risk from missed events.
export const dbPoolTotalConnections = new Gauge({
  name: 'db_pool_total_connections',
  help: 'Total connections currently held by the pool (idle + checked out)',
  registers: [register],
  collect() {
    this.set(pool.totalCount);
  },
});

export const dbPoolIdleConnections = new Gauge({
  name: 'db_pool_idle_connections',
  help: 'Connections sitting idle in the pool',
  registers: [register],
  collect() {
    this.set(pool.idleCount);
  },
});

export const dbPoolWaitingClients = new Gauge({
  name: 'db_pool_waiting_clients',
  help: 'Clients waiting for a connection because the pool is saturated',
  registers: [register],
  collect() {
    this.set(pool.waitingCount);
  },
});

export const dbPoolMaxConnections = new Gauge({
  name: 'db_pool_max_connections',
  help: 'Configured pool maximum (DB_POOL_MAX)',
  registers: [register],
  collect() {
    this.set(env.DB_POOL_MAX);
  },
});

export interface PoolMetrics {
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
  maxConnections: number;
  utilization: number;
}

export function getPoolMetrics(): PoolMetrics {
  const totalConnections = pool.totalCount;
  const idleConnections = pool.idleCount;
  const waitingClients = pool.waitingCount;
  const maxConnections = env.DB_POOL_MAX;
  const active = totalConnections - idleConnections;
  const utilization =
    maxConnections > 0 ? (active / maxConnections) * 100 : 0;
  return {
    totalConnections,
    idleConnections,
    waitingClients,
    maxConnections,
    utilization,
  };
}

export const POOL_UTILIZATION_WARN_THRESHOLD = 80;

export function logPoolHealth(): void {
  const metrics = getPoolMetrics();
  const payload = {
    ...metrics,
    utilization: `${metrics.utilization.toFixed(1)}%`,
  };
  if (metrics.utilization > POOL_UTILIZATION_WARN_THRESHOLD) {
    logger.warn(payload, 'pg pool: utilization above threshold');
  } else {
    logger.info(payload, 'pg pool: health check');
  }
}

const adapter = new PrismaPg(pool);

const basePrisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

const prisma = env.DISABLE_DB_METRICS
  ? basePrisma
  : basePrisma.$extends({
      query: {
        $allOperations({ operation, model, args, query }) {
          const end = dbQueryDuration.startTimer({
            operation,
            model: model ?? 'unknown',
          });
          return query(args).finally(() => end());
        },
      },
    });

export { pool, probePool };
export default prisma;
