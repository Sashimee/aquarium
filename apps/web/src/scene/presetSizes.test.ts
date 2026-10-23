import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fitPresetDecor,
  keptPresetDecor,
  legacyTintSeed,
  TANK_SIZES,
  type DecorItem,
  type TankSize,
} from '@aquarium/shared';
import { layoutPlantKeys } from '@aquarium/sim/lifecycle';
import type { WebGPURenderer } from 'three/webgpu';
import { DEFAULT_TANK, TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { createSharedKtx2 } from '../engine/ktx2';
import { AssetCatalog, ModelLibrary } from './assets';
import { ColliderField } from './colliders';
import { generateEuphyllia, parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';
import { hullCorners } from '../fish/simColliders';
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

const MIN_DEPTH_SHARE = 0.4;
// Placed plant footprint per ground area against the authored patch, glass shrink included.
const MIN_NANO_COVERAGE_SHARE = 0.8;
// Plants of different patches in a nano; dev's closest pair is 0.004.
const MIN_CROSS_PATCH_GAP = 0.003;
const GLASS_NUDGE_TOLERANCE = 0.06;
// Life-size decor in the 0.25 m deep nano is pushed further off the glass than in the others.
const NANO_GLASS_NUDGE_TOLERANCE = 0.08;
// A nano's hardscape colliders are looser than the model bounds the fit keeps off the glass.
const NANO_COLLIDER_GLASS_SLACK = 0.003;
const MIN_NUDGED_SCALE_SHARE = 0.95;
const MIN_PATCH_SCALE_SHARE = 0.95;
const MIN_NANO_NUDGED_SCALE_SHARE = 0.7;
// Equal to the measured maxima (standard sizes: reef 2/4/5/5, freshwater 1; nano: reef 7,
// freshwater 2, blackwater 3) with no headroom: tripping it means a new item is being pushed off
// the glass, so move it inwards rather than raising the cap.
const MAX_NUDGED_ITEMS = { freshwater: 1, reef: 5, blackwater: 0 } as const;
const MAX_NUDGED_NANO_ITEMS = { freshwater: 2, reef: 7, blackwater: 3 } as const;

/**
 * Patches that cannot keep `MIN_DEPTH_SHARE` of their authored depth at a size, keyed
 * `<size>:<patch id>`, with the mean root z band they settle in. A nano holds its plants near life
 * size, so a back patch whose reach nears the half-depth cannot root as deep as authored. Height
 * is kept over depth.
 */
const KNOWN_DEPTH_SHORTFALLS: Readonly<Record<string, readonly [number, number]>> = {
  'nano30:vallisneria-right': [-0.013, -0.011],
};

/**
 * Patches a nano's life-size hardscape covers completely, keyed `<size>:<patch id>`. They stay in
 * the preset for the larger tanks; the nano plants the rest.
 */
const KNOWN_BLOCKED_PATCHES: ReadonlySet<string> = new Set(['nano30:lotus']);

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

describe('KNOWN_DEPTH_SHORTFALLS', () => {
  it('only pins patches that exist', () => {
    for (const key of Object.keys(KNOWN_DEPTH_SHORTFALLS)) {
      const [size, id] = key.split(':');
      expect(SIZES, key).toContain(size);
      const patches = [
        ...loadPreset('freshwater').plantPatches,
        ...loadPreset('reef').plantPatches,
      ];
      expect(
        patches.map((p) => p.id),
        key,
      ).toContain(id);
    }
  });
});

describe.each(['freshwater', 'reef'] as const)('%s preset at the standard tank', (biome) => {
  it('is only changed where it crossed the glass', () => {
    const authored = loadPreset(biome);
    const fitted = fitPresetToCatalog(authored, 'standard', TANK_DIMENSIONS.standard, catalog);
    const changed = fitted.decor
      .map((item, i) => ({ item, was: authored.decor[i] }))
      .filter(
        ({ item, was }) =>
          JSON.stringify({ ...item, tintSeed: 0 }) !== JSON.stringify({ ...was, tintSeed: 0 }),
      )
      .map(({ item }) => `${item.assetId}:${item.position.join(',')}:${item.scale}`);
    expect(changed).toMatchSnapshot();
    expect(fitted.plantPatches).toEqual(authored.plantPatches);
  });
});

describe.each(['freshwater', 'reef', 'blackwater'] as const)(
  '%s preset at every tank size',
  (biome) => {
    describe.each(SIZES)('%s', (size) => {
      const dimensions = TANK_DIMENSIONS[size];
      const waterTop = dimensions.height - dimensions.freeboard;
      const extent = glassExtent(dimensions);
      const fitted = () => fitPresetToCatalog(loadPreset(biome), size, dimensions, catalog);

      it('keys the plants the way the server keys the authored preset', () => {
        const keysOf = (decor: readonly DecorItem[]) =>
          layoutPlantKeys(
            decor
              .filter(
                (item) =>
                  !parseEuphylliaId(item.assetId) && catalog.get(item.assetId).kind === 'plant',
              )
              .map((item) => ({
                assetId: item.assetId,
                position: item.position,
                tintSeed: item.tintSeed ?? legacyTintSeed(item),
              })),
          );
        const authored = loadPreset(biome);
        expect(keysOf(fitted().decor)).toEqual(keysOf(keptPresetDecor(authored.decor, size)));
      });

      it('agrees with the server fit except where the glass nudged an item', () => {
        const authored = loadPreset(biome);
        const client = fitted().decor;
        const serverDecor = fitPresetDecor(authored.decor, size);
        expect(client).toHaveLength(serverDecor.length);
        const nudged: string[] = [];
        keptPresetDecor(authored.decor, size).forEach((item, i) => {
          const server = serverDecor[i];
          if (!server) throw new Error(`${item.assetId} is missing from the server fit`);
          const mine = client[i];
          if (!mine) throw new Error(`${item.assetId} is missing from the fitted preset`);
          const drift = Math.hypot(
            mine.position[0] - server.position[0],
            mine.position[2] - server.position[2],
          );
          if (drift > 1e-9) {
            nudged.push(item.assetId);
            expect(drift, item.assetId).toBeLessThanOrEqual(
              size === 'nano30' ? NANO_GLASS_NUDGE_TOLERANCE : GLASS_NUDGE_TOLERANCE,
            );
            expect(Math.abs(mine.position[0]), item.assetId).toBeLessThanOrEqual(
              Math.abs(server.position[0]) + 1e-9,
            );
            expect(Math.abs(mine.position[2]), item.assetId).toBeLessThanOrEqual(
              Math.abs(server.position[2]) + 1e-9,
            );
          }
          expect(mine.scale, item.assetId).toBeLessThanOrEqual(server.scale + 1e-9);
          expect(mine.scale, item.assetId).toBeGreaterThanOrEqual(
            server.scale *
              (size === 'nano30' ? MIN_NANO_NUDGED_SCALE_SHARE : MIN_NUDGED_SCALE_SHARE),
          );
          expect(mine.tintSeed, item.assetId).toBe(server.tintSeed);
          expect(mine.assetId).toBe(server.assetId);
          expect(mine.rotationY).toBe(server.rotationY);
        });
        expect(nudged.length).toBeLessThanOrEqual(
          (size === 'nano30' ? MAX_NUDGED_NANO_ITEMS : MAX_NUDGED_ITEMS)[biome],
        );
      });

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
        const slack = size === 'nano30' ? NANO_COLLIDER_GLASS_SLACK : 0;
        for (const c of colliders) {
          const ends = c.kind === 'capsule' ? [c.a, c.b] : hullCorners(c.planes);
          const pad = c.kind === 'capsule' ? c.radius : 0;
          for (const [x, y, z] of ends) {
            expect(Math.abs(x) + pad, c.kind).toBeLessThanOrEqual(innerHalfLength + slack);
            expect(Math.abs(z) + pad, c.kind).toBeLessThanOrEqual(innerHalfDepth + slack);
            expect(y + pad, c.kind).toBeLessThanOrEqual(waterTop);
          }
        }
      });
    });
  },
);

describe.each(['freshwater', 'reef', 'blackwater'] as const)(
  '%s plant patches at every tank size',
  (biome) => {
    describe.each(SIZES)('%s', (size) => {
      const dimensions = TANK_DIMENSIONS[size];
      const waterTop = dimensions.height - dimensions.freeboard;
      const extent = glassExtent(dimensions);
      const fitted = () => fitPresetToCatalog(loadPreset(biome), size, dimensions, catalog);

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
        const scales = new Map<string, number[]>();
        scatterPresetPatches(
          preset,
          catalog,
          new ColliderField(colliders),
          dimensions,
          size,
          (patch, instances) => {
            placed.set(patch.id, instances.length);
            scales.set(
              patch.id,
              instances.map((p) => p.scale),
            );
            for (const p of instances) {
              expect(Math.abs(p.x)).toBeLessThanOrEqual(extent.halfLength);
              expect(Math.abs(p.z)).toBeLessThanOrEqual(extent.halfDepth);
              expect(p.y).toBeLessThan(waterTop);
            }
          },
        );
        warn.mockRestore();
        for (const patch of preset.plantPatches) {
          if (KNOWN_BLOCKED_PATCHES.has(`${size}:${patch.id}`)) {
            expect(placed.get(patch.id), `${patch.id} was unblocked: drop it from the list`).toBe(
              0,
            );
            continue;
          }
          expect(placed.get(patch.id), patch.id).toBeGreaterThanOrEqual(Math.ceil(patch.count / 2));
        }
        if (biome === 'blackwater') {
          for (const patch of preset.plantPatches) {
            expect(placed.get(patch.id), `${patch.id} placed every sword`).toBe(patch.count);
          }
          if (size === 'standard') {
            for (const patch of loadPreset(biome).plantPatches) {
              const drawn = scales.get(patch.id) ?? [];
              const mean = drawn.reduce((sum, v) => sum + v, 0) / drawn.length;
              // Checks the patch average: single rosettes may sit well below it where decor crowds them.
              expect(mean, `${patch.id} mean scale`).toBeGreaterThanOrEqual(
                patch.scale[0] * MIN_PATCH_SCALE_SHARE,
              );
            }
          }
        }
      });

      it.runIf(size === 'nano30')("roots no two patches' plants on top of each other", async () => {
        const preset = fitted();
        const hard = preset.decor
          .filter((item) => !parseEuphylliaId(item.assetId))
          .map((item) => ({ item, kind: catalog.get(item.assetId).kind }))
          .filter(({ kind }) => kind !== 'anemone');
        const { colliders } = await movableColliders(library, hard, waterTop);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const roots: { id: string; x: number; z: number }[] = [];
        scatterPresetPatches(
          preset,
          catalog,
          new ColliderField(colliders),
          dimensions,
          size,
          (patch, instances) =>
            roots.push(...instances.map(({ x, z }) => ({ id: patch.id, x, z }))),
        );
        warn.mockRestore();
        let closest = Infinity;
        for (const a of roots) {
          for (const b of roots) {
            if (a.id !== b.id) closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
          }
        }
        expect(closest).toBeGreaterThanOrEqual(MIN_CROSS_PATCH_GAP);
      });

      it('keeps every patch at its authored depth', async () => {
        const preset = fitted();
        const hard = preset.decor
          .filter((item) => !parseEuphylliaId(item.assetId))
          .map((item) => ({ item, kind: catalog.get(item.assetId).kind }))
          .filter(({ kind }) => kind !== 'anemone');
        const { colliders } = await movableColliders(library, hard, waterTop);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // A nano's half-depth is barely wider than one plant's sway, so only half of a patch fits.
        const keptShare = size === 'nano30' ? 0.5 : 0.75;
        const roots = new Map<string, { x: number; z: number; scale: number }[]>();
        scatterPresetPatches(
          preset,
          catalog,
          new ColliderField(colliders),
          dimensions,
          size,
          (patch, instances) => roots.set(patch.id, instances),
        );
        warn.mockRestore();
        const authored = loadPreset(biome).plantPatches;
        for (const patch of preset.plantPatches) {
          const plants = roots.get(patch.id) ?? [];
          if (KNOWN_BLOCKED_PATCHES.has(`${size}:${patch.id}`)) {
            expect(plants, patch.id).toHaveLength(0);
            continue;
          }
          expect(plants.length, patch.id).toBeGreaterThanOrEqual(
            Math.ceil(patch.count * keptShare),
          );
          const meanX = plants.reduce((sum, p) => sum + p.x, 0) / plants.length;
          const meanZ = plants.reduce((sum, p) => sum + p.z, 0) / plants.length;
          const wanted = authored.find((a) => a.id === patch.id)?.center ?? [0, 0];
          const authoredZ = (wanted[1] * dimensions.depth) / DEFAULT_TANK.depth;
          const slack = Math.max(patch.radius, 0.06);
          expect(Math.abs(meanX - patch.center[0]), `${patch.id} x`).toBeLessThanOrEqual(slack * 2);
          if (Math.abs(authoredZ) <= 0.05) continue;
          const wasPatch = authored.find((a) => a.id === patch.id);
          if (size === 'nano30' && authoredZ > 0 && wasPatch) {
            const mean = (wasPatch.scale[0] + wasPatch.scale[1]) / 2;
            const was = (wasPatch.count * mean ** 2) / (Math.PI * wasPatch.radius ** 2);
            const now =
              plants.reduce((sum, p) => sum + p.scale ** 2, 0) / (Math.PI * patch.radius ** 2);
            expect(now / was, `${patch.id} placed coverage`).toBeGreaterThanOrEqual(
              MIN_NANO_COVERAGE_SHARE,
            );
          }
          const key = `${size}:${patch.id}`;
          const pinned = KNOWN_DEPTH_SHORTFALLS[key];
          if (pinned) {
            expect(
              meanZ,
              `${key} was fixed: drop it from KNOWN_DEPTH_SHORTFALLS`,
            ).toBeGreaterThanOrEqual(pinned[0]);
            expect(meanZ, key).toBeLessThanOrEqual(pinned[1]);
            expect(
              meanZ / authoredZ,
              `${key} was fixed: drop it from KNOWN_DEPTH_SHORTFALLS`,
            ).toBeLessThan(MIN_DEPTH_SHARE);
          } else {
            expect(Math.sign(meanZ), `${key} side`).toBe(Math.sign(authoredZ));
            expect(meanZ / authoredZ, `${key} depth share`).toBeGreaterThanOrEqual(MIN_DEPTH_SHARE);
          }
        }
      });
    });
  },
);
