import { describe, expect, it, vi } from 'vitest';
import { normaliseWheel, startsGesture } from './domInput';
import { watchReducedMotion, type MotionSource } from './motion';

function source(matches: boolean) {
  let listener: ((e: { matches: boolean }) => void) | null = null;
  const s: MotionSource & { fire(v: boolean): void } = {
    matches,
    addEventListener: (_t, l) => {
      listener = l;
    },
    removeEventListener: (_t, l) => {
      if (listener === l) listener = null;
    },
    fire: (v) => listener?.({ matches: v }),
  };
  return s;
}

describe('watchReducedMotion', () => {
  it('reports the current value immediately and every change after', () => {
    const s = source(true);
    const seen: boolean[] = [];
    const stop = watchReducedMotion((v) => seen.push(v), s);
    s.fire(false);
    expect(seen).toEqual([true, false]);
    stop();
    s.fire(true);
    expect(seen).toEqual([true, false]);
  });

  it('assumes motion is fine when matchMedia is unavailable', () => {
    const cb = vi.fn();
    watchReducedMotion(cb, null)();
    expect(cb).toHaveBeenCalledWith(false);
  });
});

describe('normaliseWheel', () => {
  it('scales pixel, line and page deltas to notches', () => {
    expect(normaliseWheel(100, 0)).toBe(1);
    expect(normaliseWheel(3, 1)).toBeCloseTo(0.48);
    expect(normaliseWheel(-1, 2)).toBe(-8);
  });
});

describe('startsGesture', () => {
  it('lets touch and pen through and limits the mouse to the primary button', () => {
    expect(startsGesture('touch', 0)).toBe(true);
    expect(startsGesture('pen', 5)).toBe(true);
    expect(startsGesture('mouse', 0)).toBe(true);
    expect(startsGesture('mouse', 1)).toBe(false);
    expect(startsGesture('mouse', 2)).toBe(false);
  });
});
