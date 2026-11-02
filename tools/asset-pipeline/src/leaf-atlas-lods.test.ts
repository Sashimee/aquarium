import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { atlasLayout } from './leaf-atlas.ts';

const ASSETS = fileURLToPath(new URL('../../../apps/web/public/assets', import.meta.url));
const LEAVES = 24;
const CELL = { width: 128, height: 256 };

interface PrimData {
  uvs: Float32Array;
  indices: Uint32Array;
}

async function readLod(dir: string, level: number): Promise<PrimData[]> {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(join(dir, `lod${level}.glb`));
  return doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .map((prim) => ({
      uvs: Float32Array.from(prim.getAttribute('TEXCOORD_0')?.getArray() ?? []),
      indices: Uint32Array.from(prim.getIndices()?.getArray() ?? []),
    }));
}

function crossCellTriangles(prims: PrimData[], columns: number, rows: number): number {
  let crossing = 0;
  for (const { uvs, indices } of prims)
    for (let t = 0; t < indices.length; t += 3) {
      const cells = new Set<string>();
      for (let k = 0; k < 3; k++) {
        const v = indices[t + k]!;
        cells.add(`${Math.floor(uvs[v * 2]! * columns)},${Math.floor(uvs[v * 2 + 1]! * rows)}`);
      }
      if (cells.size > 1) crossing++;
    }
  return crossing;
}

describe('amazon-sword leaf atlas', () => {
  const dir = join(ASSETS, 'plant', 'amazon-sword');
  const layout = atlasLayout(LEAVES, CELL.width, CELL.height);

  it.each([0, 1, 2])(
    'LOD%i is one primitive with no triangle spanning two cells',
    async (level) => {
      const prims = await readLod(dir, level);
      expect(prims).toHaveLength(1);
      expect(crossCellTriangles(prims, layout.columns, layout.rows)).toBe(0);
    },
  );
});
