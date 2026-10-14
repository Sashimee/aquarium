import { ApiRequestError } from '../ui/api';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the delay that is randomised, 0..1. */
  jitter?: number;
  random?: () => number;
}

/** Exponential delay for the zero-based `attempt`, with symmetric jitter, never above `maxMs`. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 60_000;
  const jitter = options.jitter ?? 0.25;
  const random = options.random ?? Math.random;
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt));
  const spread = raw * jitter * (random() * 2 - 1);
  return Math.min(max, Math.max(0, Math.round(raw + spread)));
}

/** Network failures, timeouts, server errors and rate limits can succeed later; rejections cannot. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return (
    error.code === 'network' ||
    error.code === 'timeout' ||
    error.status === 429 ||
    error.status >= 500
  );
}

/** Milliseconds to wait before retrying `error`, or null when retrying is pointless. */
export function retryDelayMs(
  error: unknown,
  attempt: number,
  options: BackoffOptions = {},
): number | null {
  if (!isTransient(error)) return null;
  const computed = backoffDelay(attempt, options);
  if (error instanceof ApiRequestError && error.retryAfterSeconds !== null) {
    return Math.max(computed, error.retryAfterSeconds * 1_000);
  }
  return computed;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export interface RetryOptions extends BackoffOptions {
  maxAttempts?: number;
  sleep?: Sleep;
  signal?: AbortSignal;
  onRetry?(error: unknown, attempt: number, delayMs: number): void;
}

/** Runs `task`, retrying transient failures with backoff; rethrows the last error when out of attempts. */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const sleep = options.sleep ?? realSleep;
  const signal = options.signal ?? new AbortController().signal;
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const delay = attempt + 1 >= maxAttempts ? null : retryDelayMs(error, attempt, options);
      if (delay === null) throw error;
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }
}
