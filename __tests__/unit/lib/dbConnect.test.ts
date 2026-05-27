import { jest } from '@jest/globals';
import { connectWithRetry, computeNextDelay } from '@/lib/dbConnect.js';
import type { Logger } from 'pino';

const makeLogger = (): Logger => {
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  };
  return log as unknown as Logger;
};

describe('connectWithRetry', () => {
  it('returns immediately on first-try success without sleeping', async () => {
    const probe = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const sleep = jest.fn<(ms: number) => Promise<void>>();
    const log = makeLogger();

    await connectWithRetry(probe, log, {
      maxRetries: 5,
      initialDelayMs: 1000,
      sleep,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('retries until success, sleeping between attempts', async () => {
    const probe = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockRejectedValueOnce(new Error('boom 3'))
      .mockResolvedValueOnce(undefined);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = makeLogger();

    await connectWithRetry(probe, log, {
      maxRetries: 5,
      initialDelayMs: 1000,
      sleep,
      random: () => 0,
    });

    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { attempts: 4 },
      expect.stringContaining('after 4 attempts'),
    );
  });

  it('throws the last error after exhausting retries', async () => {
    const finalError = new Error('final boom');
    const probe = jest.fn<() => Promise<void>>().mockRejectedValue(finalError);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = makeLogger();

    await expect(
      connectWithRetry(probe, log, {
        maxRetries: 3,
        initialDelayMs: 100,
        sleep,
      }),
    ).rejects.toBe(finalError);

    // maxRetries=3 → 1 initial + 3 retries = 4 attempts, 3 sleeps
    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('makes only one attempt when maxRetries is 0', async () => {
    const probe = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom'));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = makeLogger();

    await expect(
      connectWithRetry(probe, log, {
        maxRetries: 0,
        initialDelayMs: 1000,
        sleep,
      }),
    ).rejects.toThrow('boom');

    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries when probe fails even though caller-side $connect would succeed', async () => {
    // Regression: $connect() with the PrismaPg adapter is near-noop. The
    // retry loop must trigger on probe failure (real SELECT 1), not $connect.
    const $connect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const probeQuery = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    const combined = async () => {
      await $connect();
      await probeQuery();
    };
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = makeLogger();

    await connectWithRetry(combined, log, {
      maxRetries: 5,
      initialDelayMs: 100,
      sleep,
    });

    expect($connect).toHaveBeenCalledTimes(2);
    expect(probeQuery).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('uses decorrelated jitter starting from initialDelayMs', async () => {
    const probe = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom'));
    const sleeps: number[] = [];
    const sleep = jest.fn<(ms: number) => Promise<void>>(async (ms) => {
      sleeps.push(ms);
    });
    const log = makeLogger();

    await expect(
      connectWithRetry(probe, log, {
        maxRetries: 4,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        sleep,
        random: () => 0.5,
      }),
    ).rejects.toThrow('boom');

    // First retry uses initialDelayMs verbatim, then decorrelated jitter
    // with random=0.5: delay = base + 0.5 * (min(cap, prev*3) - base)
    //  retry 1: 1000
    //  retry 2: 1000 + 0.5 * (3000 - 1000)         = 2000
    //  retry 3: 1000 + 0.5 * (min(30000,6000)-1000) = 3500
    //  retry 4: 1000 + 0.5 * (min(30000,10500)-1000) = 5750
    expect(sleeps).toEqual([1000, 2000, 3500, 5750]);
  });

  it('flattens AggregateError messages so the WARN line is informative', async () => {
    // Node's dual-stack net.connect produces AggregateError with empty
    // .message and the real errors in .errors[]. The retry log should
    // surface those underlying messages instead of an empty string.
    const aggregate = new AggregateError(
      [
        new Error('connect ECONNREFUSED ::1:9999'),
        new Error('connect ECONNREFUSED 127.0.0.1:9999'),
      ],
      '',
    );
    const probe = jest.fn<() => Promise<void>>().mockRejectedValue(aggregate);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = makeLogger();

    await expect(
      connectWithRetry(probe, log, {
        maxRetries: 0,
        initialDelayMs: 100,
        sleep,
      }),
    ).rejects.toBe(aggregate);

    // maxRetries=0 → no WARN emitted (no retry will happen). Bump to 1 retry
    // to actually exercise the log path.
    log.warn = jest.fn();
    const probe2 = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(aggregate)
      .mockResolvedValueOnce(undefined);
    await connectWithRetry(probe2, log, {
      maxRetries: 1,
      initialDelayMs: 100,
      sleep,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errName: 'AggregateError',
        errMessage: 'connect ECONNREFUSED ::1:9999; connect ECONNREFUSED 127.0.0.1:9999',
      }),
      expect.any(String),
    );
  });

  it('caps decorrelated jitter at maxDelayMs', () => {
    // prev * 3 = 60000, exceeds cap of 30000 → upper clamped to 30000.
    // delay = 1000 + 0.5 * (30000 - 1000) = 15500
    const delay = computeNextDelay(20000, 1000, 30000, () => 0.5);
    expect(delay).toBe(15500);
  });

  it('falls back to baseDelay when prev*3 <= base (degenerate)', () => {
    // prev*3 = 300, base = 1000 → upper = 300, upper <= base → returns base.
    const delay = computeNextDelay(100, 1000, 30000, () => 0.5);
    expect(delay).toBe(1000);
  });
});
