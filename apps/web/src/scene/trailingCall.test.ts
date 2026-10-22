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

  it('cancel drops a pending call', () => {
    const run = vi.fn();
    const call = trailingCall(run, 100);
    call.schedule();
    call.cancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
  });
});
