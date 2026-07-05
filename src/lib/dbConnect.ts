import type { Logger } from 'pino';
import defaultLogger from '../middleware/logger.js';
import { env } from '../config/env.js';
import { DEFAULT_MAX_DELAY_MS, flattenErrorMessage, retryWithBackoff } from './retry.js';

export { computeNextDelay } from './retry.js';

export interface ConnectWithRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Retry `probe` with decorrelated jitter (see src/lib/retry.ts). Caller defines
// what "reachable" means — typically `prisma.$connect()` (which is near-free
// with the PrismaPg adapter, just initialises internal state) followed by a
// real `SELECT 1` (which is what actually surfaces a TCP / auth / DB-down
// failure).
export async function connectWithRetry(
  probe: () => Promise<void>,
  log: Logger = defaultLogger,
  options: ConnectWithRetryOptions = {},
): Promise<void> {
  const maxRetries = options.maxRetries ?? env.DB_CONNECT_MAX_RETRIES;
  const initialDelayMs = options.initialDelayMs ?? env.DB_CONNECT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  await retryWithBackoff(probe, {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    ...(options.sleep && { sleep: options.sleep }),
    ...(options.random && { random: options.random }),
    onFailedAttempt: ({ error, attempt, nextDelayMs }) => {
      const errInfo =
        error instanceof Error
          ? { errName: error.name, errMessage: flattenErrorMessage(error) }
          : { err: error };
      log.warn(
        {
          ...errInfo,
          attempt,
          nextDelayMs,
          maxRetries,
        },
        `Database connection failed; retrying in ${nextDelayMs}ms`,
      );
    },
    onRecovered: ({ attempts }) => {
      log.info({ attempts }, `PostgreSQL connected after ${attempts} attempts`);
    },
  });
}
