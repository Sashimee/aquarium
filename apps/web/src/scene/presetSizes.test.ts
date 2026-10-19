import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TANK_SIZES, type TankSize } from '@aquarium/shared';
import type { WebGPURenderer } from 'three/webgpu';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { createSharedKtx2 } from '../engine/ktx2';
import { AssetCatalog, ModelLibrary } from './assets';
import { ColliderField } from './colliders';
import { generateEuphyllia, parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';
import { boundsFromCatalog } from './presetFit';
import { SURFACE_MARGIN } from './plants';
import {
  DEFAULT_CURRENT,
  checkClearOfGlass,
  checkEuphylliaClearOfGlass,
  fitPresetToCatalog,
  glassExtent,
  movableColliders,
  scatterPresetPatches,
} from './TankScene';

const PUBLIC = join(__dirname, '../../public');
const SIZES = Object.keys(TANK_SIZES) as TankSize[];

let library: ModelLibrary;
let catalog: AssetCatalog;

beforeAll(async () => {
  const index = JSON.parse(await readFile(join(PUBLIC, 'assets/index.json'), 'utf8')) as {
    assets: ConstructorParameters<typeof AssetCatalog>[0];
  };
  catalog = new AssetCatalog(index.assets);
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
    catalog,
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe.each(['freshwater', 'reef'] as const)('%s preset at every tank size', (biome) => {
  describe.each(SIZES)('%s', (size) => {
    const dimensions = TANK_DIMENSIONS[size];
    const waterTop = dimensions.height - dimensions.freeboard;
    const extent = glassExtent(dimensions);
    const fitted = () => fitPresetToCatalog(loadPreset(biome), dimensions, catalog);

    it('keeps every decor item inside the glass and under the waterline', () => {
      const boundsOf = boundsFromCatalog(catalog, loadPreset(biome).current ?? DEFAULT_CURRENT);
      for (const item of fitted().decor) {
        const model = boundsOf(item.assetId);
        if (!model) throw new Error(`${item.assetId} has no bounds`);
        const top = item.position[1] + (model.bounds.max[1] ?? 0) * item.scale;
        expect(top, item.assetId).toBeLessThanOrEqual(waterTop - SURFACE_MARGIN + 1e-9);
        expect(Math.abs(item.position[0]), item.assetId).toBeLessThan(extent.halfLength);
        expect(Math.abs(item.position[2]), item.assetId).toBeLessThan(extent.halfDepth);
      }
    });

    it('passes the glass checks the scene runs while loading', () => {
      const preset = fitted();
      const current = preset.current ?? DEFAULT_CURRENT;
      for (const item of preset.decor) {
        const procedural = parseEuphylliaId(item.assetId);
        if (procedural) {
          const { bounds } = generateEuphyllia(procedural.variant, procedural.seed, 2);
          expect(() => checkEuphylliaClearOfGlass(item, bounds, current, extent)).not.toThrow();
        } else if (catalog.get(item.assetId).kind === 'anemone') {
          expect(() =>
            checkClearOfGlass(catalog.get(item.assetId), item, current, extent),
          ).not.toThrow();
        }
      }
    });

    it('keeps every hardscape collider inside the glass and under the waterline', async () => {
      const preset = fitted();
      const hard = preset.decor
        .filter((item) => !parseEuphylliaId(item.assetId))
        .map((item) => ({ item, kind: catalog.get(item.assetId).kind }))
        .filter(({ kind }) => kind !== 'anemone');
      const { colliders } = await movableColliders(library, hard, waterTop);
      const innerHalfLength = dimensions.length / 2 - dimensions.glass;
      const innerHalfDepth = dimensions.depth / 2 - dimensions.glass;
      for (const c of colliders) {
        const ends = c.kind === 'capsule' ? [c.a, c.b] : [c.centre];
        const pad = c.kind === 'capsule' ? c.radius : 0;
        for (const [x, y, z] of ends) {
          expect(Math.abs(x) + pad, c.kind).toBeLessThanOrEqual(innerHalfLength);
          expect(Math.abs(z) + pad, c.kind).toBeLessThanOrEqual(innerHalfDepth);
          expect(y + pad, c.kind).toBeLessThanOrEqual(waterTop);
        }
      }
    });

    it('builds hardscape colliders and places plants in every patch', async () => {
      const preset = fitted();
      const hard = preset.decor
        .filter((item) => !parseEuphylliaId(item.assetId))
        .map((item) => ({ item, kind: catalog.get(item.assetId).kind }))
        .filter(({ kind }) => kind !== 'anemone');
      const { colliders } = await movableColliders(library, hard, waterTop);
      expect(colliders.length).toBeGreaterThan(0);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const placed = new Map<string, number>();
      scatterPresetPatches(
        preset,
        catalog,
        new ColliderField(colliders),
        dimensions,
        (patch, instances) => {
          placed.set(patch.id, instances.length);
          for (const p of instances) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(extent.halfLength);
            expect(Math.abs(p.z)).toBeLessThanOrEqual(extent.halfDepth);
            expect(p.y).toBeLessThan(waterTop);
          }
        },
      );
      warn.mockRestore();
      for (const patch of preset.plantPatches) {
        expect(placed.get(patch.id), patch.id).toBeGreaterThanOrEqual(Math.ceil(patch.count / 2));
      }
    });
  });
});
