import type { Options, Store, IncrementResponse, ClientRateLimitInfo } from 'express-rate-limit';

// Degrade-to-memory wrapper around the Redis-backed store. While the Redis
// client is ready, counters are shared across instances; when it is not
// (connect failure, mid-flight command error, reconnect window), requests are
// served by a per-instance MemoryStore instead. Availability wins over
// cross-instance accuracy during an outage: caps degrade from global to
// per-instance (bounded at N× for N instances) rather than failing closed
// (500 on every limited request) or open (no limits at all). Counters do not
// carry over between stores on a flip — outage windows are short and the
// bounded caps still hold.
export interface FallbackStoreOptions {
  isPrimaryReady: () => boolean;
  onFallback: () => void;
}

export class FallbackStore implements Store {
  // Redis-backed keys are shared across instances; advertise the primary's
  // semantics for express-rate-limit's double-count detection.
  localKeys = false;

  constructor(
    private readonly primary: Store,
    private readonly fallback: Store,
    private readonly options: FallbackStoreOptions,
  ) {}

  init(options: Options): void {
    this.primary.init?.(options);
    this.fallback.init?.(options);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    if (this.options.isPrimaryReady()) {
      try {
        return await this.primary.get?.(key);
      } catch {
        return this.fallback.get?.(key);
      }
    }
    return this.fallback.get?.(key);
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (this.options.isPrimaryReady()) {
      try {
        return await this.primary.increment(key);
      } catch {
        this.options.onFallback();
        return this.fallback.increment(key);
      }
    }
    this.options.onFallback();
    return this.fallback.increment(key);
  }

  async decrement(key: string): Promise<void> {
    if (this.options.isPrimaryReady()) {
      try {
        await this.primary.decrement(key);
        return;
      } catch {
        await this.fallback.decrement(key);
        return;
      }
    }
    await this.fallback.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    if (this.options.isPrimaryReady()) {
      try {
        await this.primary.resetKey(key);
        return;
      } catch {
        await this.fallback.resetKey(key);
        return;
      }
    }
    await this.fallback.resetKey(key);
  }
}
