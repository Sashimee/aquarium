import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocument, emitAsset } from './emit.ts';
import { readyCodecs } from './glb.ts';
import type { MaterialDef, Part } from './parts.ts';

function gridPart(cells: number, material: string, lods?: number[]): Part {
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
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  return {
    positions,
    normals,
    uvs: new Float32Array(side * side * 2),
    indices: Uint32Array.from(indices),
    material,
    extra: {},
    ...(lods ? { lods } : {}),
  };
}

const material = (name: string): MaterialDef => ({
  name,
  baseColorFactor: [0.5, 0.5, 0.5, 1],
  roughness: 0.5,
  metallic: 0,
  alphaMode: 'OPAQUE',
  doubleSided: false,
  normalScale: 1,
});

describe('emitAsset parts that carry their own levels of detail', () => {
  let outRoot = '';
  beforeAll(async () => {
    await readyCodecs();
    outRoot = mkdtempSync(join(tmpdir(), 'emit-lods-'));
  });
  afterAll(() => rmSync(outRoot, { recursive: true, force: true }));

  const emit = (parts: Part[]) =>
    emitAsset({
      outRoot,
      kind: 'fish',
      id: 'test-fish',
      built: buildDocument('test-fish', parts, [material('Body'), material('Eye')]),
      plan: { ratios: [1, 0.5, 0.25], minTriangles: 10 },
      meta: { origin: 'model', sources: [], licence: 'CC0', modifications: [] },
    });

  it('emits a tagged part only at its own level, untouched by simplification', async () => {
    const asset = await emit([
      gridPart(20, 'Body'),
      gridPart(3, 'Eye', [0]),
      gridPart(2, 'Eye', [1]),
      gridPart(1, 'Eye', [2]),
    ]);
    const bodyOnly = await emit([gridPart(20, 'Body')]);
    const tagged = [18, 8, 2];
    expect(asset.lods.map((l) => l.triangles)).toEqual(
      bodyOnly.lods.map((l, level) => l.triangles + tagged[level]!),
    );
  });

  it('simplifies untagged parts as before when nothing is tagged', async () => {
    const asset = await emit([gridPart(20, 'Body')]);
    const triangles = asset.lods.map((l) => l.triangles);
    expect(triangles[0]!).toBe(800);
    expect(triangles[1]!).toBeLessThan(triangles[0]!);
    expect(triangles[2]!).toBeLessThan(triangles[1]!);
  });

  it('fails loudly when a level would have no geometry at all', async () => {
    await expect(emit([gridPart(3, 'Eye', [0])])).rejects.toThrow(/LOD1 is empty/);
  });
});
