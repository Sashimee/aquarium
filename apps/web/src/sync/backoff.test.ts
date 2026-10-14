import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, isTransient, retryDelayMs, withRetry } from './backoff';
import { ApiTimeoutError } from '../ui/api';
import { apiError } from './fixtures';

describe('backoffDelay', () => {
  it('doubles from the base without jitter', () => {
    const opts = { baseMs: 1000, maxMs: 60_000, jitter: 0 };
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, opts))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('never exceeds the cap, jitter included', () => {
    const opts = { baseMs: 1000, maxMs: 5000, jitter: 0.5, random: () => 1 };
    expect(backoffDelay(10, opts)).toBe(5000);
  });

  it('spreads symmetrically around the raw delay', () => {
    const base = { baseMs: 1000, jitter: 0.25 };
    expect(backoffDelay(0, { ...base, random: () => 0 })).toBe(750);
    expect(backoffDelay(0, { ...base, random: () => 0.5 })).toBe(1000);
    expect(backoffDelay(0, { ...base, random: () => 1 })).toBe(1250);
  });
});

describe('retry policy', () => {
  it('retries network failures, rate limits and server errors only', () => {
    expect(isTransient(apiError(0, 'network'))).toBe(true);
    expect(isTransient(apiError(429, 'rate_limited'))).toBe(true);
    expect(isTransient(apiError(503, 'internal'))).toBe(true);
    expect(isTransient(apiError(422, 'feeding_rejected'))).toBe(false);
    expect(isTransient(apiError(409, 'conflict'))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });

  it('waits at least as long as Retry-After', () => {
    const opts = { baseMs: 1000, jitter: 0 };
    expect(retryDelayMs(apiError(429, 'rate_limited', 30), 0, opts)).toBe(30_000);
    expect(retryDelayMs(apiError(429, 'rate_limited', 1), 3, opts)).toBe(8000);
    expect(retryDelayMs(apiError(422, 'feeding_rejected'), 0, opts)).toBeNull();
  });
});

describe('withRetry', () => {
  const quick = { jitter: 0, baseMs: 100 };

  it('sleeps with growing delays between attempts, then succeeds', async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockRejectedValueOnce(apiError(500, 'internal'))
      .mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(task, { ...quick, sleep })).resolves.toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('does not retry a rejection', async () => {
    const task = vi.fn().mockRejectedValue(apiError(422, 'feeding_rejected'));
    const sleep = vi.fn();
    await expect(withRetry(task, { ...quick, sleep })).rejects.toMatchObject({ status: 422 });
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const task = vi.fn().mockRejectedValue(apiError(0, 'network'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(task, { ...quick, sleep, maxAttempts: 3 })).rejects.toMatchObject({
      code: 'network',
    });
    expect(task).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when aborted', async () => {
    const controller = new AbortController();
    const task = vi.fn().mockRejectedValue(apiError(0, 'network'));
    const promise = withRetry(task, { ...quick, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe('timeouts', () => {
  it('are transient and retried only after a capped delay', () => {
    const timeout = new ApiTimeoutError(15_000);
    expect(isTransient(timeout)).toBe(true);
    const delay = retryDelayMs(timeout, 20, { baseMs: 1000, maxMs: 60_000, jitter: 0 });
    expect(delay).toBe(60_000);
  });
});
