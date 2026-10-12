import { Document } from '@gltf-transform/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { readyCodecs } from './glb.ts';
import { simplifyPrimitive, triangleCountOf } from './lod.ts';

function gridPrimitive(cells: number, indexed = true) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const side = cells + 1;
  const positions = new Float32Array(side * side * 3);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const o = (y * side + x) * 3;
      positions[o] = x / cells;
      positions[o + 1] = Math.sin(x * 0.7) * Math.cos(y * 0.7) * 0.05;
      positions[o + 2] = y / cells;
    }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++) {
      const a = y * side + x;
      indices.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
    }
  const prim = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer),
    );
  if (indexed)
    prim.setIndices(
      doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer),
    );
  return prim;
}

describe('simplifyPrimitive', () => {
  beforeAll(readyCodecs);

  it('reduces towards the target ratio', () => {
    const prim = gridPrimitive(40);
    const before = triangleCountOf(prim);
    simplifyPrimitive(prim, { ratio: 0.25, minTriangles: 10 });
    const after = triangleCountOf(prim);
    expect(after).toBeLessThan(before * 0.4);
    expect(after).toBeGreaterThan(0);
  });

  it('never goes below the minimum triangle count', () => {
    const prim = gridPrimitive(40);
    simplifyPrimitive(prim, { ratio: 0.001, minTriangles: 200 });
    expect(triangleCountOf(prim)).toBeGreaterThanOrEqual(150);
  });

  it('leaves a primitive alone when the target is not lighter', () => {
    const prim = gridPrimitive(10);
    const before = triangleCountOf(prim);
    simplifyPrimitive(prim, { ratio: 1, minTriangles: 10 });
    expect(triangleCountOf(prim)).toBe(before);
  });

  it('refuses an unindexed primitive', () => {
    expect(() =>
      simplifyPrimitive(gridPrimitive(4, false), { ratio: 0.5, minTriangles: 1 }),
    ).toThrow(/indexed/);
  });
});
