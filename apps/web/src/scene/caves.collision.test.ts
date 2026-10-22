import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import type { Biome, Collider } from '@aquarium/shared';
import { compileCollider, FishState, World } from '@aquarium/sim';
import { createSharedKtx2 } from '../engine/ktx2';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank, sceneAnchorsToSim } from '../fish/demoStock';
import { AssetCatalog, ModelLibrary } from './assets';
import { caveAnchors } from './caves';
import { sceneCollidersToSim } from '../fish/simColliders';
import { collidersFor } from '../interaction/decor/colliders';
import { specsFromCatalog } from '../interaction/decor/spec';
import type { Collider as SceneCollider } from './colliders';
import { fitCollider, HARDSCAPE_KINDS } from './hardscape';
import { loadPreset } from './preset';

const PUBLIC = join(__dirname, '../../public');
const SHELTERED: readonly Biome[] = ['reef', 'cichlid'];
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

type Layer = 'scene hulls' | 'decor boxes';
const LAYERS: readonly Layer[] = ['scene hulls', 'decor boxes'];

/**
 * The hard colliders for a preset's rocks and shells: the scene's own fitted hulls, and the
 * rounded boxes the decor layer reports to the sim once it mounts, which replace them at runtime.
 */
async function hardColliders(biome: Biome, layer: Layer): Promise<Collider[]> {
  const specs = specsFromCatalog(catalog.entries());
  const boxes: Collider[] = [];
  const hulls: SceneCollider[] = [];
  for (const [i, item] of loadPreset(biome).decor.entries()) {
    if (!catalog.has(item.assetId)) continue;
    const kind = catalog.get(item.assetId).kind;
    if (!HARDSCAPE_KINDS.has(kind)) continue;
    const spec = specs.get(item.assetId);
    if (spec) boxes.push(...collidersFor(`piece-${i}`, spec, item));
    hulls.push(...fitCollider(kind, await library.collisionGeometry(item.assetId), item));
  }
  return layer === 'decor boxes' ? boxes : sceneCollidersToSim(hulls);
}

function clearanceTo(colliders: readonly Collider[]) {
  const solids = colliders.filter((c) => c.hard).map(compileCollider);
  const normal = new Float64Array(3);
  return (x: number, y: number, z: number): number =>
    Math.min(...solids.map((p) => p.sample(x, y, z, normal)));
}

// Not run against the scene's own single hull per piece: it fills the cave, and the decor layer
// replaces it on mount. The sim does not reject an anchor inside a collider, so the mouths are
// only judged against the layer that stays.
describe('cave anchors against the decor layer colliders fish actually meet', () => {
  it.each(SHELTERED)(
    '%s: every anchor is outside every collider, with room for a fish',
    async (b) => {
      const clearance = clearanceTo(await hardColliders(b, 'decor boxes'));
      const anchors = caveAnchors(loadPreset(b).decor);
      expect(anchors.length).toBeGreaterThan(0);
      for (const a of anchors) {
        const [x, y, z] = a.position;
        const [fx = 0, , fz = 0] = a.facing ?? [];
        expect(clearance(x, y, z), a.id).toBeGreaterThanOrEqual(0.9 * a.radius);
        expect(
          clearance(x + fx * 0.015, y, z + fz * 0.015),
          `${a.id} out along facing`,
        ).toBeGreaterThan(0);
      }
    },
  );
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
