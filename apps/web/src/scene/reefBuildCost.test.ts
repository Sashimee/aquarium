import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, MeshStandardMaterial, SphereGeometry } from 'three/webgpu';
import { TIER_SETTINGS, type Tier, type TierSettings } from '../engine/quality/tiers';
import { ModelLibrary, type LoadedModel } from './assets';
import { loadPreset } from './preset';
import { TankScene } from './TankScene';
import { fakeEngine } from './tankSceneHarness';

/**
 * No single synchronous piece of the reef mount may hold the main thread longer than this. On
 * CI's software renderer every frame already costs far more than in Node, so a long task here
 * starves `requestAnimationFrame` there. Measured in Node: about 40 ms now, 410-530 ms when the
 * build ran as one task with an eagerly drawn collider overlay.
 */
const LONGEST_TASK_MS = 120;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function stubReefLibrary(onLoad: (count: number) => void = () => undefined) {
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
  vi.spyOn(ModelLibrary.prototype, 'collisionGeometry').mockImplementation(() =>
    Promise.resolve([new SphereGeometry(0.1, 8, 8)]),
  );
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

async function longestBlock(run: () => Promise<unknown>): Promise<number> {
  let longest = 0;
  let last = performance.now();
  let running = true;
  const beat = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(beat);
  };
  setImmediate(beat);
  await run();
  running = false;
  return longest;
}

describe('reef mount', () => {
  it('never holds the main thread for one long task', async () => {
    await stubReefLibrary();
    const h = reefEngine();
    const worst = await longestBlock(async () => {
      const scene = await TankScene.create(h.engine, loadPreset('reef'), { colliders: false });
      await scene.dispose();
    });
    h.stop();
    expect(worst).toBeLessThan(LONGEST_TASK_MS);
  });

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
