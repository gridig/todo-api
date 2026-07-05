// Dependency-free retry with decorrelated jitter. Shared by the app's startup
// connect (src/lib/dbConnect.ts, which layers pino logging on top) and the
// deploy preflight (scripts/preflight-roles.ts), which must not import envalid
// or pino — keep this module free of project imports.

const DECORRELATED_JITTER_MULTIPLIER = 3;

export const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RetryFailedAttempt {
  error: unknown;
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  nextDelayMs: number;
  maxRetries: number;
}

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Fired only when a retry WILL follow — never for the final failure. */
  onFailedAttempt?: (info: RetryFailedAttempt) => void;
  /** Fired only when success took more than one attempt. */
  onRecovered?: (info: { attempts: number }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Node's dual-stack `net.connect` surfaces ECONNREFUSED as an AggregateError
// whose own `.message` is empty — the real messages live in `.errors[]`. Flatten
// so the per-retry log line actually says what failed.
export const flattenErrorMessage = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  const agg = (err as { errors?: unknown[] }).errors;
  if (Array.isArray(agg) && agg.length > 0) {
    return agg.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
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

// Retry `fn` with decorrelated jitter: first retry waits initialDelayMs
// verbatim, later ones use computeNextDelay. Rethrows the original error
// object after maxRetries + 1 total attempts.
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxRetries, initialDelayMs } = options;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  let prevDelay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        options.onRecovered?.({ attempts: attempt + 1 });
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;

      const delay =
        attempt === 0
          ? initialDelayMs
          : computeNextDelay(prevDelay, initialDelayMs, maxDelayMs, random);
      prevDelay = delay;

      options.onFailedAttempt?.({
        error: err,
        attempt: attempt + 1,
        nextDelayMs: delay,
        maxRetries,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
