import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Coral, DecorItem } from '@aquarium/shared';
import { TankScene } from './TankScene';
import { fakeEngine, preset, stubCatalog } from './tankSceneHarness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Internals {
  hardItems: { item: DecorItem; kind: string }[];
  refitCoralColliders: () => Promise<void>;
}

const item: DecorItem = {
  assetId: 'brain-coral',
  position: [0, 0, 0],
  rotationY: 0,
  scale: 1,
  tintSeed: 1,
};

const colony: Coral = {
  key: 's1',
  assetId: 'brain-coral',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1,
  minSize: 0.3,
  maxSize: 2,
  fragMinSize: 1.5,
  bleach: 0,
};

async function builtScene() {
  stubCatalog();
  const h = fakeEngine();
  const building = TankScene.create(
    h.engine,
    preset,
    { colliders: false },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(h.ktx2.pending.length).toBeGreaterThan(0));
  while (h.ktx2.pending.length > 0) {
    h.ktx2.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const scene = await building;
  const internals = scene as unknown as Internals;
  internals.hardItems = [{ item, kind: 'coral' }];
  const refit = vi.spyOn(internals, 'refitCoralColliders').mockResolvedValue();
  return { scene, refit };
}

describe('TankScene coral collider refit while dragging', () => {
  it('refits once after many moves', async () => {
    const { scene, refit } = await builtScene();
    scene.setCorals([colony]);
    refit.mockClear();
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) {
      scene.moveHardDecor(0, { ...item, position: [i * 0.01, 0, 0] });
      vi.advanceTimersByTime(16);
    }
    expect(refit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(refit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await scene.dispose();
  });

  it('setCorals refits at once and drops the pending refit', async () => {
    const { scene, refit } = await builtScene();
    scene.setCorals([colony]);
    refit.mockClear();
    vi.useFakeTimers();
    scene.moveHardDecor(0, { ...item, position: [0.1, 0, 0] });
    scene.setCorals([colony]);
    expect(refit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(refit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await scene.dispose();
  });

  it('dispose drops the pending refit', async () => {
    const { scene, refit } = await builtScene();
    scene.setCorals([colony]);
    refit.mockClear();
    vi.useFakeTimers();
    scene.moveHardDecor(0, { ...item, position: [0.1, 0, 0] });
    const disposing = scene.dispose();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    await disposing;
    expect(refit).not.toHaveBeenCalled();
  });
});
