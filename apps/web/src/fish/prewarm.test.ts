import { describe, expect, it } from 'vitest';
import { commitLodDraw, type WarmableLod } from './prewarm';

function lod(count: number, warmed = false) {
  const matrices = new Float32Array(32).fill(7);
  const meshes = [
    { count: -1, visible: false },
    { count: -1, visible: false },
  ];
  const collapsed: number[] = [];
  const target: WarmableLod = {
    count,
    warmed,
    matrices: { set: (value, offset) => matrices.set(value, offset) },
    instances: { collapse: (index) => collapsed.push(index) },
    meshes,
  };
  return { target, matrices, meshes, collapsed };
}

describe('commitLodDraw', () => {
  it('draws one collapsed instance from a LOD no fish uses yet', () => {
    const { target, matrices, meshes, collapsed } = lod(0);
    expect(commitLodDraw(target)).toBe(1);
    expect(Array.from(matrices.subarray(0, 16))).toEqual(Array(16).fill(0));
    expect(collapsed).toEqual([0]);
    expect(Array.from(matrices.subarray(16))).toEqual(Array(16).fill(7));
    expect(meshes).toEqual([
      { count: 1, visible: true },
      { count: 1, visible: true },
    ]);
    expect(target.warmed).toBe(true);
  });

  it('hides an empty LOD once it has been drawn', () => {
    const { target, matrices, meshes, collapsed } = lod(0, true);
    expect(commitLodDraw(target)).toBe(0);
    expect(Array.from(matrices)).toEqual(Array(32).fill(7));
    expect(collapsed).toEqual([]);
    expect(meshes.every((m) => m.count === 0 && !m.visible)).toBe(true);
  });

  it('draws exactly the placed fish and counts that as warm', () => {
    const { target, matrices, meshes, collapsed } = lod(2);
    expect(commitLodDraw(target)).toBe(2);
    expect(Array.from(matrices)).toEqual(Array(32).fill(7));
    expect(collapsed).toEqual([]);
    expect(meshes.every((m) => m.count === 2 && m.visible)).toBe(true);
    target.count = 0;
    expect(commitLodDraw(target)).toBe(0);
  });

  it('warms again after the materials change', () => {
    const { target } = lod(0);
    commitLodDraw(target);
    expect(commitLodDraw(target)).toBe(0);
    target.warmed = false;
    expect(commitLodDraw(target)).toBe(1);
  });
});
