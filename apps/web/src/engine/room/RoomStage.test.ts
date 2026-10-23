import {
  BoxGeometry,
  CubeUVReflectionMapping,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  RenderTarget,
  Texture,
  type BufferGeometry,
  type Light,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { ROOM_IDS, type RoomId } from '@aquarium/shared';
import assetIndex from '../../../public/assets/index.json';
import type { PropSource } from '../../scene/room/RoomProps';
import {
  COMMUNITY_ROOM_ID,
  ROOM_HDRI_YAW,
  ROOM_TIER_POLICY,
  shellDrawCalls,
} from '../../scene/room/roomScene';
import { TIERS, type Tier } from '../quality/tiers';
import { buildShaders } from '../shaderFixtures';
import { TANK_DIMENSIONS } from '../tank/dimensions';
import { ROOM_LAMP_SLOTS, RoomLight } from './RoomLight';
import { roomAssetsFrom, RoomStage, roomTierFor, type RoomStageOptions } from './RoomStage';

const tank = TANK_DIMENSIONS.standard;
const assets = roomAssetsFrom(assetIndex);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Bake {
  readonly url: string | null;
  readonly yaw: number;
  readonly signal: AbortSignal | undefined;
}

/** Every GPU resource a test's rooms made, and whether it was freed. */
class Ledger {
  private readonly live = new Set<{ dispose(): void }>();

  track(resource: BufferGeometry | Material | Texture): void {
    if (this.live.has(resource)) return;
    this.live.add(resource);
    resource.addEventListener('dispose', () => this.live.delete(resource));
  }

  trackTree(root: Object3D): void {
    root.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (!mesh.isMesh) return;
      if (mesh.geometry) this.track(mesh.geometry);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        this.track(material);
        const map = (material as Partial<MeshStandardNodeMaterial>).map;
        if (map) this.track(map);
      }
    });
  }

  get count(): number {
    return this.live.size;
  }
}

function harness(
  options: {
    mobile?: boolean;
    source?: PropSource;
    bake?: RoomStageOptions['lighting']['bake'];
  } = {},
) {
  const ledger = new Ledger();
  const bakes: Bake[] = [];
  const loads: string[] = [];
  const source: PropSource = options.source ?? {
    load: vi.fn(async (asset: string) => {
      loads.push(asset);
      const root = new Group();
      const material = new MeshStandardNodeMaterial();
      material.name = `room-prop-${asset}`;
      material.map = new Texture();
      root.add(new Mesh(new BoxGeometry(), material));
      ledger.trackTree(root);
      return root;
    }),
  };
  const bake =
    options.bake ??
    vi.fn(async (url: string | null, yaw: number, signal?: AbortSignal) => {
      bakes.push({ url, yaw, signal });
    });
  const stage = new RoomStage({
    lighting: { bake },
    props: source,
    catalog: assets.catalog,
    hdriUrl: assets.hdriUrl,
    mobile: options.mobile ?? false,
  });
  const show = async (roomId: string | null, tier: Tier = 'high') => {
    await stage.show(roomId, tank, tier);
    ledger.trackTree(stage.group);
  };
  return { stage, ledger, bakes, loads, source, bake, show };
}

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Partial<Mesh>).isMesh) found.push(o as Mesh);
  });
  return found;
}

function lights(root: Object3D): Light[] {
  const found: Light[] = [];
  root.traverse((o) => {
    if ((o as Partial<Light>).isLight) found.push(o as Light);
  });
  return found;
}

describe('roomAssetsFrom', () => {
  it('finds every room HDRI and every prop LOD in assets/index.json', () => {
    for (const id of ROOM_IDS) {
      const url = assets.hdriUrl(id);
      expect(url, id).toMatch(/hdri\/.+_1k\.ktx2$/);
    }
    expect(assets.files('polyhaven-armchair-01', 2)).toBe(
      'room-furniture/polyhaven-armchair-01/lod2.glb',
    );
  });

  it('refuses a malformed index or an unknown prop', () => {
    expect(() => roomAssetsFrom({})).toThrow('assets should be an array');
    expect(() =>
      roomAssetsFrom({ assets: [{ id: 'x', kind: 'room-furniture', lods: [{ file: 3 }] }] }),
    ).toThrow('assets[x].lods[0].file');
    expect(() => roomAssetsFrom({ assets: [] })).toThrow('which assets/index.json lacks');
    expect(() => assets.files('no-such-prop', 0)).toThrow('Unknown room prop');
  });
});

describe('roomTierFor', () => {
  it('holds phones to the mobile room at any tier', () => {
    expect(TIERS.map((t) => roomTierFor(t, true))).toEqual(['low', 'medium', 'medium', 'medium']);
    expect(TIERS.map((t) => roomTierFor(t, false))).toEqual([...TIERS]);
  });
});

describe('RoomStage', () => {
  it('builds the shell in the draws the plan counts, with a pane only behind a window', async () => {
    for (const tier of TIERS) {
      for (const roomId of ['room-living', 'room-sushi'] as const) {
        const { stage, show } = harness({ source: { load: async () => new Group() } });
        await show(roomId, tier);
        const plan = stage.plan;
        if (!plan) throw new Error('no plan');
        const shell = meshes(stage.group).filter((m) => !m.name.startsWith('room-prop-'));
        expect(shell.length, `${roomId} ${tier}`).toBe(
          shellDrawCalls(plan.window !== null, ROOM_TIER_POLICY[tier]),
        );
        expect(stage.pane !== null, roomId).toBe(plan.window !== null);
      }
    }
  });

  it('draws the room HDRI into the PMREM with its yaw, and the default studio for no room', async () => {
    const { show, bakes } = harness();
    await show(COMMUNITY_ROOM_ID);
    expect(bakes.at(-1)).toMatchObject({
      url: assets.hdriUrl(COMMUNITY_ROOM_ID),
      yaw: ROOM_HDRI_YAW[COMMUNITY_ROOM_ID],
    });
    expect(ROOM_HDRI_YAW[COMMUNITY_ROOM_ID]).toBeCloseTo(0.145);
    await show('room-living');
    expect(bakes.at(-1)).toMatchObject({ url: assets.hdriUrl('room-living'), yaw: 0 });
    await show(null);
    expect(bakes.at(-1)).toMatchObject({ url: null, yaw: 0 });
  });

  it('keeps the HDRI when only the tier changes', async () => {
    const { stage, show, bakes, loads } = harness();
    await show('room-cabin', 'high');
    await stage.setTier('medium');
    expect(bakes).toHaveLength(1);
    expect(stage.plan?.props.every((p) => p.lod === 2)).toBe(true);
    expect(loads.length).toBeGreaterThan(0);
  });

  it('rejects an unknown room and keeps the one on show', async () => {
    const { stage, show, bakes } = harness();
    await show('room-zen');
    const before = stage.plan;
    await expect(stage.show('room-ballroom', tank, 'high')).rejects.toThrow(RangeError);
    expect(stage.plan).toBe(before);
    expect(bakes).toHaveLength(1);
  });

  it('changes nothing when shown the room it already shows or is loading', async () => {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { stage, bake, source } = harness({
      bake: vi.fn(() => gate),
    });
    const first = stage.show('room-office', tank, 'high');
    const again = stage.show('room-office', tank, 'high');
    expect(again).toBe(first);
    finish();
    await first;
    const plan = stage.plan;
    await stage.show('room-office', tank, 'high');
    expect(stage.plan).toBe(plan);
    expect(bake).toHaveBeenCalledTimes(1);
    expect(new Set(vi.mocked(source.load).mock.calls.map((c) => c[0])).size).toBe(
      vi.mocked(source.load).mock.calls.length,
    );
  });

  it('drops a room that another replaces while it loads, and frees what it loads late', async () => {
    const late: ((root: Group) => void)[] = [];
    const ledger = new Ledger();
    const slow: PropSource = {
      load: (asset) =>
        asset.includes('bar-chair') || asset.includes('round-wooden-table')
          ? new Promise<Group>((resolve) => late.push(resolve))
          : Promise.resolve(new Group()),
    };
    const { stage } = harness({ source: slow });
    const sushi = stage.show('room-sushi', tank, 'high');
    await settle();
    const zen = stage.show('room-zen', tank, 'high');
    await expect(sushi).resolves.toBeUndefined();
    await zen;
    expect(stage.plan?.roomId).toBe('room-zen');
    for (const resolve of late) {
      const root = new Group();
      root.add(new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial()));
      ledger.trackTree(root);
      resolve(root);
    }
    await settle();
    expect(late.length).toBeGreaterThan(0);
    expect(ledger.count).toBe(0);
    expect(meshes(stage.group).some((m) => m.name.includes('bar-chair'))).toBe(false);
  });

  it('aborts the HDRI of a room that another replaced', async () => {
    const signals: AbortSignal[] = [];
    const { stage } = harness({
      bake: (_url, _yaw, signal) => {
        if (signal) signals.push(signal);
        return new Promise<void>(() => undefined);
      },
    });
    void stage.show('room-cabin', tank, 'high');
    void stage.show('room-beach', tank, 'high');
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('keeps the shell when the furniture fails, and loads again when asked again', async () => {
    let fail = true;
    const { stage, ledger } = harness({
      source: {
        load: async () => {
          if (fail) throw new Error('HTTP 404 for a sofa');
          return new Group();
        },
      },
    });
    await expect(stage.show('room-living', tank, 'high')).rejects.toThrow('HTTP 404');
    expect(stage.plan?.roomId).toBe('room-living');
    expect(meshes(stage.group).length).toBeGreaterThan(0);
    expect(meshes(stage.group).every((m) => !m.name.startsWith('room-prop-'))).toBe(true);
    fail = false;
    await expect(stage.show('room-living', tank, 'high')).resolves.toBeUndefined();
    ledger.trackTree(stage.group);
  });

  it('falls back to the studio HDRI when the first room HDRI after startup fails', async () => {
    const calls: (string | null)[] = [];
    const { stage } = harness({
      bake: async (url) => {
        calls.push(url);
        if (url?.includes('cabin')) throw new Error('HTTP 500 for the cabin HDRI');
      },
    });
    await expect(stage.show('room-cabin', tank, 'high')).rejects.toThrow('HTTP 500');
    expect(calls).toEqual([assets.hdriUrl('room-cabin'), null]);
  });

  it('draws the studio again for no room after its fallback failed', async () => {
    const bakes: Bake[] = [];
    let studioFails = false;
    const { stage } = harness({
      bake: async (url, yaw, signal) => {
        bakes.push({ url, yaw, signal });
        if (url?.includes('cabin')) throw new Error('HTTP 500 for the cabin HDRI');
        if (url === null && studioFails) throw new Error('HTTP 503 for the studio HDRI');
      },
    });
    await stage.show('room-office', tank, 'high');
    studioFails = true;
    await expect(stage.show('room-cabin', tank, 'high')).rejects.toThrow('HTTP 500');
    await settle();
    expect(bakes.at(-1)?.url).toBeNull();
    studioFails = false;
    const before = bakes.length;
    await stage.show(null, tank, 'high');
    expect(bakes.slice(before)).toMatchObject([{ url: null, yaw: 0 }]);
    await stage.show(null, tank, 'high');
    expect(bakes).toHaveLength(before + 1);
  });

  it('does not draw the studio again after a fallback that worked', async () => {
    const calls: (string | null)[] = [];
    const { stage } = harness({
      bake: async (url) => {
        calls.push(url);
        if (url?.includes('cabin')) throw new Error('HTTP 500 for the cabin HDRI');
      },
    });
    await stage.show('room-office', tank, 'high');
    await expect(stage.show('room-cabin', tank, 'high')).rejects.toThrow('HTTP 500');
    await settle();
    await stage.show(null, tank, 'high');
    expect(calls).toEqual([assets.hdriUrl('room-office'), assets.hdriUrl('room-cabin'), null]);
  });

  it('loads no furniture until the HDRI is drawn, so the two never share memory', async () => {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { stage, loads } = harness({ bake: () => gate });
    const shown = stage.show('room-cabin', tank, 'high');
    await settle();
    expect(loads).toHaveLength(0);
    finish();
    await shown;
    expect(loads.length).toBeGreaterThan(0);
  });

  it('falls back to the default studio when the HDRI fails after another room was drawn', async () => {
    const calls: (string | null)[] = [];
    const { stage } = harness({
      bake: async (url) => {
        calls.push(url);
        if (url?.includes('cabin')) throw new Error('HTTP 500 for the cabin HDRI');
      },
    });
    await stage.show('room-living', tank, 'high');
    await expect(stage.show('room-cabin', tank, 'high')).rejects.toThrow('HTTP 500');
    expect(calls.at(-1)).toBeNull();
    expect(stage.plan?.roomId).toBe('room-cabin');
  });

  it('frees every room it leaves, however often the room changes', async () => {
    const { stage, ledger, show } = harness();
    const rooms: (RoomId | null)[] = [...ROOM_IDS, null, 'room-living', 'room-living'];
    for (let round = 0; round < 3; round++) {
      for (const [i, roomId] of rooms.entries()) {
        await show(roomId, TIERS[(i + round) % TIERS.length]);
      }
    }
    await show('room-living', 'high');
    const current = new Ledger();
    current.trackTree(stage.group);
    expect(current.count).toBeGreaterThan(0);
    expect(ledger.count).toBe(current.count);
    stage.dispose();
    expect(ledger.count).toBe(0);
    expect(stage.group.children.filter((c) => c.name !== 'room-props')).toHaveLength(0);
  });

  it('frees everything on dispose and refuses use after', async () => {
    const { stage, ledger, show } = harness();
    await show('room-loft', 'ultra');
    expect(ledger.count).toBeGreaterThan(0);
    stage.dispose();
    expect(ledger.count).toBe(0);
    expect(meshes(stage.group)).toHaveLength(0);
    await expect(stage.show('room-loft', tank, 'ultra')).rejects.toThrow('after dispose');
  });

  it('lights the lamps on high and ultra only, once their props are on show', async () => {
    for (const tier of TIERS) {
      const { stage, show } = harness();
      const shown = show('room-cabin', tier);
      expect(stage.rig?.practical).toHaveLength(0);
      await shown;
      const lamps = stage.rig?.practical ?? [];
      if (tier === 'high' || tier === 'ultra') expect(lamps.length, tier).toBeGreaterThan(0);
      else expect(lamps, tier).toHaveLength(0);
    }
    const phone = harness({ mobile: true });
    await phone.show('room-cabin', 'high');
    expect(phone.stage.rig?.practical).toHaveLength(0);
  });

  it('adds no scene lights in any room, so the tank never recompiles for a room change', async () => {
    const { stage, show } = harness();
    for (const tier of ['high', 'ultra'] as const) {
      for (const roomId of [...ROOM_IDS, null]) {
        await show(roomId, tier);
        expect(lights(stage.group), `${roomId} ${tier}`).toHaveLength(0);
        expect(stage.rig?.practical?.length ?? 0, `${roomId}`).toBeLessThanOrEqual(ROOM_LAMP_SLOTS);
      }
    }
  });

  it('keeps a phone within 15 k triangles and 10 draws in every room, at any tier', async () => {
    for (const tier of TIERS) {
      for (const roomId of ROOM_IDS) {
        const { stage, show } = harness({ mobile: true });
        await show(roomId, tier);
        expect(stage.plan?.triangles ?? 0, `${roomId} ${tier}`).toBeLessThanOrEqual(15_000);
        expect(stage.plan?.drawCalls ?? 0, `${roomId} ${tier}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it('trims the cabin oil lamp and the office laptop on a phone', async () => {
    const cabin = harness({ mobile: true });
    await cabin.show('room-cabin', 'ultra');
    expect(cabin.stage.plan?.dropped).toContain('polyhaven-vintage-oil-lamp');
    const office = harness({ mobile: true });
    await office.show('room-office', 'ultra');
    expect(office.stage.plan?.dropped.some((id) => id.includes('laptop'))).toBe(true);
  });

  it('shows no room and lights the default studio for null', async () => {
    const { stage, show } = harness();
    await show('room-beach');
    await show(null);
    expect(stage.plan).toBeNull();
    expect(stage.layout).toBeNull();
    expect(meshes(stage.group)).toHaveLength(0);
  });
});

describe('RoomStage with RoomLight', () => {
  function environment() {
    const texture = new RenderTarget(64, 64).texture;
    texture.mapping = CubeUVReflectionMapping;
    return texture;
  }
  const NOON = { nowMs: Date.UTC(2026, 9, 19, 12), minute: 13 * 60, hood: 1 };

  function dressed(root: Object3D): MeshStandardNodeMaterial[] {
    const found = new Set<MeshStandardNodeMaterial>();
    root.traverse((object) => {
      const material = (object as Partial<Mesh>).material;
      if (material instanceof MeshStandardNodeMaterial && material.name.startsWith('room-')) {
        found.add(material);
      }
    });
    return [...found];
  }

  it('lights a room without a window, and the furniture once it has loaded', async () => {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { stage } = harness({
      source: {
        load: async (asset) => {
          await gate;
          const material = new MeshStandardNodeMaterial();
          material.name = `room-prop-${asset}`;
          const root = new Group();
          root.add(new Mesh(new BoxGeometry(), material));
          return root;
        },
      },
    });
    const light = new RoomLight({ environment: environment(), tier: 'high', seed: 3 });
    light.attach(stage);
    const shown = stage.show('room-sushi', tank, 'high');
    light.update(NOON);
    expect(stage.pane).toBeNull();
    const shell = dressed(stage.group);
    expect(shell.length).toBeGreaterThan(0);
    for (const material of shell) expect(material.envNode, material.name).not.toBeNull();
    finish();
    await shown;
    light.update(NOON);
    const all = dressed(stage.group);
    expect(all.some((m) => m.name.startsWith('room-prop-'))).toBe(true);
    for (const material of all) {
      expect(material.envNode, material.name).not.toBeNull();
      expect(material.emissiveNode, material.name).not.toBeNull();
    }
  });

  it('paints the window of a room that has one', async () => {
    const { stage, show } = harness();
    const light = new RoomLight({ environment: environment(), tier: 'medium', seed: 3 });
    light.attach(stage);
    await show('room-living', 'medium');
    light.update(NOON);
    const pane = stage.pane?.material;
    expect(pane).toBeInstanceOf(MeshBasicNodeMaterial);
    expect((pane as MeshBasicNodeMaterial).colorNode).not.toBeNull();
  });

  it('lights the lamps through uniforms, keeping the shaders it built', async () => {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { stage, show } = harness({
      source: {
        load: async (asset) => {
          if (asset.includes('lamp')) await gate;
          return new Group();
        },
      },
    });
    const light = new RoomLight({ environment: environment(), tier: 'high', seed: 3 });
    light.attach(stage);
    await show('room-living', 'high');
    light.update(NOON);
    expect(light.litLamps).toBe(0);
    const shown = stage.show('room-cabin', tank, 'high');
    light.update(NOON);
    const floor = meshes(stage.group).find((m) => m.name === 'room-floor');
    const material = floor?.material as MeshStandardNodeMaterial;
    const node = material.emissiveNode;
    const version = material.version;
    expect(light.litLamps).toBe(0);
    finish();
    await shown;
    light.update(NOON);
    expect(light.litLamps).toBe(stage.rig?.practical?.length);
    expect(light.litLamps).toBeGreaterThan(0);
    expect(material.emissiveNode).toBe(node);
    expect(material.version).toBe(version);
    await show('room-living', 'high');
    light.update(NOON);
    expect(light.litLamps).toBe(0);
  });

  it('builds WGSL and GLSL for the lit shell, contact shadow included, on every tier', async () => {
    for (const tier of TIERS) {
      const { stage, show } = harness({ source: { load: async () => new Group() } });
      const light = new RoomLight({ environment: environment(), tier, seed: 3 });
      light.attach(stage);
      await show('room-living', tier);
      light.update(NOON);
      const floor = meshes(stage.group).find((m) => m.name === 'room-floor');
      if (!floor) throw new Error('no floor');
      for (const backend of ['webgpu', 'webgl'] as const) {
        const { fragment } = buildShaders(floor, backend);
        expect(fragment.length, `${tier} ${backend}`).toBeGreaterThan(0);
      }
    }
  });
});
