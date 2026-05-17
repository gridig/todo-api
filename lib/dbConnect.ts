import type { Logger } from 'pino';
import defaultLogger from '../middleware/logger.js';
import { env } from '../config/env.js';

const DECORRELATED_JITTER_MULTIPLIER = 3;
const MAX_DELAY_MS = 30_000;

export interface ConnectWithRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Node's dual-stack `net.connect` surfaces ECONNREFUSED as an AggregateError
// whose own `.message` is empty — the real messages live in `.errors[]`. Flatten
// so the per-retry WARN line actually says what failed.
const flattenErrorMessage = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  const agg = (err as { errors?: unknown[] }).errors;
  if (Array.isArray(agg) && agg.length > 0) {
    return agg
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join('; ');
  }
  return err.name;
};

// Decorrelated jitter (AWS SDK style): delay grows by random(base, prev * 3),
// capped at maxDelay. Avoids the unbounded tail of full jitter while still
// desynchronizing concurrent restarts.
export function computeNextDelay(
  prevDelay: number,
  baseDelay: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const upper = Math.min(maxDelayMs, prevDelay * DECORRELATED_JITTER_MULTIPLIER);
  if (upper <= baseDelay) return baseDelay;
  return Math.floor(baseDelay + random() * (upper - baseDelay));
}

// Retry `probe` with decorrelated jitter. Caller defines what "reachable"
// means — typically `prisma.$connect()` (which is near-free with the
// PrismaPg adapter, just initialises internal state) followed by a real
// `SELECT 1` (which is what actually surfaces a TCP / auth / DB-down failure).
export async function connectWithRetry(
  probe: () => Promise<void>,
  log: Logger = defaultLogger,
  options: ConnectWithRetryOptions = {},
): Promise<void> {
  const maxRetries = options.maxRetries ?? env.DB_CONNECT_MAX_RETRIES;
  const initialDelayMs =
    options.initialDelayMs ?? env.DB_CONNECT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  let prevDelay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await probe();
      if (attempt > 0) {
        log.info(
          { attempts: attempt + 1 },
          `PostgreSQL connected after ${attempt + 1} attempts`,
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;

      const delay =
        attempt === 0
          ? initialDelayMs
          : computeNextDelay(prevDelay, initialDelayMs, maxDelayMs, random);
      prevDelay = delay;

      const errInfo =
        err instanceof Error
          ? { errName: err.name, errMessage: flattenErrorMessage(err) }
          : { err };
      log.warn(
        {
          ...errInfo,
          attempt: attempt + 1,
          nextDelayMs: delay,
          maxRetries,
        },
        `Database connection failed; retrying in ${delay}ms`,
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
