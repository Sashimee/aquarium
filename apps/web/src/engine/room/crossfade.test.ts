import { describe, expect, it } from 'vitest';
import { crossfade, crossfadeAt } from './crossfade';

describe('crossfadeAt', () => {
  it('keeps the copies half a period apart with weights that sum to one', () => {
    const out = crossfade();
    for (let t = -50; t <= 50; t += 0.37) {
      crossfadeAt(t, 10, out);
      expect(out.phaseA).toBeGreaterThanOrEqual(0);
      expect(out.phaseA).toBeLessThan(1);
      expect(out.phaseB).toBeGreaterThanOrEqual(0);
      expect(out.phaseB).toBeLessThan(1);
      expect((out.phaseB - out.phaseA + 1) % 1).toBeCloseTo(0.5, 9);
      expect(out.weightA).toBeGreaterThanOrEqual(0);
      expect(out.weightA).toBeLessThanOrEqual(1);
    }
  });

  it('restarts each copy only while it is invisible', () => {
    const out = crossfade();
    crossfadeAt(10, 10, out);
    expect(out).toEqual({ phaseA: 0, phaseB: 0.5, weightA: 0, cycleA: 1, cycleB: 1 });
    crossfadeAt(15, 10, out);
    expect(out).toEqual({ phaseA: 0.5, phaseB: 0, weightA: 1, cycleA: 1, cycleB: 2 });
    crossfadeAt(14.999, 10, out);
    expect(out.cycleB).toBe(1);
    expect(out.weightA).toBeCloseTo(1, 3);
    crossfadeAt(9.999, 10, out);
    expect(out.cycleA).toBe(0);
    expect(out.weightA).toBeCloseTo(0, 3);
  });

  it('works for times before the epoch', () => {
    const out = crossfadeAt(-2.5, 10, crossfade());
    expect(out.cycleA).toBe(-1);
    expect(out.phaseA).toBeCloseTo(0.75, 12);
    expect(out.weightA).toBeCloseTo(0.5, 12);
  });

  it('rejects a time or period it cannot use', () => {
    expect(() => crossfadeAt(Number.NaN, 10, crossfade())).toThrow(RangeError);
    expect(() => crossfadeAt(1, 0, crossfade())).toThrow(RangeError);
    expect(() => crossfadeAt(1, -3, crossfade())).toThrow(RangeError);
  });
});
