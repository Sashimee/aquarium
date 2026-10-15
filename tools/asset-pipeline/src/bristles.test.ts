import { describe, expect, it } from 'vitest';
import { countSpikeVertices, despikeHead } from './bristles.ts';
import type { Part } from './parts.ts';
import { growBristles } from './tentacles.ts';

const RADIUS = 0.4;
const HALF_LENGTH = 1;

function ellipsoid(spikes: number[]): Part {
  const rings = 40;
  const around = 32;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let a = 0; a < around; a++) {
      const theta = (a / around) * Math.PI * 2;
      positions.push(
        RADIUS * Math.sin(phi) * Math.cos(theta),
        RADIUS * Math.sin(phi) * Math.sin(theta),
        HALF_LENGTH * Math.cos(phi),
      );
      uvs.push(a / around, r / rings);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r++)
    for (let a = 0; a < around; a++) {
      const i = r * around + a;
      const j = r * around + ((a + 1) % around);
      indices.push(i, i + around, j, j, i + around, j + around);
    }
  for (const index of spikes) {
    const length = Math.hypot(positions[index * 3]!, positions[index * 3 + 1]!);
    positions[index * 3] = (positions[index * 3]! / length) * (RADIUS + 0.25);
    positions[index * 3 + 1] = (positions[index * 3 + 1]! / length) * (RADIUS + 0.25);
  }
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) normals[i + 1] = 1;
  return {
    positions: Float32Array.from(positions),
    normals,
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material: 'skin',
    extra: {},
  };
}

const around = 32;
const headSpikes = [4, 8, 12].map((r) => r * around + 5);
const spec = { headFraction: 0.3, thickness: 0.03, reach: 0.004, rings: 2 };

function radialExcess(part: Part): number {
  let worst = 0;
  for (let i = 0; i < part.positions.length; i += 3) {
    const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!];
    const surface = RADIUS * Math.sqrt(Math.max(0, 1 - (z / HALF_LENGTH) ** 2));
    worst = Math.max(worst, Math.hypot(x, y) - surface);
  }
  return worst;
}

describe('despikeHead', () => {
  it('flattens single-vertex spikes on the head back onto the skin', () => {
    const part = ellipsoid(headSpikes);
    expect(radialExcess(part)).toBeGreaterThan(0.2);
    expect(countSpikeVertices(part, spec)).toBeGreaterThan(0);

    const moved = despikeHead(part, spec);

    expect(moved).toBeGreaterThanOrEqual(headSpikes.length);
    expect(radialExcess(part)).toBeLessThan(0.03);
  });

  it('leaves a smooth head untouched', () => {
    const part = ellipsoid([]);
    const before = Float32Array.from(part.positions);
    expect(despikeHead(part, spec)).toBe(0);
    expect(part.positions).toEqual(before);
  });

  it('leaves spikes behind the head alone', () => {
    const tail = ellipsoid([34 * around + 5]);
    const before = Float32Array.from(tail.positions);
    expect(despikeHead(tail, spec)).toBe(0);
    expect(tail.positions).toEqual(before);
  });

  it('keeps indices and uvs valid and normals unit length', () => {
    const part = ellipsoid(headSpikes);
    despikeHead(part, spec);
    for (const uv of part.uvs) expect(Number.isFinite(uv)).toBe(true);
    for (let i = 0; i < part.normals.length; i += 3)
      expect(Math.hypot(part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!)).toBeCloseTo(
        1,
        3,
      );
  });
});

describe('growBristles', () => {
  const body = ellipsoid([]);
  const bristles = { rim: 4, crown: 2, length: 0.05 };

  it('grows a finite, deterministic set of tentacles in front of the middle of the body', () => {
    const first = growBristles(body, bristles);
    const second = growBristles(body, bristles);
    expect(first.positions).toEqual(second.positions);
    expect(first.positions.length).toBeGreaterThan(0);
    expect(first.positions.every(Number.isFinite)).toBe(true);
    expect(first.indices.every((i) => i < first.positions.length / 3)).toBe(true);
    expect(first.material).toBe(body.material);
    for (let i = 2; i < first.positions.length; i += 3)
      expect(first.positions[i]!).toBeGreaterThan(0.3 * HALF_LENGTH);
  });

  it('puts tentacles on both sides and only the rim row when there is no crown', () => {
    const rimOnly = growBristles(body, { ...bristles, crown: 0 });
    const withCrown = growBristles(body, bristles);
    const xs = Array.from(
      { length: rimOnly.positions.length / 3 },
      (_, i) => rimOnly.positions[i * 3]!,
    );
    expect(Math.min(...xs)).toBeLessThan(-0.05);
    expect(Math.max(...xs)).toBeGreaterThan(0.05);
    expect(withCrown.positions.length).toBeGreaterThan(rimOnly.positions.length);
  });

  it('samples a small patch of the body texture', () => {
    const { uvs } = growBristles(body, bristles);
    const spanU =
      Math.max(...uvs.filter((_, i) => i % 2 === 0)) -
      Math.min(...uvs.filter((_, i) => i % 2 === 0));
    expect(spanU).toBeLessThan(0.05);
  });
});
