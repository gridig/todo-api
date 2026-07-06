import { env } from './config/env.js';
import { Server } from 'http';
import cluster from 'cluster';
import os from 'os';
import prisma, { pool, probePool, probeDatabase, logPoolHealth } from './lib/prisma.js';
import { createApp } from './app.js';
import logger from './middleware/logger.js';
import { connectWithRetry } from './lib/dbConnect.js';
import { redisClient } from './middleware/rateLimiter.js';

const POOL_HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;
let poolHealthInterval: ReturnType<typeof setInterval> | undefined;

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

export async function startServer() {
  try {
    // Connect to PostgreSQL with retry/backoff so a transient startup blip
    // (network jitter, container race, brief DB maintenance) doesn't crash
    // the process into a CrashLoopBackOff against the same root cause.
    // $connect() with the PrismaPg adapter is a near-noop (lazy on first
    // query), so we follow it with probeDatabase() — a real SELECT 1 on the
    // probe pool — to actually surface a TCP / auth / DB-down failure and
    // trigger the retry loop.
    logger.info('Connecting to PostgreSQL...');
    await connectWithRetry(async () => {
      await prisma.$connect();
      await probeDatabase();
    }, logger);
    logger.info('PostgreSQL connected successfully');

    // Refuse to boot against a non-TimescaleDB Postgres. The audit_entries
    // hypertable and retention policy are no-ops without the extension —
    // we'd silently lose the SOC 2 retention guarantee and learn about it
    // a year later when chunks fail to drop. Cheap to check, hard to miss.
    const ext = await prisma.$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'
    `;
    if (ext.length === 0) {
      throw new Error(
        'TimescaleDB extension is missing — audit_entries requires it. ' +
          'Verify the Postgres image (expected: timescale/timescaledb:latest-pg16) ' +
          'and that `prisma migrate deploy` has applied 20260526000001_add_audit_entries.',
      );
    }
    logger.info({ timescaledbVersion: ext[0]?.extversion }, 'TimescaleDB extension verified');

    // Tamper-evidence smoke probe: a successful UPDATE on audit_entries from
    // the runtime role means the REVOKE was lost (bad migration, accidental
    // GRANT, wrong DSN). DB_PLAN §8 originally placed this in deploy.yml; doing
    // it at boot covers every environment (dev/CI/staging/prod), avoids
    // duplicating the db_app DSN into a GitHub Actions secret, and turns a
    // failing probe into a refused-to-boot signal the orchestrator already
    // knows how to handle. WHERE FALSE keeps it free of side effects even
    // if the REVOKE is mistakenly absent.
    try {
      await prisma.$executeRaw`UPDATE audit_entries SET action = 'probe' WHERE FALSE`;
      throw new Error(
        'AUDIT_TAMPER_PROBE_FAILED: UPDATE on audit_entries succeeded as the runtime role. ' +
          'The audit-log REVOKE is not in force — refusing to boot. ' +
          'Check that DATABASE_URL points to db_app (not the superuser) and that the ' +
          '20260526000001_add_audit_entries migration has applied.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('AUDIT_TAMPER_PROBE_FAILED')) throw err;
      if (!/permission denied/i.test(message)) {
        throw new Error(
          `AUDIT_TAMPER_PROBE_INCONCLUSIVE: probe returned an unexpected error: ${message}`,
          { cause: err },
        );
      }
      logger.info('Audit-log tamper-evidence probe passed (UPDATE denied as expected)');
    }

    // Periodic pool snapshot for log-aggregator alerting. Dev gets the same
    // data on demand via /health/ready, so the interval is prod-only.
    if (env.NODE_ENV === 'production') {
      poolHealthInterval = setInterval(logPoolHealth, POOL_HEALTH_LOG_INTERVAL_MS);
      poolHealthInterval.unref();
    }

    const app = createApp();
    const PORT = env.PORT || 3001;

    // Log application startup configuration
    logger.info(
      {
        nodeVersion: process.version,
        environment: process.env.NODE_ENV,
        port: PORT,
        logLevel: logger.level,
        pid: process.pid,
        workerId: cluster.isWorker ? cluster.worker?.id : undefined,
      },
      'Application configuration',
    );

    const server = app.listen(PORT, () => {
      logger.info({ port: PORT, pid: process.pid }, 'Server started successfully');
    });

    // Set explicit timeouts — Node defaults are either infinite or too long for production.
    // keepAliveTimeout must exceed the load balancer idle timeout (typically 60s) to prevent
    // the LB sending a request on a connection the server has already decided to close (502).
    server.headersTimeout = env.SERVER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = env.SERVER_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = env.SERVER_KEEP_ALIVE_TIMEOUT_MS;

    setupGracefulShutdown(server);
    return { server, app };
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    throw err;
  }
}

export function setupGracefulShutdown(server: Server): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received, closing gracefully');

    // Force-exit safety net — unref'd so it doesn't block a clean exit
    const forceExit = setTimeout(() => {
      logger.error('Forced exit after timeout');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // 1. K8s drain window: keep accepting requests while routing tables propagate
    await new Promise((resolve) => setTimeout(resolve, env.SHUTDOWN_DELAY_MS));

    // 2. Drop idle keep-alive connections so server.close() can actually finish.
    // Idle-only on purpose: closeAllConnections() would also destroy sockets
    // with in-flight requests, defeating the drain in step 3.
    server.closeIdleConnections();

    // 3. Stop accepting new connections and wait for in-flight requests to complete
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    logger.info('HTTP server closed');

    // 4. Only disconnect DB after HTTP is fully drained
    if (redisClient) {
      // A client stuck mid-connect (or already errored) can reject quit();
      // that must not abort the drain via the unhandledRejection exit(1).
      try {
        await redisClient.quit();
        logger.info('Redis connection closed');
      } catch (err) {
        logger.warn({ err }, 'Redis quit failed during shutdown');
      }
    }

    if (poolHealthInterval) {
      clearInterval(poolHealthInterval);
      poolHealthInterval = undefined;
    }
    logPoolHealth();

    await prisma.$disconnect();
    await Promise.all([pool.end(), probePool.end()]);
    logger.info('PostgreSQL connection closed');

    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only start server when run directly (not when imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const requestedWorkers = env.CLUSTER_WORKERS;
  const numWorkers = requestedWorkers === 0 ? os.cpus().length : requestedWorkers;

  if (numWorkers > 1 && cluster.isPrimary) {
    logger.info({ workers: numWorkers, pid: process.pid }, 'Primary process starting cluster');

    for (let i = 0; i < numWorkers; i++) {
      cluster.fork();
    }

    let isShuttingDown = false;

    // Crash-loop budget: a worker that crashes on startup (DB unreachable past
    // retry budget, bad env, module-load bug) will spawn-and-crash in a tight
    // loop without this. Let the platform's restart policy take over with a
    // fresh container instead — surfaces the failure to the orchestrator
    // rather than masking it under a high-frequency `warn` log line.
    const MAX_RESTARTS_IN_WINDOW = 5;
    const RESTART_WINDOW_MS = 60_000;
    let recentRestarts: number[] = [];

    cluster.on('exit', (worker, code, signal) => {
      if (!isShuttingDown) {
        const now = Date.now();
        recentRestarts = recentRestarts.filter((t) => now - t < RESTART_WINDOW_MS);
        recentRestarts.push(now);

        if (recentRestarts.length > MAX_RESTARTS_IN_WINDOW) {
          logger.fatal(
            {
              restarts: recentRestarts.length,
              windowMs: RESTART_WINDOW_MS,
              workerId: worker.id,
              code,
              signal,
            },
            'Worker crash-loop detected, primary exiting to let platform restart',
          );
          process.exit(1);
        }

        logger.warn(
          { pid: worker.process.pid, workerId: worker.id, code, signal },
          'Worker exited unexpectedly, spawning replacement',
        );
        cluster.fork();
        return;
      }

      const remaining = Object.keys(cluster.workers ?? {}).length;
      logger.info({ remaining, workerId: worker.id }, 'Worker exited during shutdown');
      if (remaining === 0) {
        logger.info('All workers exited, primary process shutting down');
        process.exit(0);
      }
    });

    const shutdownWorkers = (signal: 'SIGTERM' | 'SIGINT'): void => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      const workerCount = Object.keys(cluster.workers ?? {}).length;
      logger.info({ signal, workerCount }, 'Primary forwarding shutdown signal to workers');
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.process.kill(signal);
      }
    };

    process.on('SIGTERM', () => shutdownWorkers('SIGTERM'));
    process.on('SIGINT', () => shutdownWorkers('SIGINT'));
  } else {
    startServer();
  }
}
