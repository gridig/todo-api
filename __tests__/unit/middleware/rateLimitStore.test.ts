import { jest } from '@jest/globals';
import { FallbackStore } from '@/middleware/rateLimitStore.js';
import type { Options, Store, IncrementResponse } from 'express-rate-limit';

const incrementResponse: IncrementResponse = { totalHits: 1, resetTime: new Date() };

interface FakeStore extends Store {
  init: jest.Mock<(options: Options) => void>;
  increment: jest.Mock<(key: string) => Promise<IncrementResponse>>;
  decrement: jest.Mock<(key: string) => Promise<void>>;
  resetKey: jest.Mock<(key: string) => Promise<void>>;
}

const makeFakeStore = (): FakeStore => ({
  init: jest.fn<(options: Options) => void>(),
  increment: jest.fn<(key: string) => Promise<IncrementResponse>>().mockResolvedValue({
    ...incrementResponse,
  }),
  decrement: jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
  resetKey: jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
});

describe('FallbackStore', () => {
  let primary: FakeStore;
  let fallback: FakeStore;
  let ready: boolean;
  let onFallback: jest.Mock;

  const build = (): FallbackStore =>
    new FallbackStore(primary, fallback, {
      isPrimaryReady: () => ready,
      onFallback,
    });

  beforeEach(() => {
    primary = makeFakeStore();
    fallback = makeFakeStore();
    ready = true;
    onFallback = jest.fn();
  });

  it('init initializes both stores', () => {
    build().init({} as Options);
    expect(primary.init).toHaveBeenCalledTimes(1);
    expect(fallback.init).toHaveBeenCalledTimes(1);
  });

  it('delegates increment to the primary while ready', async () => {
    await build().increment('k');
    expect(primary.increment).toHaveBeenCalledWith('k');
    expect(fallback.increment).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('serves increment from the fallback when the primary is not ready', async () => {
    ready = false;
    await build().increment('k');
    expect(primary.increment).not.toHaveBeenCalled();
    expect(fallback.increment).toHaveBeenCalledWith('k');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when a ready primary rejects mid-flight', async () => {
    primary.increment.mockRejectedValueOnce(new Error('redis gone'));
    const result = await build().increment('k');
    expect(fallback.increment).toHaveBeenCalledWith('k');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(result.totalHits).toBe(1);
  });

  it('recovers to the primary once ready again', async () => {
    const store = build();
    ready = false;
    await store.increment('k');
    ready = true;
    await store.increment('k');
    expect(primary.increment).toHaveBeenCalledTimes(1);
    expect(fallback.increment).toHaveBeenCalledTimes(1);
  });

  it('routes decrement and resetKey the same way', async () => {
    const store = build();
    await store.decrement('k');
    await store.resetKey('k');
    expect(primary.decrement).toHaveBeenCalledWith('k');
    expect(primary.resetKey).toHaveBeenCalledWith('k');

    ready = false;
    await store.decrement('k');
    await store.resetKey('k');
    expect(fallback.decrement).toHaveBeenCalledWith('k');
    expect(fallback.resetKey).toHaveBeenCalledWith('k');
  });

  it('decrement falls back when the primary rejects', async () => {
    primary.decrement.mockRejectedValueOnce(new Error('redis gone'));
    await build().decrement('k');
    expect(fallback.decrement).toHaveBeenCalledWith('k');
  });
});
