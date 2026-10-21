import { describe, expect, it } from 'vitest';
import { boundsOf, canonicalVertices } from './crew-scan.ts';
import { FIN_ID_ATTRIBUTE, FIN_MASK_ATTRIBUTE, SNAIL_PART_IDS } from './index-schema.ts';
import { signedVolume } from './loft.ts';
import {
  buildNeriteBody,
  clipPart,
  measureLipEdge,
  shellFrame,
  trimLip,
  vertexRoughness,
} from './nerite.ts';
import type { Part } from './parts.ts';

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A smooth dome over a jittered flat underside, apex pushed to -z so the aperture side is +z. */
function crustyDome(): { positions: Float32Array; indices: Uint32Array } {
  const rand = random(7);
  const positions: number[] = [];
  const indices: number[] = [];
  const rings = 14;
  const segments = 32;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);
    for (let k = 0; k < segments; k++) {
      const theta = (k / segments) * Math.PI * 2;
      const shear = -0.25 * Math.cos(phi);
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta) + shear,
      );
    }
  }
  const domeVertices = positions.length / 3;
  const under = 12;
  for (let r = 0; r <= under; r++)
    for (let k = 0; k < segments; k++) {
      const theta = (k / segments) * Math.PI * 2;
      const radius = 1 - r / under;
      positions.push(
        radius * Math.cos(theta),
        (rand() - 0.5) * 0.4,
        radius * Math.sin(theta) + (rand() - 0.5) * 0.15,
      );
    }
  for (let r = 0; r < rings; r++)
    for (let k = 0; k < segments; k++) {
      const a = r * segments + k;
      const b = r * segments + ((k + 1) % segments);
      indices.push(a, b, a + segments, b, b + segments, a + segments);
    }
  for (let r = 0; r < under; r++)
    for (let k = 0; k < segments; k++) {
      const a = domeVertices + r * segments + k;
      const b = domeVertices + r * segments + ((k + 1) % segments);
      indices.push(a, a + segments, b, b, a + segments, b + segments);
    }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

describe('vertexRoughness', () => {
  it('is near zero on a smooth dome and high on a jittered underside', () => {
    const { positions, indices } = crustyDome();
    const canon = canonicalVertices(positions, 1e-4);
    const rough = vertexRoughness(positions, indices, canon);
    const domeVertexCount = 15 * 32;
    const meanOf = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += rough[i]!;
      return sum / (to - from);
    };
    expect(meanOf(0, domeVertexCount - 64)).toBeLessThan(0.02);
    expect(meanOf(domeVertexCount + 64, rough.length - 32)).toBeGreaterThan(0.08);
  });
});

describe('shellFrame', () => {
  it('points up from the crusty underside to the dome and forward from the apex towards the rest', () => {
    const { positions, indices } = crustyDome();
    const frame = shellFrame(positions, indices);
    expect(frame.up[1]).toBeGreaterThan(0.95);
    expect(frame.forward[2]).toBeGreaterThan(0.9);
    expect(Math.abs(frame.right[0])).toBeGreaterThan(0.95);
  });

  it('follows the dome when the whole shell is turned upside down', () => {
    const { positions, indices } = crustyDome();
    const flipped = positions.map((v, i) => (i % 3 === 1 ? -v : v));
    const frame = shellFrame(flipped, indices);
    expect(frame.up[1]).toBeLessThan(-0.95);
  });

  it('fails loudly when no rough surface exists', () => {
    const rings = 10;
    const segments = 24;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let r = 0; r <= rings; r++)
      for (let k = 0; k < segments; k++) {
        const phi = (r / rings) * Math.PI;
        const theta = (k / segments) * Math.PI * 2;
        positions.push(
          Math.sin(phi) * Math.cos(theta),
          Math.cos(phi),
          Math.sin(phi) * Math.sin(theta),
        );
      }
    for (let r = 0; r < rings; r++)
      for (let k = 0; k < segments; k++) {
        const a = r * segments + k;
        const b = r * segments + ((k + 1) % segments);
        indices.push(a, b, a + segments, b, b + segments, a + segments);
      }
    expect(() => shellFrame(Float32Array.from(positions), Uint32Array.from(indices))).toThrow(
      /no crusty underside/,
    );
  });
});

describe('buildNeriteBody', () => {
  const length = 0.02;
  const footprint = {
    halfWidth: 0.007,
    rearZ: -0.008,
    frontZ: 0.006,
    rimY: 0.002,
    lipUnderY: 0.003,
    ceilingY: 0.006,
  };
  const built = buildNeriteBody(footprint, length);
  const body = built.part;
  const count = body.positions.length / 3;
  const ids = body.extra[FIN_ID_ATTRIBUTE]!;
  const weights = body.extra[FIN_MASK_ATTRIBUTE]!;

  it('is a finite closed surface with outward winding and aligned attributes', () => {
    expect(body.positions.every(Number.isFinite)).toBe(true);
    expect(ids.length).toBe(count);
    expect(weights.length).toBe(count);
    expect(body.normals.length).toBe(count * 3);
    expect(signedVolume(body.positions, body.indices)).toBeGreaterThan(0);
    const uses = new Map<string, number>();
    for (let t = 0; t < body.indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const key = `${body.indices[t + k]}-${body.indices[t + ((k + 1) % 3)]}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    for (const [edge, n] of uses) {
      const [a, b] = edge.split('-');
      expect(n).toBe(1);
      expect(uses.get(`${b}-${a}`)).toBe(1);
    }
  });

  it('tags foot, head and both tentacles with weights in [0, 1]', () => {
    expect(new Set(ids)).toEqual(
      new Set([SNAIL_PART_IDS.foot, SNAIL_PART_IDS.head, SNAIL_PART_IDS.tentacle]),
    );
    expect(weights.every((w) => w >= 0 && w <= 1)).toBe(true);
    const tentacleTipWeight = Math.max(
      ...weights.filter((_, i) => ids[i] === SNAIL_PART_IDS.tentacle),
    );
    expect(tentacleTipWeight).toBe(1);
  });

  it('sits on the ground in front of the rear edge and reaches forward with the tentacles', () => {
    const { min, max } = boundsOf(body.positions);
    expect(min[1]).toBeCloseTo(0, 6);
    expect(min[0]).toBeLessThan(0);
    expect(max[0]).toBeGreaterThan(0);
    expect(max[2]).toBeGreaterThan(footprint.frontZ);
    expect(min[2]).toBeGreaterThan(footprint.rearZ - length * 0.1);
  });

  it('keeps the tentacles and the head clear of the shell, in front of its lip', () => {
    for (let i = 0; i < count; i++) {
      const z = body.positions[i * 3 + 2]!;
      if (ids[i] === SNAIL_PART_IDS.tentacle) expect(z).toBeGreaterThan(footprint.frontZ);
    }
    const headZ = [...ids.keys()]
      .filter((i) => ids[i] === SNAIL_PART_IDS.head)
      .map((i) => body.positions[i * 3 + 2]!);
    expect(headZ.reduce((a, b) => a + b, 0) / headZ.length).toBeGreaterThan(footprint.frontZ);
  });

  it('has a thin foot and slender tentacles that taper to the tip', () => {
    const footHeights = [...ids.keys()]
      .filter((i) => ids[i] === SNAIL_PART_IDS.foot)
      .map((i) => body.positions[i * 3 + 1]!)
      .sort((a, b) => a - b);
    expect(footHeights.at(-1)!).toBeLessThanOrEqual(footprint.ceilingY);
    expect(footHeights[Math.floor(footHeights.length / 2)]!).toBeLessThan(length * 0.11);
    const radiusAt = (weight: number): number => {
      const points = [...ids.keys()].filter(
        (i) =>
          ids[i] === SNAIL_PART_IDS.tentacle &&
          Math.abs(weights[i]! - weight) < 1e-6 &&
          body.positions[i * 3]! > 0,
      );
      const xs = points.map((i) => body.positions[i * 3]!);
      const ys = points.map((i) => body.positions[i * 3 + 1]!);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
    };
    expect(radiusAt(0.5)).toBeLessThan(length * 0.017);
    expect(radiusAt(0.875)).toBeLessThan(radiusAt(0.25));
    const side = [...ids.keys()].filter(
      (i) => ids[i] === SNAIL_PART_IDS.tentacle && body.positions[i * 3]! > 0,
    );
    const zs = side.map((i) => body.positions[i * 3 + 2]!);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(length * 0.2);
  });

  it('keeps the sole inside the shell footprint and ending at the head, with a rounded thick edge', () => {
    const sole = [...ids.keys()].filter(
      (i) => ids[i] === SNAIL_PART_IDS.foot && body.positions[i * 3 + 1]! < length * 0.02,
    );
    const at = (axis: number): number[] => sole.map((i) => body.positions[i * 3 + axis]!);
    expect(Math.max(...at(0).map(Math.abs))).toBeLessThanOrEqual(footprint.halfWidth);
    expect(Math.min(...at(2))).toBeGreaterThanOrEqual(footprint.rearZ);
    const headNose = Math.max(
      ...[...ids.keys()]
        .filter((i) => ids[i] === SNAIL_PART_IDS.head)
        .map((i) => body.positions[i * 3 + 2]!),
    );
    expect(Math.max(...at(2))).toBeLessThanOrEqual(headNose + length * 0.01);
    const footTop = Math.max(
      ...[...ids.keys()]
        .filter((i) => ids[i] === SNAIL_PART_IDS.foot)
        .map((i) => body.positions[i * 3 + 1]!),
    );
    const footIds = [...ids.keys()].filter((i) => ids[i] === SNAIL_PART_IDS.foot);
    const widest = Math.max(...footIds.map((i) => Math.abs(body.positions[i * 3]!)));
    const edge = footIds
      .filter((i) => Math.abs(body.positions[i * 3]!) > widest * 0.9)
      .map((i) => body.positions[i * 3 + 1]!);
    expect(footTop).toBeGreaterThan(length * 0.06);
    expect(Math.max(...edge) - Math.min(...edge)).toBeGreaterThan(length * 0.022);
  });

  it('gives every vertex a ramp coordinate in [0, 1] and puts the foot centre on the reported z', () => {
    expect(body.uvs.length).toBe(count * 2);
    for (let i = 0; i < count; i++) {
      expect(body.uvs[i * 2 + 1]!).toBeGreaterThanOrEqual(0);
      expect(body.uvs[i * 2 + 1]!).toBeLessThanOrEqual(1);
    }
    const footZ = [...ids.keys()]
      .filter((i) => ids[i] === SNAIL_PART_IDS.foot)
      .map((i) => body.positions[i * 3 + 2]!);
    expect(built.footCentreZ).toBeGreaterThan(Math.min(...footZ));
    expect(built.footCentreZ).toBeLessThan(Math.max(...footZ));
  });

  it('is deterministic', () => {
    const again = buildNeriteBody(footprint, length);
    expect(Array.from(again.part.positions)).toEqual(Array.from(body.positions));
  });
});

function sheet(nx: number, nz: number): Part {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const mark: number[] = [];
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = -1 + (2 * i) / nx;
      const z = (j / nz) * 2;
      positions.push(x, 0.01 * Math.sin(3 * x) + 0.2 * (j / nz) * z, z);
      normals.push(0, 1, 0);
      uvs.push(i / nx, j / nz);
      mark.push(x * 10);
    }
  const indices: number[] = [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      indices.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
    }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material: 'test',
    extra: { mark: Float32Array.from(mark) },
  };
}

describe('clipPart', () => {
  const field = (x: number, y: number): number => y - 0.1 - 0.05 * x;

  it('keeps only the side where the field is >= 0 and puts cut vertices on the zero line', () => {
    const part = sheet(6, 6);
    const cut = clipPart(part, (x, y, z) => field(x, y) + 0 * z);
    expect(cut.length).toBeGreaterThan(0);
    for (const [x, y] of cut) expect(Math.abs(field(x, y))).toBeLessThan(1e-5);
    for (let i = 0; i < part.positions.length / 3; i++)
      expect(field(part.positions[i * 3]!, part.positions[i * 3 + 1]!)).toBeGreaterThan(-1e-5);
  });

  it('interpolates uv, normal and extra attributes at cut vertices', () => {
    const part = sheet(6, 6);
    const original = sheet(6, 6);
    clipPart(part, (x, y) => field(x, y));
    const count = part.positions.length / 3;
    for (let i = 0; i < count; i++) {
      expect(
        Math.hypot(part.normals[i * 3]!, part.normals[i * 3 + 1]!, part.normals[i * 3 + 2]!),
      ).toBeCloseTo(1, 5);
      expect(part.extra.mark![i]!).toBeCloseTo(part.positions[i * 3]! * 10, 4);
      expect(part.uvs[i * 2]!).toBeCloseTo((part.positions[i * 3]! + 1) / 2, 4);
      expect(part.uvs[i * 2 + 1]!).toBeCloseTo(part.positions[i * 3 + 2]! / 2, 4);
    }
    expect(count).not.toBe(original.positions.length / 3);
  });

  it('shares cut vertices so every interior edge is used by two triangles', () => {
    const part = sheet(6, 6);
    clipPart(part, (x, y) => field(x, y));
    const uses = new Map<string, number>();
    for (let t = 0; t < part.indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = part.indices[t + k]!;
        const b = part.indices[t + ((k + 1) % 3)]!;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    expect(Math.max(...uses.values())).toBe(2);
    const onCut = (index: number): boolean =>
      Math.abs(field(part.positions[index * 3]!, part.positions[index * 3 + 1]!)) < 1e-5;
    const sheetBorder = (index: number): boolean => {
      const x = part.positions[index * 3]!;
      const z = part.positions[index * 3 + 2]!;
      return Math.abs(x) > 1 - 1e-5 || z < 1e-5 || z > 2 - 1e-5;
    };
    for (const [key, n] of uses) {
      if (n !== 1) continue;
      const [a, b] = key.split('-').map(Number) as [number, number];
      expect(
        (onCut(a) && onCut(b)) || (sheetBorder(a) && sheetBorder(b)),
        `edge ${key} is neither on the cut nor on the sheet border`,
      ).toBe(true);
    }
  });

  it('reuses a vertex that lies exactly on the cut and leaves no degenerate triangle', () => {
    const part = sheet(6, 6);
    const before = part.positions.length / 3;
    const cut = clipPart(part, (x) => x);
    expect(cut).toEqual([]);
    expect(part.positions.length / 3).toBeLessThan(before);
    const seen = new Set<string>();
    for (let i = 0; i < part.positions.length / 3; i++) {
      const key = Array.from(part.positions.subarray(i * 3, i * 3 + 3)).join(',');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (let t = 0; t < part.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => part.indices[t + k]! * 3) as [number, number, number];
      const p = part.positions;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!;
      const vy = p[c + 1]! - p[a + 1]!;
      const vz = p[c + 2]! - p[a + 2]!;
      expect(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)).toBeGreaterThan(
        1e-9,
      );
    }
  });

  it('removes everything when the field is negative everywhere', () => {
    const part = sheet(3, 3);
    expect(clipPart(part, () => -1)).toEqual([]);
    expect(part.indices.length).toBe(0);
  });
});

describe('measureLipEdge', () => {
  it('throws on a column with no shell vertex', () => {
    const part = sheet(4, 4);
    expect(() => measureLipEdge(part.positions, 1, 5, 2)).toThrow(/no shell vertex/);
  });

  it('returns one sample per column with finite height', () => {
    const part = sheet(80, 20);
    const edge = measureLipEdge(part.positions, 1, 0.5, 2);
    expect(edge.length).toBeGreaterThan(2);
    for (const s of edge) expect(Number.isFinite(s.y)).toBe(true);
  });
});

describe('trimLip', () => {
  it('leaves no shell vertex below the returned cut curve', () => {
    const part = sheet(120, 120);
    const cutY = trimLip(part, 1, 0.5, 2);
    for (let i = 0; i < part.positions.length / 3; i++)
      expect(
        part.positions[i * 3 + 1]! - cutY(part.positions[i * 3]!, part.positions[i * 3 + 2]!),
      ).toBeGreaterThan(-0.002);
  });
});
