import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrRelease, DisposeStack, releaseAll, settlesWithin } from './lifecycle';

describe('releaseAll', () => {
  it('runs the steps last first', () => {
    const order: string[] = [];
    releaseAll([() => void order.push('a'), () => void order.push('b')], 'Owner');
    expect(order).toEqual(['b', 'a']);
  });

  it('runs every step past a failing one and throws the failures together', () => {
    const order: string[] = [];
    const late = new Error('late');
    const early = new Error('early');
    let thrown: unknown;
    try {
      releaseAll(
        [
          () => void order.push('a'),
          () => {
            throw early;
          },
          () => {
            throw late;
          },
          () => void order.push('d'),
        ],
        'Owner',
      );
    } catch (error) {
      thrown = error;
    }
    expect(order).toEqual(['d', 'a']);
    if (!(thrown instanceof AggregateError))
      throw new Error('releaseAll must throw AggregateError');
    expect(thrown.errors).toEqual([late, early]);
    expect(thrown.message).toBe('Owner: 2 cleanup step(s) failed');
  });

  it('does nothing with no steps', () => {
    expect(() => releaseAll([], 'Owner')).not.toThrow();
  });
});

describe('DisposeStack', () => {
  it('runs cleanup steps in reverse order of acquisition', async () => {
    const order: string[] = [];
    const stack = new DisposeStack();
    stack.add(() => void order.push('device'));
    stack.add(async () => {
      await Promise.resolve();
      order.push('canvas');
    });
    stack.add(() => void order.push('observer'));
    await stack.dispose();
    expect(order).toEqual(['observer', 'canvas', 'device']);
    expect(stack.size).toBe(0);
  });

  it('keeps going past a failing step and reports every failure', async () => {
    const first = new Error('first');
    const second = new Error('second');
    const last = vi.fn();
    const stack = new DisposeStack();
    stack.add(last);
    stack.add(() => {
      throw first;
    });
    stack.add(() => Promise.reject(second));
    const result: unknown = await stack.dispose().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([second, first]);
    expect(last).toHaveBeenCalledOnce();
  });

  it('is idempotent and refuses new steps once disposed', async () => {
    const step = vi.fn();
    const stack = new DisposeStack();
    stack.add(step);
    await stack.dispose();
    await stack.dispose();
    expect(step).toHaveBeenCalledOnce();
    expect(stack.isDisposed).toBe(true);
    expect(() => stack.add(() => undefined)).toThrow(/after dispose/);
  });

  it('disposes an empty stack without error', async () => {
    await expect(new DisposeStack().dispose()).resolves.toBeUndefined();
  });
});

describe('buildOrRelease', () => {
  it('leaves acquired resources alone when the build succeeds', async () => {
    const release = vi.fn();
    const onCleanupError = vi.fn();
    const value = await buildOrRelease((cleanup) => {
      cleanup.add(release);
      return Promise.resolve(42);
    }, onCleanupError);
    expect(value).toBe(42);
    expect(release).not.toHaveBeenCalled();
    expect(onCleanupError).not.toHaveBeenCalled();
  });

  it('releases everything acquired before the failing step and rethrows the original error', async () => {
    const released: string[] = [];
    const failure = new Error('compile failed');
    const acquireAfter = vi.fn();
    const build = buildOrRelease(async (cleanup) => {
      cleanup.add(() => void released.push('renderer'));
      cleanup.add(() => void released.push('canvas'));
      await Promise.reject(failure);
      acquireAfter();
      return 'unreachable';
    }, vi.fn());
    await expect(build).rejects.toBe(failure);
    expect(released).toEqual(['canvas', 'renderer']);
    expect(acquireAfter).not.toHaveBeenCalled();
  });

  it('rethrows the original error even when cleanup also fails', async () => {
    const failure = new Error('init failed');
    const cleanupFailure = new Error('dispose failed');
    const onCleanupError = vi.fn();
    const build = buildOrRelease((cleanup) => {
      cleanup.add(() => {
        throw cleanupFailure;
      });
      return Promise.reject(failure);
    }, onCleanupError);
    await expect(build).rejects.toBe(failure);
    expect(onCleanupError).toHaveBeenCalledOnce();
    const reported: unknown = onCleanupError.mock.calls[0]?.[0];
    expect((reported as AggregateError).errors).toEqual([cleanupFailure]);
  });
});

describe('settlesWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is true for work that resolves before the deadline, and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(settlesWithin(Promise.resolve('done'), 5000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is false for work that never settles, and only once the deadline passes', async () => {
    vi.useFakeTimers();
    let outcome: boolean | null = null;
    void settlesWithin(new Promise(() => undefined), 5000).then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(4999);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe(false);
  });

  it('leaves late work running to finish on its own', async () => {
    vi.useFakeTimers();
    let finish = (): void => undefined;
    const work = new Promise<void>((resolve) => (finish = resolve));
    const late = vi.fn();
    void work.then(late);
    const outcome = settlesWithin(work, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toBe(false);
    finish();
    await work;
    expect(late).toHaveBeenCalledOnce();
  });

  it('rethrows a rejection that lands in time', async () => {
    const failure = new Error('chunk failed');
    await expect(settlesWithin(Promise.reject(failure), 5000)).rejects.toBe(failure);
  });
});
