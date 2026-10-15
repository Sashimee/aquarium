import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, DirectionalLight, MeshBasicMaterial, Scene, Texture } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { PresetLayout } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { TIER_SETTINGS } from '../engine/quality/tiers';
import { ModelLibrary } from './assets';
import { TankScene } from './TankScene';

class GatedKtx2 extends KTX2Loader {
  readonly pending: (() => void)[] = [];

  override load(_url: string, onLoad: (texture: never) => void): void {
    this.pending.push(() => onLoad(new Texture() as never));
  }

  releaseAll(): void {
    for (const release of this.pending.splice(0)) release();
  }
}

const preset: PresetLayout = {
  id: 'reef',
  name: 'Reef aquarium',
  biome: 'reef',
  substrate: { assetId: 'sand', tint: [1, 1, 1], tileMeters: 0.4 },
  decor: [],
  plantPatches: [],
};

const sandEntry = {
  id: 'sand',
  kind: 'substrate',
  lods: [],
  textures: ['baseColor', 'normal', 'occlusionRoughnessMetal'].map((role) => ({
    role,
    variants: { '1k': { file: `textures/sand_${role}_1k.ktx2` } },
  })),
};

function fakeEngine() {
  const ktx2 = new GatedKtx2();
  const placeholder = new MeshBasicMaterial();
  const hood = new DirectionalLight(0xffffff, 3);
  let water = { cdom440: 0.1, turbidity: 0.2 };
  const errors: unknown[] = [];
  const registered: string[] = [];
  const engine = {
    scene: new Scene(),
    ktx2,
    hood,
    ambientScatter: new Color(0.02, 0.03, 0.034),
    substrateAlbedo: new Color(0.13, 0.09, 0.055),
    interior: { fillLevel: 0.4, actinicExcitation: 0 },
    medium: {
      getQuality: () => water,
      setQuality: (quality: typeof water) => (water = quality),
    },
    tank: { dimensions: DEFAULT_TANK, substrate: { material: placeholder } },
    quality: {
      tier: 'medium',
      settings: TIER_SETTINGS.medium,
      register: (name: string) => {
        registered.push(name);
        return () => registered.splice(registered.indexOf(name), 1);
      },
    },
    renderer: { getMaxAnisotropy: () => 4 },
    events: { emit: (_name: string, payload: unknown) => errors.push(payload) },
    onFrame: () => () => undefined,
  };
  return {
    engine: engine as unknown as Engine,
    ktx2,
    placeholder,
    hood,
    errors,
    registered,
    water: () => water,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCatalog() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ assets: [sandEntry] })))),
  );
}

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
