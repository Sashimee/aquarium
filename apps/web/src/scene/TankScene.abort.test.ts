import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PresetLayout } from '@aquarium/shared';
import { ModelLibrary } from './assets';
import { TankScene } from './TankScene';
import { fakeEngine, preset, stubCatalog } from './tankSceneHarness';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TankScene.create abort', () => {
  it('completes when not aborted, which is what the abort test must prevent', async () => {
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
    expect(h.engine.tank.substrate.material).not.toBe(h.placeholder);
    expect(h.hood.intensity).not.toBe(3);
    expect(h.engine.scene.children.length).toBeGreaterThan(0);
    await scene.dispose();
    expect(h.engine.tank.substrate.material).toBe(h.placeholder);
    expect(h.hood.intensity).toBe(3);
    expect(h.engine.scene.children).toHaveLength(0);
  });

  it('leaves no substrate, lighting or scene objects behind when aborted mid-build', async () => {
    stubCatalog();
    const h = fakeEngine();
    const controller = new AbortController();
    const building = TankScene.create(h.engine, preset, { colliders: false }, controller.signal);
    const outcome = building.then(
      () => 'built',
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(h.ktx2.pending.length).toBeGreaterThan(0));
    controller.abort();

    for (let i = 0; i < 10; i++) {
      h.ktx2.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await outcome).toBe(controller.signal.reason);

    expect(h.engine.tank.substrate.material).toBe(h.placeholder);
    expect(h.hood.intensity).toBe(3);
    expect(h.hood.color.getHex()).toBe(0xffffff);
    expect(h.water()).toEqual({ cdom440: 0.1, turbidity: 0.2 });
    expect(h.engine.interior.fillLevel).toBe(0.4);
    expect(h.engine.scene.children).toHaveLength(0);
    expect(h.registered).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('disposes the model library exactly once when aborted', async () => {
    const dispose = vi.spyOn(ModelLibrary.prototype, 'dispose');
    stubCatalog();
    const h = fakeEngine();
    const controller = new AbortController();
    const outcome = TankScene.create(
      h.engine,
      preset,
      { colliders: false },
      controller.signal,
    ).catch(() => undefined);
    await vi.waitFor(() => expect(h.ktx2.pending.length).toBeGreaterThan(0));
    controller.abort();
    for (let i = 0; i < 10; i++) {
      h.ktx2.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await outcome;
    expect(dispose).toHaveBeenCalledTimes(1);
    dispose.mockRestore();
  });

  it('disposes the model library exactly once when the build fails', async () => {
    const dispose = vi.spyOn(ModelLibrary.prototype, 'dispose');
    stubCatalog();
    const h = fakeEngine();
    const failing: PresetLayout = {
      ...preset,
      plantPatches: [
        {
          id: 'bad',
          assetId: 'sand',
          center: [0, 0],
          radius: 0.1,
          count: 1,
          scale: [1, 1],
          seed: 1,
        },
      ],
    };
    await expect(TankScene.create(h.engine, failing, { colliders: false })).rejects.toThrow(
      'not a plant',
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    dispose.mockRestore();
  });

  it('rejects before touching the engine when aborted before the catalog arrives', async () => {
    stubCatalog();
    const h = fakeEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      TankScene.create(h.engine, preset, { colliders: false }, controller.signal),
    ).rejects.toBe(controller.signal.reason);
    expect(h.engine.scene.children).toHaveLength(0);
    expect(h.ktx2.pending).toHaveLength(0);
  });
});
