import { describe, expect, it } from 'vitest';
import { Rng } from './rng.ts';

function draw(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng.next());
}

describe('Rng', () => {
  it('repeats the same sequence for the same seed', () => {
    expect(draw(new Rng(42), 1000)).toEqual(draw(new Rng(42), 1000));
  });

  it('gives different sequences for neighbouring seeds', () => {
    const a = draw(new Rng(1), 16);
    const b = draw(new Rng(2), 16);
    expect(a).not.toEqual(b);
  });

  it('pins the first outputs so engine or refactor drift is caught', () => {
    const rng = new Rng(12345);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual([
      2345461488, 1344865159, 2974739204,
    ]);
  });

  it('keeps next() in [0, 1) and range() inside its bounds', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const r = rng.range(-2, 3);
      expect(r).toBeGreaterThanOrEqual(-2);
      expect(r).toBeLessThan(3);
      const s = rng.signed();
      expect(Math.abs(s)).toBeLessThanOrEqual(1);
    }
  });

  it('produces a standard normal from gaussian()', () => {
    const rng = new Rng(99);
    const n = 20_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const g = rng.gaussian();
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sumSq / n - mean * mean).toBeCloseTo(1, 1);
  });

  it('resumes exactly from a saved state', () => {
    const rng = new Rng(5);
    draw(rng, 37);
    const resumed = Rng.fromState(rng.state());
    expect(draw(resumed, 100)).toEqual(draw(rng, 100));
  });

  it('rejects seeds that are not safe integers', () => {
    expect(() => new Rng(1.5)).toThrow(RangeError);
    expect(() => new Rng(Number.NaN)).toThrow(RangeError);
  });
});
