import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIN_ID_ATTRIBUTE, FIN_IDS, FIN_MASK_ATTRIBUTE, assetIndexSchema } from './index-schema.ts';
import { LOFT_FISH_RECIPES, paintWrasse } from './loft-fish.ts';

const ASSETS = fileURLToPath(new URL('../../../apps/web/public/assets', import.meta.url));
const STANDARD_LENGTH_M = 0.085;

interface Lod {
  positions: Float32Array;
  indices: Uint32Array;
  mask: Float32Array;
  finId: Float32Array;
}

async function readLod(level: number): Promise<Lod> {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(join(ASSETS, 'fish', 'cleaner-wrasse', `lod${level}.glb`));
  const prim = need(doc.getRoot().listMeshes()[0]?.listPrimitives()[0], `lod${level} primitive`);
  const array = (name: string): ArrayLike<number> =>
    need(need(prim.getAttribute(name), name).getArray(), `${name} array`);
  return {
    positions: Float32Array.from(array('POSITION')),
    indices: Uint32Array.from(need(need(prim.getIndices(), 'indices').getArray(), 'index array')),
    mask: Float32Array.from(array(FIN_MASK_ATTRIBUTE)),
    finId: Float32Array.from(array(FIN_ID_ATTRIBUTE)),
  };
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

const luma = ([r, g, b]: [number, number, number]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('cleaner wrasse painted colour map', () => {
  it('keeps a near-black stripe through mid-flank from the head to the peduncle', () => {
    for (const tn of [0.15, 0.3, 0.5, 0.7, 0.9]) {
      const colour = paintWrasse(tn, -0.005);
      expect(luma(colour), `tn ${tn}`).toBeLessThan(0.05);
    }
  });

  it('is pale and bluish-white on the belly and blue between the stripe and the belly', () => {
    const belly = paintWrasse(0.5, -0.05);
    expect(luma(belly)).toBeGreaterThan(0.6);
    expect(belly[2]).toBeGreaterThanOrEqual(belly[0]);
    const band = paintWrasse(0.6, -0.03);
    expect(band[2]).toBeGreaterThan(0.7);
    expect(band[2]).toBeGreaterThan(band[0] * 3);
  });

  it('shades the back from brownish at the front to clearly bluer at the rear', () => {
    const front = paintWrasse(0.2, 0.068 * 0.95);
    const rear = paintWrasse(0.85, 0.0467 * 0.95);
    expect(rear[2] - rear[0]).toBeGreaterThan(front[2] - front[0] + 0.25);
  });

  it('widens the stripe toward the tail', () => {
    const blackRows = (tn: number): number => {
      let rows = 0;
      for (let i = -90; i <= 90; i++) if (luma(paintWrasse(tn, i / 1000)) < 0.05) rows++;
      return rows;
    };
    expect(blackRows(0.9)).toBeGreaterThan(blackRows(0.2) * 1.3);
  });

  it('runs the caudal black to the margin with a blue edge on both lobes and a white fringe only top and bottom', () => {
    expect(luma(paintWrasse(1.08, 0))).toBeLessThan(0.05);
    const lowerEdge = paintWrasse(1.08, -0.062);
    expect(lowerEdge[2]).toBeGreaterThan(lowerEdge[0] * 2);
    const upperEdge = paintWrasse(1.08, 0.062);
    expect(upperEdge[2]).toBeGreaterThan(upperEdge[0] * 2);
    expect(luma(paintWrasse(1.2, 0))).toBeLessThan(0.05);
    expect(luma(paintWrasse(1.2, 0.075))).toBeGreaterThan(0.6);
    expect(luma(paintWrasse(1.2, -0.075))).toBeGreaterThan(0.6);
  });
});

const first = (lods: Lod[]): Lod => need(lods[0], 'lod0');

describe('shipped cleaner-wrasse asset', () => {
  let lods: Lod[] = [];
  beforeAll(async () => {
    lods = await Promise.all([0, 1, 2].map(readLod));
  });

  it('is a slender body scaled to an 8.5 cm standard length with the caudal behind it', () => {
    const { positions } = first(lods);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    positions.forEach((value, i) => {
      const axis = i % 3;
      lo[axis] = Math.min(lo[axis] ?? Infinity, value);
      hi[axis] = Math.max(hi[axis] ?? -Infinity, value);
    });
    const extent = (axis: number): number => need(hi[axis], 'hi') - need(lo[axis], 'lo');
    expect(extent(2)).toBeGreaterThan(STANDARD_LENGTH_M);
    expect(extent(2)).toBeLessThan(STANDARD_LENGTH_M * 1.35);
    expect(extent(2) / extent(1)).toBeGreaterThan(4.5);
    expect(extent(0)).toBeLessThan(extent(1));
  });

  it('points +Z forward: the caudal trails behind the origin and the snout is ahead of it', () => {
    const { positions, finId } = first(lods);
    let caudalZ = 0;
    let caudalCount = 0;
    let snoutZ = -Infinity;
    finId.forEach((id, v) => {
      const z = need(positions[v * 3 + 2], 'z');
      if (id === FIN_IDS.caudal) {
        caudalZ += z;
        caudalCount++;
      }
      snoutZ = Math.max(snoutZ, z);
    });
    expect(caudalCount).toBeGreaterThan(0);
    expect(caudalZ / caudalCount).toBeLessThan(0);
    expect(snoutZ).toBeGreaterThan(0);
  });

  it('bakes a fin mask with every fin id, rigid body at 0 and fin tips reaching 1', () => {
    for (const lod of lods) {
      const ids = new Set(lod.finId);
      for (const id of Object.values(FIN_IDS)) expect(ids.has(id)).toBe(true);
      expect(ids.has(0)).toBe(true);
      let rigid = 0;
      let tip = 0;
      for (let v = 0; v < lod.mask.length; v++) {
        if (lod.finId[v] === 0) {
          expect(lod.mask[v]).toBe(0);
          rigid++;
        } else if ((lod.mask[v] ?? 0) > 0.99) tip++;
      }
      expect(rigid).toBeGreaterThan(0);
      expect(tip).toBeGreaterThan(0);
    }
  });

  it('ships three strictly simplified levels of detail', () => {
    const counts = lods.map((lod) => lod.indices.length / 3);
    const [lod0, lod1, lod2] = counts.map((n) => need(n, 'triangle count'));
    expect(need(lod1, 'lod1')).toBeLessThan(need(lod0, 'lod0'));
    expect(need(lod2, 'lod2')).toBeLessThan(need(lod1, 'lod1'));
  });

  it('is registered in the index as a CC0 procedural loft with no photo sources', () => {
    const index = assetIndexSchema.parse(
      JSON.parse(readFileSync(join(ASSETS, 'index.json'), 'utf8')),
    );
    const entry = index.assets.find((a) => a.kind === 'fish' && a.id === 'cleaner-wrasse');
    expect(entry?.origin).toBe('procedural-loft');
    expect(entry?.licence).toBe('CC0-1.0');
    expect(entry?.sources).toEqual([]);
    expect(entry?.fish?.standardLengthM).toBe(STANDARD_LENGTH_M);
    expect(entry?.lods).toHaveLength(3);
  });

  it('has a recipe whose spine proportions are about 6:1 length to depth', () => {
    const recipe = need(
      LOFT_FISH_RECIPES.find((r) => r.id === 'cleaner-wrasse'),
      'cleaner-wrasse recipe',
    );
    const depth = Math.max(...recipe.spec.sections.map((s) => s.top - s.bottom));
    expect(1 / depth).toBeGreaterThan(5.5);
    expect(1 / depth).toBeLessThan(8);
  });
});
