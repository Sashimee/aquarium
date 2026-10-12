import { describe, expect, it, vi } from 'vitest';
import { onPageTeardown, type PageEventTarget } from './pageLifecycle';

function fakeTarget() {
  let listener: ((e: { persisted: boolean }) => void) | null = null;
  const target: PageEventTarget & { fire(persisted: boolean): void } = {
    addEventListener: (_t, l) => {
      listener = l;
    },
    removeEventListener: (_t, l) => {
      if (listener === l) listener = null;
    },
    fire: (persisted) => listener?.({ persisted }),
  };
  return target;
}

describe('onPageTeardown', () => {
  it('tears down when the page is discarded', () => {
    const target = fakeTarget();
    const teardown = vi.fn();
    onPageTeardown(target, teardown);
    target.fire(false);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('keeps everything alive when the page enters the back/forward cache, and still tears down later', () => {
    const target = fakeTarget();
    const teardown = vi.fn();
    onPageTeardown(target, teardown);
    target.fire(true);
    expect(teardown).not.toHaveBeenCalled();
    target.fire(false);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('stops listening once detached', () => {
    const target = fakeTarget();
    const teardown = vi.fn();
    onPageTeardown(target, teardown)();
    target.fire(false);
    expect(teardown).not.toHaveBeenCalled();
  });
});
