import { describe, expect, it } from 'vitest';
import { seatEyes } from './eyes.ts';
import { normaliseFish } from './fish.ts';
import { FIN_ID_ATTRIBUTE, FIN_MASK_ATTRIBUTE } from './index-schema.ts';
import type { Part } from './parts.ts';

function ellipsoid(
  centre: [number, number, number],
  radii: [number, number, number],
  rings = 16,
  sectors = 24,
): Part {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < sectors; s++) {
      const theta = (2 * Math.PI * s) / sectors;
      positions.push(
        centre[0] + radii[0] * Math.sin(phi) * Math.cos(theta),
        centre[1] + radii[1] * Math.cos(phi),
        centre[2] + radii[2] * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < sectors; s++) {
      const a = r * sectors + s;
      const b = r * sectors + ((s + 1) % sectors);
      const c = (r + 1) * sectors + s;
      const d = (r + 1) * sectors + ((s + 1) % sectors);
      indices.push(a, c, b, b, c, d);
    }
  const count = positions.length / 3;
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(count * 3),
    uvs: new Float32Array(count * 2),
    indices: Uint32Array.from(indices),
    material: 'skin',
    extra: {},
  };
}

function merge(a: Part, b: Part): Part {
  const offset = a.positions.length / 3;
  return {
    ...a,
    positions: Float32Array.from([...a.positions, ...b.positions]),
    normals: Float32Array.from([...a.normals, ...b.normals]),
    uvs: Float32Array.from([...a.uvs, ...b.uvs]),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + offset)]),
  };
}

function at(values: ArrayLike<number>, index: number): number {
  return values[index] ?? Number.NaN;
}

function centroidOf(part: Part, keep: (x: number) => boolean): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < part.positions.length; i += 3) {
    if (!keep(at(part.positions, i))) continue;
    for (let a = 0; a < 3; a++) sum[a] = at(sum, a) + at(part.positions, i + a);
    n++;
  }
  return [at(sum, 0) / n, at(sum, 1) / n, at(sum, 2) / n];
}

describe('seatEyes', () => {
  const body = ellipsoid([0, 0, 0], [0.2, 0.3, 1]);
  const placement = { fromSnout: 0.25, height: 0.5, sink: 0.5 };

  function floatingEyes(): Part {
    return merge(
      ellipsoid([0.5, 0, 1.4], [0.1, 0.1, 0.1]),
      ellipsoid([-0.5, 0, 1.4], [0.1, 0.1, 0.1]),
    );
  }

  it('moves each eye onto its own flank at the requested spot on the head', () => {
    const eyes = floatingEyes();
    seatEyes(eyes, [body], placement);
    const left = centroidOf(eyes, (x) => x < 0);
    const right = centroidOf(eyes, (x) => x > 0);
    expect(right[2]).toBeCloseTo(1 - 0.25 * 2, 1);
    expect(left[2]).toBeCloseTo(right[2], 4);
    expect(right[1]).toBeCloseTo(left[1], 4);
    expect(right[0]).toBeGreaterThan(0.05);
    expect(right[0]).toBeLessThan(0.2);
    expect(left[0]).toBeCloseTo(-right[0], 3);
  });

  it('scales the eyes about their own centre', () => {
    const eyes = floatingEyes();
    seatEyes(eyes, [body], { ...placement, scale: 0.5 });
    const xs = Array.from({ length: eyes.positions.length / 3 }, (_, i) =>
      at(eyes.positions, i * 3),
    );
    const right = xs.filter((x) => x > 0);
    expect(Math.max(...right) - Math.min(...right)).toBeCloseTo(0.1, 2);
  });

  it('fails loudly when the eye position has no body', () => {
    expect(() => seatEyes(floatingEyes(), [], placement)).toThrow(/no vertices/);
  });
});

describe('normaliseFish attachments', () => {
  const body = ellipsoid([0, 0, 0], [0.2, 0.3, 1]);
  const eyes = ellipsoid([0.15, 0.05, 0.6], [0.05, 0.05, 0.05]);
  const input = { standardLengthM: 0.03 };

  it('keeps attachments rigid, in the body frame, and out of the fin attributes it computes', () => {
    const result = normaliseFish({ ...input, parts: [body], attachments: [eyes] });
    expect(result).toHaveLength(2);
    const attached = result.at(1);
    if (!attached) throw new Error('missing attachment');
    expect(Array.from(attached.extra[FIN_MASK_ATTRIBUTE] ?? [1]).every((v) => v === 0)).toBe(true);
    expect(Array.from(attached.extra[FIN_ID_ATTRIBUTE] ?? [1]).every((v) => v === 0)).toBe(true);
    const [x, , z] = centroidOf(attached, () => true);
    expect(x).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
    expect(Math.abs(x)).toBeLessThan(0.03);
  });

  it('classifies the body the same with or without attachments', () => {
    const without = normaliseFish({ ...input, parts: [body] });
    const withEyes = normaliseFish({ ...input, parts: [body], attachments: [eyes] });
    expect(withEyes.at(0)?.extra[FIN_ID_ATTRIBUTE]).toEqual(without.at(0)?.extra[FIN_ID_ATTRIBUTE]);
    expect(withEyes.at(0)?.extra[FIN_MASK_ATTRIBUTE]).toEqual(
      without.at(0)?.extra[FIN_MASK_ATTRIBUTE],
    );
  });
});
