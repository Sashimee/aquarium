import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import {
  TANK_SIZES,
  type Biome,
  type Collider,
  type DecorItem,
  type TankSize,
} from '@aquarium/shared';
import { compileCollider, FishState, World } from '@aquarium/sim';
import { createSharedKtx2 } from '../engine/ktx2';
import { DEFAULT_TANK, TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { demoTank, sceneAnchorsToSim } from '../fish/demoStock';
import { SimWorldSpec } from '../fish/simWorld';
import { AssetCatalog, ModelLibrary } from './assets';
import { caveAnchors } from './caves';
import { sceneCollidersToSim } from '../fish/simColliders';
import { collidersFor } from '../interaction/decor/colliders';
import { specsFromCatalog } from '../interaction/decor/spec';
import type { Collider as SceneCollider } from './colliders';
import { fitCollider, HARDSCAPE_KINDS } from './hardscape';
import { loadPreset } from './preset';
import { fitPresetToCatalog } from './TankScene';

const PUBLIC = join(__dirname, '../../public');
const SHELTERED: readonly Biome[] = ['reef', 'cichlid'];
const SIZES = Object.keys(TANK_SIZES) as TankSize[];
const SEEDS = [1, 2, 3, 4];
const STEPS_PER_PHASE = 9000;
const CONTACTS_PER_FISH_STEP = 1e-3;

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

type Layer = 'scene hulls' | 'decor colliders';
const LAYERS: readonly Layer[] = ['scene hulls', 'decor colliders'];

/**
 * The hard colliders for a preset's rocks and shells: the scene's own fitted hulls, and the
 * colliders the decor layer reports to the sim once it mounts (shelter parts for shelters, boxes
 * for other rocks), which replace them at runtime.
 */
async function hardColliders(
  biome: Biome,
  layer: Layer,
  decor: readonly DecorItem[] = loadPreset(biome).decor,
): Promise<Collider[]> {
  const specs = specsFromCatalog(catalog.entries());
  const boxes: Collider[] = [];
  const hulls: SceneCollider[] = [];
  for (const [i, item] of decor.entries()) {
    if (!catalog.has(item.assetId)) continue;
    const kind = catalog.get(item.assetId).kind;
    if (!HARDSCAPE_KINDS.has(kind)) continue;
    const spec = specs.get(item.assetId);
    if (spec) boxes.push(...collidersFor(`piece-${i}`, spec, item));
    hulls.push(...fitCollider(kind, await library.collisionGeometry(item.assetId), item));
  }
  return layer === 'decor colliders' ? boxes : sceneCollidersToSim(hulls);
}

function clearanceTo(colliders: readonly Collider[]) {
  const solids = colliders.filter((c) => c.hard).map(compileCollider);
  const normal = new Float64Array(3);
  return (x: number, y: number, z: number): number =>
    Math.min(...solids.map((p) => p.sample(x, y, z, normal)));
}

async function expectMouthsClear(biome: Biome, layer: Layer, decor: readonly DecorItem[]) {
  const clearance = clearanceTo(await hardColliders(biome, layer, decor));
  const anchors = caveAnchors(decor);
  expect(anchors.length).toBeGreaterThan(0);
  for (const a of anchors) {
    const [x, y, z] = a.position;
    expect(clearance(x, y, z), a.id).toBeGreaterThanOrEqual(0.9 * a.radius);
  }
}

describe.each(LAYERS)('cave anchors against the %s fish meet', (layer) => {
  describe.each(SHELTERED)('%s', (biome) => {
    it('has room for a fish at every anchor', async () => {
      await expectMouthsClear(biome, layer, loadPreset(biome).decor);
    });

    it.each(SIZES)('%s: every anchor has room for a fish', async (size) => {
      const fitted = fitPresetToCatalog(loadPreset(biome), size, TANK_DIMENSIONS[size], catalog);
      await expectMouthsClear(biome, layer, fitted.decor);
    });

    it.each(SIZES)('%s: every anchor has a clear way out along its facing', async (size) => {
      const fitted = fitPresetToCatalog(loadPreset(biome), size, TANK_DIMENSIONS[size], catalog);
      const clearance = clearanceTo(await hardColliders(biome, layer, fitted.decor));
      for (const a of caveAnchors(fitted.decor)) {
        const [x, y, z] = a.position;
        const [fx = 0, , fz = 0] = a.facing ?? [];
        for (const k of [1, 2, 3]) {
          const d = k * a.radius;
          expect(
            clearance(x + fx * d, y, z + fz * d),
            `${a.id} ${k} r along facing`,
          ).toBeGreaterThan(0);
        }
      }
    });
  });
});

describe.each(LAYERS)('a royal gramma on the reef preset with %s', (layer) => {
  it('reaches Shelter at night within the contact budget', async () => {
    const decor = await hardColliders('reef', layer);
    const cave = caveAnchors(loadPreset('reef').decor);
    let contacts = 0;
    let fishSteps = 0;
    let sheltered = 0;
    for (const seed of SEEDS) {
      const { config } = demoTank(DEFAULT_TANK, seed, 'reef');
      const world = new World({
        ...config,
        fish: config.fish.filter((f) => f.species === 'royal-gramma'),
        decor,
        anchors: sceneAnchorsToSim(cave, { config }),
        light: 1,
      });
      for (let t = 0; t < 2 * STEPS_PER_PHASE; t++) {
        if (t === STEPS_PER_PHASE) world.setLight(0);
        world.step();
        if (t >= STEPS_PER_PHASE && world.state[0] === FishState.Shelter) sheltered++;
      }
      contacts += world.contacts;
      fishSteps += world.count * 2 * STEPS_PER_PHASE;
    }
    expect(sheltered).toBeGreaterThan(0);
    expect(contacts / fishSteps).toBeLessThan(CONTACTS_PER_FISH_STEP);
  }, 120_000);
});

describe('the sim at boot', () => {
  it.each(SHELTERED)(
    '%s: the scene hulls block no cave, so the anchors are sent once',
    async (biome) => {
      const decor = loadPreset(biome).decor;
      const caves = caveAnchors(decor);
      const hulls = await hardColliders(biome, 'scene hulls');
      const spec = new SimWorldSpec(demoTank(DEFAULT_TANK, 1, biome), 1);
      const sent = spec.setAnchors(caves);
      expect(sent.filter((a) => a.kind === 'cave')).toHaveLength(caves.length);
      expect(spec.setDecor(hulls)).toBeNull();
      expect(spec.anchors).toBe(sent);
    },
  );
});
