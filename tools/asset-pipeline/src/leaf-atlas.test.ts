import { describe, expect, it } from 'vitest';
import { atlasLayout, leafLocalUvs, packLeafAtlas } from './leaf-atlas.ts';
import type { Part } from './parts.ts';

const card = (offset: number): Part => ({
  positions: new Float32Array([
    offset,
    0,
    0,
    offset + 0.01,
    0.05,
    0.02,
    offset - 0.01,
    0.05,
    -0.02,
    offset,
    0.2,
    0,
  ]),
  normals: new Float32Array(12).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
  uvs: new Float32Array(8),
  indices: Uint32Array.from([0, 1, 2, 1, 3, 2]),
  material: `m${offset}`,
  extra: {},
});

describe('leafLocalUvs', () => {
  it('puts the lowest vertex at v 0 and the tip at v 1', () => {
    const uvs = leafLocalUvs(card(0).positions);
    expect(uvs[1]).toBeCloseTo(0);
    expect(uvs[7]).toBeCloseTo(1);
  });

  it('is symmetric across the midrib', () => {
    const uvs = leafLocalUvs(card(0).positions);
    expect(uvs[2]! + uvs[4]!).toBeCloseTo(1);
  });

  it('stays in the unit square', () => {
    for (const v of leafLocalUvs(card(0.3).positions)) {
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('packLeafAtlas', () => {
  const layout = atlasLayout(3, 4, 8);
  const leaf = { width: 4, height: 8, data: new Uint8Array(4 * 8 * 4).fill(100) };
  const white: [number, number, number] = [1, 1, 1];

  it('rounds the atlas up to power-of-two cells', () => {
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(2);
  });

  it('keeps one part per leaf, all on the same material', () => {
    const { parts } = packLeafAtlas(
      [card(0), card(1), card(2)],
      leaf,
      [white, white, white],
      layout,
    );
    expect(parts).toHaveLength(3);
    expect(new Set(parts.map((p) => p.material)).size).toBe(1);
    for (const p of parts) expect(Math.max(...p.indices)).toBe(3);
  });

  it('keeps each leaf inside its own cell and tints it by its shade', () => {
    const { parts, atlas } = packLeafAtlas([card(0), card(1)], leaf, [white, [0.5, 1, 2]], layout);
    for (let v = 0; v < 4; v++) {
      expect(parts[0]!.uvs[v * 2]!).toBeLessThanOrEqual(0.5);
      expect(parts[1]!.uvs[v * 2]!).toBeGreaterThanOrEqual(0.5);
    }
    expect(atlas.data[0]).toBe(100);
    expect(atlas.data[4 * 4]).toBe(50);
    expect(atlas.data[4 * 4 + 2]).toBe(200);
  });

  it('refuses a shade count that does not match the leaves', () => {
    expect(() => packLeafAtlas([card(0)], leaf, [], layout)).toThrow(/shades/);
  });

  it('refuses a leaf image that is not the cell size', () => {
    const small = { width: 2, height: 2, data: new Uint8Array(16) };
    expect(() => packLeafAtlas([card(0)], small, [white], layout)).toThrow(/cell/);
  });
});
