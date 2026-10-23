import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import type { Biome, Collider, DecorItem, TankSize } from '@aquarium/shared';
import { createSharedKtx2 } from '../engine/ktx2';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { collidersFor } from '../interaction/decor/colliders';
import { specsFromCatalog } from '../interaction/decor/spec';
import { AssetCatalog, ModelLibrary } from '../scene/assets';
import type { Collider as SceneCollider } from '../scene/colliders';
import { fitCollider, HARDSCAPE_KINDS } from '../scene/hardscape';
import { loadPreset } from '../scene/preset';
import { fitPresetToCatalog } from '../scene/TankScene';
import { demoTank } from './demoStock';
import { sceneCollidersToSim } from './simColliders';

// The sim's preset tests run on these exports so they need neither the asset library nor three.
// Rebuilt here from the live presets; after a deliberate preset or fitting change, regenerate them
// with `pnpm vitest run apps/web/src/fish/simFixtures.test.ts -u`.
const PUBLIC = join(__dirname, '../../public');
const SIM_SRC = join(__dirname, '../../../../packages/sim/src');
const LONG = 120_000;

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

/** The hard colliders as caves.collision.test.ts builds them: scene hulls and decor colliders. */
async function hardColliders(
  decor: readonly DecorItem[],
): Promise<{ hulls: Collider[]; decor: Collider[] }> {
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
  return { hulls: sceneCollidersToSim(hulls), decor: boxes };
}

/** Every number to 1 µm, so float noise in the fitting does not churn the files. */
function rounded(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6 + 0;
  if (Array.isArray(v)) return v.map(rounded);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rounded(x)]));
  }
  return v;
}

async function preset(biome: Biome, size: TankSize, seeds: readonly number[]) {
  const dimensions = TANK_DIMENSIONS[size];
  const fitted = fitPresetToCatalog(loadPreset(biome), size, dimensions, catalog);
  const { hulls, decor } = await hardColliders(fitted.decor);
  const space = demoTank(dimensions, 1, biome).config.space;
  if (seeds.length === 0) return { space, hulls, decor };
  const fish = Object.fromEntries(
    seeds.map((s) => [s, demoTank(dimensions, s, biome).config.fish]),
  );
  return { space, hulls, decor, fish };
}

async function expectFixture(file: string, source: string, presets: Record<string, unknown>) {
  const path = join(SIM_SRC, file);
  const json = JSON.stringify(rounded({ source, presets }));
  const text = await format(json, { ...(await resolveConfig(path)), filepath: path });
  await expect(text).toMatchFileSnapshot(path);
}

describe('the sim fixtures match the live presets', () => {
  it(
    'blackwater.fixture.json',
    async () => {
      await expectFixture(
        'blackwater.fixture.json',
        'apps/web/src/fish/simFixtures.test.ts, rounded to 1 µm: fitPresetToCatalog(loadPreset("blackwater"), size), its hard colliders as scene hulls and decor colliders, and demoTank(size, seed, "blackwater").config.fish. Regenerate with `pnpm vitest run apps/web/src/fish/simFixtures.test.ts -u`.',
        {
          standard: await preset('blackwater', 'standard', [1, 2]),
          long300: await preset('blackwater', 'long300', [1, 2]),
        },
      );
    },
    LONG,
  );

  it(
    'crevices.fixture.json',
    async () => {
      await expectFixture(
        'crevices.fixture.json',
        'apps/web/src/fish/simFixtures.test.ts, rounded to 1 µm: fitPresetToCatalog(loadPreset(biome), size), its hard colliders as scene hulls and decor colliders, and demoTank(size, 1, biome).config.space. Regenerate with `pnpm vitest run apps/web/src/fish/simFixtures.test.ts -u`.',
        {
          'reef/nano30': await preset('reef', 'nano30', []),
          'reef/std200': await preset('reef', 'std200', []),
          'cichlid/nano30': await preset('cichlid', 'nano30', []),
        },
      );
    },
    LONG,
  );
});
