import { describe, expect, it } from 'vitest';
import type { Part } from './parts.ts';
import { worldSpotImage } from './world-spots.ts';

function quad(uvScale: number): Part {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, uvScale, 0, uvScale, uvScale, 0, uvScale]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    material: 'm',
    extra: {},
  };
}

function blank(size: number) {
  const data = new Uint8Array(size * size * 4).fill(40);
  return { width: size, height: size, data };
}

const spec = {
  cell: 0.2,
  radius: 0.3,
  density: 1,
  colour: [250, 250, 250] as [number, number, number],
  seed: 3,
};

function coveredFraction(uvScale: number): number {
  const out = worldSpotImage(blank(128), [quad(uvScale)], spec);
  const size = Math.round(128 * uvScale);
  let covered = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if ((out.data[(y * 128 + x) * 4] ?? 0) > 140) covered++;
  return covered / (size * size);
}

describe('worldSpotImage', () => {
  it('paints the same share of the surface however the UVs are stretched', () => {
    const full = coveredFraction(1);
    expect(full).toBeGreaterThan(0.005);
    expect(coveredFraction(0.5)).toBeCloseTo(full, 1);
  });

  it('leaves texels outside the UV layout untouched', () => {
    const out = worldSpotImage(blank(64), [quad(0.25)], spec);
    expect(out.data[(40 * 64 + 40) * 4]).toBe(40);
  });
});
