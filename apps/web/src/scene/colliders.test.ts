import { describe, expect, it } from 'vitest';
import { ColliderField, fitCapsuleChain, fitHull, transformPoints } from './colliders';

function boxPoints(hx: number, hy: number, hz: number, at: [number, number, number]): number[] {
  const out: number[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) out.push(at[0] + sx * hx, at[1] + sy * hy, at[2] + sz * hz);
  return out;
}

const normal = new Float64Array(3);

describe('fitHull', () => {
  const hull = fitHull(boxPoints(0.1, 0.05, 0.2, [0.3, 0.1, -0.2]));
  const field = new ColliderField([hull]);

  it('is negative inside and positive outside', () => {
    expect(field.hard(0.3, 0.1, -0.2, normal)).toBeLessThan(0);
    expect(field.hard(0.3, 0.5, -0.2, normal)).toBeGreaterThan(0);
  });

  it('measures the face distance and points the normal into free water', () => {
    const d = field.hard(0.3, 0.1 + 0.05 + 0.04, -0.2, normal);
    expect(d).toBeCloseTo(0.04, 6);
    expect(normal[1]).toBeCloseTo(1, 6);
  });

  it('never overestimates the distance to the box near a corner', () => {
    const corner: [number, number, number] = [0.4, 0.15, 0];
    const trueDistance = Math.hypot(0.03, 0.03, 0.03);
    const d = field.hard(corner[0] + 0.03, corner[1] + 0.03, corner[2] + 0.03, normal);
    expect(d).toBeLessThanOrEqual(trueDistance + 1e-9);
    expect(d).toBeGreaterThan(0);
  });

  it('rejects a degenerate point cloud', () => {
    expect(() => fitHull([0, 0, 0, 1, 1, 1])).toThrow(RangeError);
  });
});

describe('fitCapsuleChain', () => {
  const stick: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const bend = 0.1 * Math.sin(t * Math.PI);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      stick.push(t * 0.6, bend + Math.cos(a) * 0.02, Math.sin(a) * 0.02);
    }
  }

  it('wraps a bent branch with capsules that stay close to its surface', () => {
    const chain = fitCapsuleChain(stick, 4);
    expect(chain.length).toBe(4);
    const field = new ColliderField(chain);
    let covered = 0;
    const total = stick.length / 3;
    for (let i = 0; i < stick.length; i += 3) {
      const d = field.hard(stick[i] ?? 0, stick[i + 1] ?? 0, stick[i + 2] ?? 0, normal);
      expect(d).toBeLessThan(0.015);
      if (d <= 0.001) covered++;
    }
    expect(covered / total).toBeGreaterThan(0.9);
    expect(field.hard(0.3, 0.1 + 0.2, 0, normal)).toBeGreaterThan(0.1);
  });

  it('keeps hard and soft colliders apart', () => {
    const soft = fitCapsuleChain(stick, 2, false);
    const field = new ColliderField([...soft, fitHull(boxPoints(0.05, 0.05, 0.05, [1, 0, 0]))]);
    expect(field.softCount).toBe(2);
    expect(field.hardCount).toBe(1);
    expect(field.hard(0.3, 0.1, 0, normal)).toBeGreaterThan(0.5);
    expect(field.soft(0.3, 0.1, 0, normal)).toBeLessThan(0.05);
  });

  it('returns infinity for an empty list', () => {
    expect(new ColliderField([]).hard(0, 0, 0, normal)).toBe(Infinity);
  });
});

describe('transformPoints', () => {
  it('applies a column-major translation and scale', () => {
    // prettier-ignore
    const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1];
    expect(Array.from(transformPoints([1, 1, 1], m))).toEqual([3, 4, 5]);
  });
});
