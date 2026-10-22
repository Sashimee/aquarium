import { vi } from 'vitest';
import { Color, DirectionalLight, MeshBasicMaterial, Scene, Texture } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { PresetLayout } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { TIER_SETTINGS } from '../engine/quality/tiers';

export class GatedKtx2 extends KTX2Loader {
  readonly pending: (() => void)[] = [];

  override load(_url: string, onLoad: (texture: never) => void): void {
    this.pending.push(() => onLoad(new Texture() as never));
  }

  releaseAll(): void {
    for (const release of this.pending.splice(0)) release();
  }
}

export const preset: PresetLayout = {
  id: 'reef',
  name: 'Reef aquarium',
  biome: 'reef',
  substrate: { assetId: 'sand', tint: [1, 1, 1], tileMeters: 0.4 },
  decor: [],
  plantPatches: [],
};

export const sandEntry = {
  id: 'sand',
  kind: 'substrate',
  lods: [],
  textures: ['baseColor', 'normal', 'occlusionRoughnessMetal'].map((role) => ({
    role,
    variants: { '1k': { file: `textures/sand_${role}_1k.ktx2` } },
  })),
};

export function fakeEngine() {
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

export function stubCatalog() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ assets: [sandEntry] })))),
  );
}
