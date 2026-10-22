import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trailingCall } from './trailingCall';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('trailingCall', () => {
  it('runs once after a burst of schedules', () => {
    const run = vi.fn();
    const call = trailingCall(run, 100);
    for (let i = 0; i < 10; i++) {
      call.schedule();
      vi.advanceTimersByTime(30);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush runs a pending call immediately and only once', () => {
    const run = vi.fn();
    const call = trailingCall(run, 100);
    call.schedule();
    call.flush();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush does nothing when nothing is pending', () => {
    const run = vi.fn();
    trailingCall(run, 100).flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancel drops a pending call', () => {
    const run = vi.fn();
    const call = trailingCall(run, 100);
    call.schedule();
    call.cancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
  });
});
