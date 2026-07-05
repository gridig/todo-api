import { jest } from '@jest/globals';
import { retryWithBackoff, type RetryFailedAttempt } from '@/lib/retry.js';

describe('retryWithBackoff', () => {
  it('propagates the return value on first-try success without callbacks', async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('roles');
    const sleep = jest.fn<(ms: number) => Promise<void>>();
    const onFailedAttempt = jest.fn();
    const onRecovered = jest.fn();

    const result = await retryWithBackoff(fn, {
      maxRetries: 5,
      initialDelayMs: 1000,
      sleep,
      onFailedAttempt,
      onRecovered,
    });

    expect(result).toBe('roles');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onFailedAttempt).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('fires onFailedAttempt per retried failure but not for the final one, and rethrows the original error', async () => {
    const finalError = new Error('final boom');
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(finalError);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const attempts: RetryFailedAttempt[] = [];

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelayMs: 100,
        sleep,
        random: () => 0,
        onFailedAttempt: (info) => attempts.push(info),
      }),
    ).rejects.toBe(finalError);

    // maxRetries=2 → 3 attempts, but only the 2 retried failures are reported.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([
      { error: finalError, attempt: 1, nextDelayMs: 100, maxRetries: 2 },
      { error: finalError, attempt: 2, nextDelayMs: 100, maxRetries: 2 },
    ]);
  });

  it('fires onRecovered only when success took more than one attempt', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const onRecovered = jest.fn();

    const result = await retryWithBackoff(fn, {
      maxRetries: 5,
      initialDelayMs: 100,
      sleep,
      onRecovered,
    });

    expect(result).toBe('ok');
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledWith({ attempts: 2 });
  });

  it('works without any callbacks supplied', async () => {
    const fn = jest
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(42);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(retryWithBackoff(fn, { maxRetries: 1, initialDelayMs: 50, sleep })).resolves.toBe(
      42,
    );
    expect(sleep).toHaveBeenCalledWith(50);
  });
});
