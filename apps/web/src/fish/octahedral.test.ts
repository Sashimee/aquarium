import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three/webgpu';
import {
  directionToUv,
  fishViewDirection,
  frameInset,
  maxFrameMip,
  selectFrames,
  uvToDirection,
  type FrameSelection,
  type Vec3,
} from './octahedral';

const GRID = 9;

function directions(count: number): Vec3[] {
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const z = next() * 2 - 1;
    const angle = next() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(angle), z, r * Math.sin(angle)] as Vec3;
  });
}

const near = (a: Vec3, b: Vec3, digits = 9): void =>
  a.forEach((value, k) => expect(value).toBeCloseTo(b[k] ?? NaN, digits));

const fresh = (): FrameSelection => ({ i: -1, j: -1, fx: NaN, fy: NaN });

function weights(s: FrameSelection): { i: number; j: number; w: number }[] {
  return [
    { i: s.i, j: s.j, w: (1 - s.fx) * (1 - s.fy) },
    { i: s.i + 1, j: s.j, w: s.fx * (1 - s.fy) },
    { i: s.i, j: s.j + 1, w: (1 - s.fx) * s.fy },
    { i: s.i + 1, j: s.j + 1, w: s.fx * s.fy },
  ];
}

describe('octahedral mapping', () => {
  it('round-trips directions on both hemispheres', () => {
    for (const d of directions(400)) {
      const [u, v] = directionToUv(d);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      near(uvToDirection(u, v), d);
    }
  });

  it('lays the axes out as the bake does', () => {
    near(uvToDirection(0.5, 0.5), [0, 1, 0]);
    near(uvToDirection(1, 0.5), [1, 0, 0]);
    near(uvToDirection(0, 0.5), [-1, 0, 0]);
    near(uvToDirection(0.5, 1), [0, 0, 1]);
    near(uvToDirection(0.5, 0), [0, 0, -1]);
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      near(uvToDirection(u, v), [0, -1, 0]);
    }
  });
});

describe('selectFrames', () => {
  it('shows a side, head-on, top or bottom view with one exact frame', () => {
    const cases: [Vec3, number, number][] = [
      [[1, 0, 0], 8, 4],
      [[-1, 0, 0], 0, 4],
      [[0, 0, 1], 4, 8],
      [[0, 0, -1], 4, 0],
      [[0, 1, 0], 4, 4],
      // Every corner is the same -Y view; the fold lands on (8, 8).
      [[0, -1, 0], 8, 8],
    ];
    for (const [d, i, j] of cases) {
      const total = weights(selectFrames(d, GRID, fresh()))
        .filter((c) => c.i === i && c.j === j)
        .reduce((sum, c) => sum + c.w, 0);
      expect(total).toBeCloseTo(1, 8);
    }
  });

  it('keeps all four frames inside the grid with weights summing to one', () => {
    for (const d of directions(400)) {
      const s = selectFrames(d, GRID, fresh());
      expect(s.i).toBeGreaterThanOrEqual(0);
      expect(s.j).toBeGreaterThanOrEqual(0);
      expect(s.i + 1).toBeLessThanOrEqual(GRID - 1);
      expect(s.j + 1).toBeLessThanOrEqual(GRID - 1);
      expect(s.fx).toBeGreaterThanOrEqual(0);
      expect(s.fx).toBeLessThan(1);
      expect(s.fy).toBeGreaterThanOrEqual(0);
      expect(s.fy).toBeLessThan(1);
      const sum = weights(s).reduce((total, c) => total + c.w, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it('centres the blend on the view: the weighted frame positions are its atlas point', () => {
    for (const d of directions(400)) {
      let u = 0;
      let v = 0;
      for (const { i, j, w } of weights(selectFrames(d, GRID, fresh()))) {
        u += (w * i) / (GRID - 1);
        v += (w * j) / (GRID - 1);
      }
      const [eu, ev] = directionToUv(d);
      expect(u).toBeCloseTo(eu, 8);
      expect(v).toBeCloseTo(ev, 8);
    }
  });

  it('blends continuously as the view sweeps round the fish', () => {
    const at = (angle: number): Map<string, number> => {
      const s = selectFrames([Math.sin(angle), 0.3, Math.cos(angle)], GRID, fresh());
      const out = new Map<string, number>();
      for (const { i, j, w } of weights(s)) {
        const key = `${i},${j}`;
        out.set(key, (out.get(key) ?? 0) + w);
      }
      return out;
    };
    for (let k = 0; k < 720; k++) {
      const a = at((k / 720) * 2 * Math.PI);
      const b = at(((k + 1) / 720) * 2 * Math.PI);
      let change = 0;
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        change += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
      }
      expect(change).toBeLessThan(0.2);
    }
  });

  it('rejects a grid with no cells', () => {
    expect(() => selectFrames([1, 0, 0], 1, fresh())).toThrow(RangeError);
    expect(() => selectFrames([1, 0, 0], 8.5, fresh())).toThrow(RangeError);
  });
});

describe('frame inset', () => {
  it('caps the mips at 16 px frames and insets half a texel of that level', () => {
    expect(maxFrameMip(128)).toBe(3);
    expect(maxFrameMip(16)).toBe(0);
    expect(frameInset(128, maxFrameMip(128))).toBeCloseTo(1 / 32, 12);
  });
});

describe('fishViewDirection', () => {
  const pivot: Vec3 = [0, -0.02, -0.03];

  it('is the camera direction in fish axes, measured from the pivot', () => {
    const out = new Vector3();
    fishViewDirection(
      new Vector3(5, 0.04, 0.06),
      new Vector3(0, 0.08, 0.12),
      new Quaternion(),
      2,
      pivot,
      out,
    );
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(0, 12);
  });

  it('follows the fish turning: a fish heading +X shows its left flank to a camera at +Z', () => {
    const heading = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const out = new Vector3();
    fishViewDirection(new Vector3(0, 0, 3), new Vector3(), heading, 1, [0, 0, 0], out);
    // Fish +Z points along world +X, so world +Z is fish -X.
    expect(out.x).toBeCloseTo(-1, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(0, 12);
  });

  it('matches the inverse of the instance transform for any pose', () => {
    const q = new Quaternion(0.3, -0.5, 0.2, 0.7).normalize();
    const position = new Vector3(0.2, 0.3, -0.1);
    const camera = new Vector3(-0.4, 0.9, 1.3);
    const scale = 1.4;
    const out = new Vector3();
    fishViewDirection(camera, position, q, scale, pivot, out);
    const pivotWorld = new Vector3(...pivot).multiplyScalar(scale).applyQuaternion(q).add(position);
    const expected = camera.clone().sub(pivotWorld).normalize();
    const back = out.clone().applyQuaternion(q);
    expect(back.x).toBeCloseTo(expected.x, 12);
    expect(back.y).toBeCloseTo(expected.y, 12);
    expect(back.z).toBeCloseTo(expected.z, 12);
    expect(out.length()).toBeCloseTo(1, 12);
  });

  it('falls back to a side-on view with the camera on the pivot', () => {
    const out = new Vector3();
    fishViewDirection(new Vector3(), new Vector3(), new Quaternion(), 1, [0, 0, 0], out);
    expect(out.toArray()).toEqual([1, 0, 0]);
  });
});
