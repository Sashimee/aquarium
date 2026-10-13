import { describe, expect, it } from 'vitest';
import { CAUDAL_SCALE_FOLD, CAUDAL_SCALE_MIN, scaleCaudal, type FinResult } from './fins.ts';
import { FIN_IDS } from './index-schema.ts';

const at = (p: ArrayLike<number>, i: number): number => {
  const v = p[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
};

const edge = (p: Float32Array, a: number, b: number): number =>
  Math.hypot(
    at(p, a * 3) - at(p, b * 3),
    at(p, a * 3 + 1) - at(p, b * 3 + 1),
    at(p, a * 3 + 2) - at(p, b * 3 + 2),
  );

/** A body column, a dorsal and an anal fin edge, running back past the peduncle at z = 0 where all become caudal. */
function strip() {
  const positions: number[] = [];
  const ids: number[] = [];
  const masks: number[] = [];
  const indices: number[] = [];
  const rows = 41;
  for (let r = 0; r < rows; r++) {
    const z = 0.2 - r * 0.02;
    const behind = z < 0;
    for (const y of [1, 1.2, 0.8]) {
      positions.push(0, y, z);
      ids.push(behind ? FIN_IDS.caudal : y === 1 ? 0 : y === 1.2 ? FIN_IDS.dorsal : FIN_IDS.anal);
      masks.push(behind ? 0.5 : y === 1 ? 0 : 0.7);
    }
  }
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < 2; c++) {
      const a = r * 3 + c;
      indices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
    }
  const fins: FinResult = {
    mask: Float32Array.from(masks),
    id: Float32Array.from(ids),
    zSnout: 1,
    zPeduncle: 0,
    zTail: -0.6,
  };
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i] = 1;
  return { positions: Float32Array.from(positions), normals, fins, indices };
}

describe('scaleCaudal', () => {
  it('keeps edges around the peduncle within 1.2x of their length and leaves ids and masks alone', () => {
    const { positions, normals, fins, indices } = strip();
    const before = Float32Array.from(positions);
    const ids = Float32Array.from(fins.id);
    const masks = Float32Array.from(fins.mask);
    scaleCaudal(positions, normals, fins, 0.5);
    expect(fins.id).toEqual(ids);
    expect(fins.mask).toEqual(masks);
    let checked = 0;
    for (let t = 0; t < indices.length; t += 3)
      for (const [i, j] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as const) {
        const a = at(indices, t + i);
        const b = at(indices, t + j);
        if (Math.min(at(before, a * 3 + 2), at(before, b * 3 + 2)) < -0.1) continue;
        checked++;
        expect(edge(positions, a, b) / edge(before, a, b)).toBeLessThan(1.2);
      }
    expect(checked).toBeGreaterThan(20);
  });

  it('shrinks the far tail by the factor and leaves vertices ahead of the peduncle alone', () => {
    const { positions, normals, fins } = strip();
    const before = Float32Array.from(positions);
    scaleCaudal(positions, normals, fins, 0.5);
    for (let i = 0; i < 3 * 11; i++) expect(positions[i * 3 + 2]).toBe(before[i * 3 + 2]);
    const last = positions.length / 3 - 1;
    expect(positions[last * 3 + 2]).toBeCloseTo(-0.3, 6);
  });

  it('centres the tail on the mean height of all body vertices just ahead of the peduncle', () => {
    const positions = Float32Array.from([0, 1, 0.01, 0, 2, 0.02, 0, 3, 0.03, 0, 5, -0.3]);
    const fins: FinResult = {
      mask: new Float32Array(4),
      id: Float32Array.from([0, 0, 0, FIN_IDS.caudal]),
      zSnout: 1,
      zPeduncle: 0,
      zTail: -0.6,
    };
    const normals = new Float32Array(12);
    normals[11] = 1;
    scaleCaudal(positions, normals, fins, 0.5);
    expect(positions[10]).toBeCloseTo(2 + (5 - 2) * 0.5, 6);
  });

  it('throws when no body vertex sits just ahead of the peduncle', () => {
    const positions = Float32Array.from([0, 1, -0.3]);
    const fins: FinResult = {
      mask: new Float32Array(1),
      id: Float32Array.from([FIN_IDS.caudal]),
      zSnout: 1,
      zPeduncle: 0,
      zTail: -0.6,
    };
    expect(() => scaleCaudal(positions, new Float32Array(3), fins, 0.5)).toThrow(/no body vertex/);
  });

  it('rejects caudalScale outside the fold-free range and accepts its edges and the recipes', () => {
    expect(CAUDAL_SCALE_MIN).toBeGreaterThan(CAUDAL_SCALE_FOLD);
    for (const bad of [0.4, 0.44, 1.01, 0, -1, Number.NaN]) {
      const { positions, normals, fins } = strip();
      expect(() => scaleCaudal(positions, normals, fins, bad, 'betta')).toThrow(
        /betta: caudalScale .* outside 0\.45-1/,
      );
    }
    for (const ok of [CAUDAL_SCALE_MIN, 0.56, 0.76, 1]) {
      const { positions, normals, fins } = strip();
      expect(() => scaleCaudal(positions, normals, fins, ok)).not.toThrow();
    }
  });
});
