import { describe, expect, it } from 'vitest';
import { bleedIslandEdges } from './island-bleed.ts';
import type { Part } from './parts.ts';

const SIZE = 64;

function island(u0: number, u1: number): Part {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([u0, 0.25, u1, 0.25, u1, 0.75, u0, 0.75]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    material: 'm',
    extra: {},
  };
}

function atlas(): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const inside = x >= 8 && x < 24 && y >= 16 && y < 48;
      const rim = inside && (x < 11 || x >= 21);
      const value = rim ? 5 : inside ? 160 : 0;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  return { width: SIZE, height: SIZE, data };
}

describe('bleedIslandEdges', () => {
  it('keeps island interiors and replaces the dark outline and gutter', () => {
    const out = bleedIslandEdges(atlas(), [island(8 / SIZE, 24 / SIZE)], 4);
    const at = (x: number, y: number): number => out.data[(y * SIZE + x) * 4] ?? 0;
    expect(at(16, 32)).toBe(160);
    expect(at(8, 32)).toBeGreaterThan(100);
    expect(at(23, 32)).toBeGreaterThan(100);
    expect(at(2, 2)).toBeGreaterThan(100);
    expect(at(40, 60)).toBeGreaterThan(100);
  });

  it('is deterministic and leaves alpha alone', () => {
    const parts = [island(8 / SIZE, 24 / SIZE)];
    const a = bleedIslandEdges(atlas(), parts, 4);
    const b = bleedIslandEdges(atlas(), parts, 4);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(a.data[3]).toBe(255);
  });

  it('returns the image untouched when no texel is deeper than the margin', () => {
    const source = atlas();
    const out = bleedIslandEdges(source, [island(8 / SIZE, 12 / SIZE)], 8);
    expect(out).toBe(source);
  });
});
