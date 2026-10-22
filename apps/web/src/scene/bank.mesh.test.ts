import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Matrix4, Vector3, type BufferGeometry, type WebGPURenderer } from 'three/webgpu';
import type { DecorItem, TankSize } from '@aquarium/shared';
import { createSharedKtx2 } from '../engine/ktx2';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import catalogIndex from '../../public/assets/index.json';
import { AssetCatalog, ModelLibrary } from './assets';
import { decorMatrix } from './hardscape';
import { fitPresetToTank, type BoundsOf } from './presetFit';
import { loadPreset } from './preset';

const PUBLIC = join(__dirname, '../../public');
const PARALLEL = 1e-9;

let library: ModelLibrary;

const boundsOf: BoundsOf = (assetId) => {
  const bounds = catalogIndex.assets.find((a) => a.id === assetId)?.bounds;
  return bounds ? { bounds, swayReach: null } : null;
};

beforeAll(() => {
  vi.stubGlobal('ProgressEvent', Event);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal(
    'Request',
    class {
      constructor(readonly url: string) {}
    },
  );
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'object' && 'url' in input ? input.url : String(input);
    const bytes = await readFile(join(PUBLIC, new URL(url, 'http://x').pathname));
    return new Response(new Uint8Array(bytes));
  });
  library = new ModelLibrary(
    createSharedKtx2({
      isWebGPURenderer: true,
      hasFeature: () => false,
    } as unknown as WebGPURenderer).loader,
    new AssetCatalog(catalogIndex.assets as ConstructorParameters<typeof AssetCatalog>[0]),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

type Tri = readonly [Vector3, Vector3, Vector3];

interface Box {
  readonly min: Vector3;
  readonly max: Vector3;
}

function triangles(geometries: readonly BufferGeometry[], matrix: Matrix4): Tri[] {
  const out: Tri[] = [];
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    const at = (n: number) =>
      new Vector3().fromBufferAttribute(position, index ? index.getX(n) : n).applyMatrix4(matrix);
    for (let i = 0; i + 2 < count; i += 3) out.push([at(i), at(i + 1), at(i + 2)]);
  }
  return out;
}

function boxOf(tris: readonly Tri[]): Box {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const tri of tris) {
    for (const v of tri) {
      min.min(v);
      max.max(v);
    }
  }
  return { min, max };
}

function boxesTouch(a: Box, b: Box): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

function segmentHitsTriangle(a: Vector3, b: Vector3, [p, q, r]: Tri): boolean {
  const dir = new Vector3().subVectors(b, a);
  const e1 = new Vector3().subVectors(q, p);
  const e2 = new Vector3().subVectors(r, p);
  const h = new Vector3().crossVectors(dir, e2);
  const det = e1.dot(h);
  if (Math.abs(det) < PARALLEL) return false;
  const s = new Vector3().subVectors(a, p);
  const u = s.dot(h) / det;
  if (u < 0 || u > 1) return false;
  const qv = new Vector3().crossVectors(s, e1);
  const v = dir.dot(qv) / det;
  if (v < 0 || u + v > 1) return false;
  const t = e2.dot(qv) / det;
  return t >= 0 && t <= 1;
}

function edgesPierce(from: readonly Tri[], into: readonly Tri[]): number {
  const target = boxOf(into);
  let hits = 0;
  for (const tri of from) {
    if (!boxesTouch(boxOf([tri]), target)) continue;
    const edges: readonly (readonly [Vector3, Vector3])[] = [
      [tri[0], tri[1]],
      [tri[1], tri[2]],
      [tri[2], tri[0]],
    ];
    for (const [a, b] of edges) {
      for (const other of into) {
        if (segmentHitsTriangle(a, b, other)) hits++;
      }
    }
  }
  return hits;
}

/** Edge-through-triangle crossings between two placed meshes; any triangle intersection has at least one. */
async function crossings(a: DecorItem, b: DecorItem): Promise<number> {
  const meshA = triangles(await library.collisionGeometry(a.assetId), decorMatrix(a));
  const meshB = triangles(await library.collisionGeometry(b.assetId), decorMatrix(b));
  return edgesPierce(meshA, meshB) + edgesPierce(meshB, meshA);
}

describe('the mangrove perch against the driftwood branch', () => {
  it.each(['standard', 'std200', 'long300'] satisfies TankSize[])(
    '%s: the trunk mesh does not pass through the branch mesh',
    async (size) => {
      const d = TANK_DIMENSIONS[size];
      const fitted = fitPresetToTank(loadPreset('mangrove'), size, d, boundsOf, () => 0);
      const perch = fitted.decor.reduce((a, b) =>
        a.position[1] + 0.28 * a.scale > b.position[1] + 0.28 * b.scale ? a : b,
      );
      const branch = fitted.decor.find((i) => i.assetId === 'driftwood-branch');
      if (!branch) throw new Error('mangrove preset has no driftwood branch');
      expect(
        await crossings(perch, branch),
        `${size}: ${perch.position} vs ${branch.position}`,
      ).toBe(0);
    },
    60_000,
  );
});
