import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Coral, DecorItem } from '@aquarium/shared';
import { Color, DirectionalLight, MeshBasicMaterial, Scene, Texture } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { PresetLayout } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { TIER_SETTINGS } from '../engine/quality/tiers';
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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ assets: [sandEntry] })))),
  );
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
    vi.useRealTimers();
    await disposing;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refit).not.toHaveBeenCalled();
  });
});
