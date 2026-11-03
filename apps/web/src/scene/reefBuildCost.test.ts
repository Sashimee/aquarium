import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, MeshStandardMaterial, SphereGeometry } from 'three/webgpu';
import { TIER_SETTINGS, type Tier, type TierSettings } from '../engine/quality/tiers';
import { ModelLibrary, type LoadedModel } from './assets';
import { ColliderField } from './colliders';
import { loadPreset } from './preset';
import { TankScene } from './TankScene';
import { fakeEngine } from './tankSceneHarness';

const slices = vi.hoisted(() => ({
  onYield: (): void => undefined,
  onEuphylliaGenerated: (): void => undefined,
}));

vi.mock('./euphyllia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./euphyllia')>();
  return {
    ...actual,
    generateEuphyllia: (...args: Parameters<typeof actual.generateEuphyllia>) => {
      slices.onEuphylliaGenerated();
      return actual.generateEuphyllia(...args);
    },
  };
});

vi.mock('./yieldTask', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./yieldTask')>();
  return {
    yieldTask: () => {
      return actual.yieldTask().then(() => slices.onYield());
    },
  };
});

/**
 * Each slice of the mount may load at most one model and generate at most one euphyllia between
 * two yields, and the patch scatter (the heaviest pure-CPU step, seen through its collider
 * queries) gets a slice of its own. Wall-clock spans flaked on loaded CI runners, so the
 * guarantee is asserted on the slicing instead. The layout fit counts too: the colonies are
 * generated one per slice ahead of it, and the fit and the build reuse them. The reef preset
 * guards the hardscape and euphyllia loops (it has one plant asset, no anemones and no plant patches); the freshwater
 * preset guards the patch scatter. The plant and anemone loops are not covered.
 */
const MAX_LOADS_PER_SLICE = 1;
const MAX_EUPHYLLIAS_PER_SLICE = 1;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function stubReefLibrary(
  onLoad: (count: number) => void = () => undefined,
  onCollision: () => void = () => undefined,
) {
  const index = await readFile(join(__dirname, '../../public/assets/index.json'), 'utf8');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(index))),
  );
  const catalog = JSON.parse(index) as {
    assets: { id: string; lods: { triangles?: number }[] }[];
  };
  const model = (assetId: string, lod: number): LoadedModel => {
    const lods = catalog.assets.find((a) => a.id === assetId)?.lods ?? [];
    const triangles = lods[Math.min(lod, lods.length - 1)]?.triangles ?? 200;
    const segments = Math.max(3, Math.round(Math.sqrt(triangles / 2)));
    const geometry = new SphereGeometry(0.1, segments, segments);
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('_sway', new BufferAttribute(new Float32Array(count), 1));
    return { primitives: [{ geometry, material: new MeshStandardMaterial() }] };
  };
  let loads = 0;
  vi.spyOn(ModelLibrary.prototype, 'load').mockImplementation((id, lod) => {
    onLoad(++loads);
    return Promise.resolve(model(id, lod));
  });
  vi.spyOn(ModelLibrary.prototype, 'collisionGeometry').mockImplementation(() => {
    onCollision();
    return Promise.resolve([new SphereGeometry(0.1, 8, 8)]);
  });
}

function reefEngine() {
  const h = fakeEngine();
  let applyTier: ((settings: Readonly<TierSettings>, tier: Tier) => void) | undefined;
  const register = h.engine.quality.register.bind(h.engine.quality);
  h.engine.quality.register = (name, apply) => {
    applyTier = apply;
    return register(name, apply);
  };
  const pump = setInterval(() => h.ktx2.releaseAll(), 0);
  return {
    ...h,
    switchTier: (tier: Tier) => applyTier?.(TIER_SETTINGS[tier], tier),
    stop: () => clearInterval(pump),
  };
}

describe('reef mount', () => {
  it.each([
    { biome: 'reef', euphyllias: true },
    { biome: 'freshwater', euphyllias: false },
  ] as const)(
    '$biome mount never holds the main thread for one long task',
    async ({ biome, euphyllias }) => {
      const slice = { loads: 0, euphyllias: 0, scatter: 0, collisions: 0 };
      const largest = { loads: 0, euphyllias: 0 };
      const total = { yields: 0, loads: 0, euphyllias: 0, scatter: 0 };
      let scatterMixedWithOtherWork = false;
      const close = () => {
        largest.loads = Math.max(largest.loads, slice.loads);
        largest.euphyllias = Math.max(largest.euphyllias, slice.euphyllias);
        if (
          slice.scatter > 0 &&
          (slice.loads > 0 || slice.euphyllias > 0 || slice.collisions > 0)
        ) {
          scatterMixedWithOtherWork = true;
        }
        slice.loads = slice.euphyllias = slice.scatter = slice.collisions = 0;
      };
      slices.onYield = () => {
        total.yields++;
        close();
      };
      slices.onEuphylliaGenerated = () => {
        total.euphyllias++;
        slice.euphyllias++;
      };
      const realHard = ColliderField.prototype.hard;
      vi.spyOn(ColliderField.prototype, 'hard').mockImplementation(function (
        this: ColliderField,
        ...args
      ) {
        total.scatter++;
        slice.scatter++;
        return realHard.apply(this, args);
      });
      await stubReefLibrary(
        () => {
          total.loads++;
          slice.loads++;
        },
        () => {
          slice.collisions++;
        },
      );
      const h = reefEngine();
      const scene = await TankScene.create(h.engine, loadPreset(biome), { colliders: false });
      close();
      await scene.dispose();
      h.stop();
      slices.onYield = () => undefined;
      slices.onEuphylliaGenerated = () => undefined;
      expect(total.loads).toBeGreaterThan(5);
      expect(total.euphyllias > 0).toBe(euphyllias);
      expect(total.scatter > 0).toBe(biome !== 'reef');
      expect(total.yields).toBeGreaterThanOrEqual(total.loads);
      expect(largest.loads).toBeLessThanOrEqual(MAX_LOADS_PER_SLICE);
      expect(largest.euphyllias).toBeLessThanOrEqual(MAX_EUPHYLLIAS_PER_SLICE);
      expect(scatterMixedWithOtherWork).toBe(false);
    },
  );

  it('frees everything when aborted part-way through the chunked build', async () => {
    const controller = new AbortController();
    await stubReefLibrary((count) => {
      if (count === 3) controller.abort();
    });
    const dispose = vi.spyOn(ModelLibrary.prototype, 'dispose');
    const h = reefEngine();
    const outcome = TankScene.create(
      h.engine,
      loadPreset('reef'),
      { colliders: false },
      controller.signal,
    ).then(
      () => 'built',
      (error: unknown) => error,
    );
    expect(await outcome).toBe(controller.signal.reason);
    h.stop();
    expect(h.engine.scene.children).toHaveLength(0);
    expect(h.registered).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('frees a tier rebuild that a dispose interrupts', async () => {
    await stubReefLibrary();
    const h = reefEngine();
    const scene = await TankScene.create(h.engine, loadPreset('reef'), { colliders: false });
    expect(h.engine.scene.children.length).toBeGreaterThan(0);

    h.switchTier('ultra');
    await scene.dispose();
    await scene.settled();
    h.stop();

    expect(h.engine.scene.children).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it('keeps one set of models when a newer tier supersedes a chunked rebuild', async () => {
    await stubReefLibrary();
    const h = reefEngine();
    const scene = await TankScene.create(h.engine, loadPreset('reef'), { colliders: false });
    const mounted = h.engine.scene.children.length;

    h.switchTier('ultra');
    h.switchTier('medium');
    await scene.settled();
    h.stop();

    expect(h.engine.scene.children).toHaveLength(mounted);
    expect(h.errors).toEqual([]);
    await scene.dispose();
    expect(h.engine.scene.children).toHaveLength(0);
  });
});
