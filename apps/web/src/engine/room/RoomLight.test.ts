import {
  CubeUVReflectionMapping,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  OperatorNode,
  PlaneGeometry,
  RenderTarget,
  UniformNode,
  type Node,
} from 'three/webgpu';
import { diffuseContribution, normalWorld, positionWorld } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import type { Bounds, WindowSlot } from '../../scene/room/layout';
import type { PracticalLight } from '../../scene/room/roomScene';
import { TANK_DIMENSIONS } from '../tank/dimensions';
import { TIERS, type Tier } from '../quality/tiers';
import { reversedSmoothsteps } from '../reversedSmoothsteps';
import { buildShaders, evaluate } from '../shaderFixtures';
import {
  RAIN_RATES,
  ROOM_LAMP_SLOTS,
  ROOM_LIGHT_DETAIL,
  RoomLight,
  roomLamps,
  tankGlow,
  windowMotion,
  windowMotionAt,
  type LitRoom,
  type LitRoomLayout,
  type PatternMotion,
  type RoomLightInput,
  type RoomRig,
  type WindowMotion,
} from './RoomLight';
import { roomLightAt } from './timeOfDay';

const tank = TANK_DIMENSIONS.standard;
const NOON: RoomLightInput = { nowMs: Date.UTC(2026, 9, 19, 12), minute: 13 * 60, hood: 1 };

const SHELL: Bounds = { min: [-2.5, -0.75, -0.8], max: [2.5, 1.85, 2.5] };
const TANK: Bounds = {
  min: [-tank.length / 2, 0, -tank.depth / 2],
  max: [tank.length / 2, tank.height, tank.depth / 2],
};
const WINDOW: WindowSlot = {
  id: 'window-main',
  centre: [1.4, 0.9, -0.8],
  size: [1, 1.2],
  paneZ: -0.82,
};
const SURFACES = ['room-wall-back', 'room-floor', 'room-shelf'];

function environment() {
  const texture = new RenderTarget(64, 64).texture;
  texture.mapping = CubeUVReflectionMapping;
  return texture;
}

/** A room as RoomLight sees it: named room surfaces, a window pane, a layout and a rig. */
class TestRoom implements LitRoom {
  readonly group = new Group();
  pane: Mesh | null = null;
  layout: LitRoomLayout | null = null;
  rig: RoomRig | null = null;
  revision = 0;

  constructor(options: { window?: boolean; rig?: RoomRig | null } = {}) {
    this.build(options);
  }

  /** Builds the room afresh, with new meshes, materials and layout, as a room change does. */
  build({ window = true, rig = null }: { window?: boolean; rig?: RoomRig | null } = {}): void {
    this.clear();
    for (const name of SURFACES) {
      const material = new MeshStandardNodeMaterial();
      material.name = name;
      const mesh = new Mesh(new PlaneGeometry(), material);
      mesh.name = name;
      this.group.add(mesh);
    }
    if (window) {
      const sky = new MeshBasicNodeMaterial();
      sky.name = 'room-window-pane';
      this.pane = new Mesh(new PlaneGeometry(...WINDOW.size), sky);
      this.group.add(this.pane);
    }
    this.layout = { shell: SHELL, tank: TANK, window: window ? WINDOW : null };
    this.rig = rig;
  }

  clear(): void {
    this.group.clear();
    this.pane = null;
    this.layout = null;
  }

  surface(name: string): Mesh {
    const mesh = this.group.getObjectByName(name);
    if (!(mesh instanceof Mesh)) throw new Error(`no ${name}`);
    return mesh;
  }
}

function standardMaterials(room: TestRoom): MeshStandardNodeMaterial[] {
  const found = new Set<MeshStandardNodeMaterial>();
  room.group.traverse((object) => {
    const material = (object as Partial<Mesh>).material;
    if (material instanceof MeshStandardNodeMaterial) found.add(material);
  });
  return [...found];
}

function paneMaterial(room: TestRoom): MeshBasicNodeMaterial {
  const material = room.pane?.material;
  if (!(material instanceof MeshBasicNodeMaterial)) throw new Error('no pane material');
  return material;
}

function lit(tier: Tier, room = new TestRoom()) {
  const light = new RoomLight({ environment: environment(), tier, seed: 12 });
  light.attach(room);
  light.update(NOON);
  return { light, room };
}

describe('RoomLight', () => {
  it('paints the window and lights every room material', () => {
    const { room } = lit('high');
    expect(paneMaterial(room).colorNode).not.toBeNull();
    const materials = standardMaterials(room);
    expect(materials.map((m) => m.name)).toEqual(SURFACES);
    for (const material of materials) {
      expect(material.envNode).not.toBeNull();
      expect(material.emissiveNode).not.toBeNull();
    }
  });

  it('keeps the low tier to the sky and the ambient: no sun patch or tank glow', () => {
    const { room } = lit('low');
    expect(paneMaterial(room).colorNode).not.toBeNull();
    for (const material of standardMaterials(room)) {
      expect(material.envNode).not.toBeNull();
      expect(material.emissiveNode).toBeNull();
    }
  });

  it('scales the window detail with the tier', () => {
    const cost = (tier: Tier) => {
      const d = ROOM_LIGHT_DETAIL[tier];
      return d.cloudOctaves + d.rainLayers + Number(d.drops) + Number(d.roomGlow);
    };
    for (let i = 1; i < TIERS.length; i++) {
      const lower = TIERS[i - 1];
      const higher = TIERS[i];
      if (!lower || !higher) throw new Error('tier list');
      expect(cost(higher)).toBeGreaterThan(cost(lower));
    }
    expect(ROOM_LIGHT_DETAIL.low).toEqual({
      cloudOctaves: 0,
      rainLayers: 0,
      drops: false,
      roomGlow: false,
    });
  });

  it('grows the window shader with the tier, keeping low to a gradient', () => {
    const size = (tier: Tier) => {
      const pane = lit(tier).room.pane;
      if (!pane) throw new Error('no pane');
      return buildShaders(pane, 'webgpu').fragment.length;
    };
    const sizes = TIERS.map(size);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1] ?? Infinity);
    }
    const low = lit('low').room.pane;
    if (!low) throw new Error('no pane');
    expect(buildShaders(low, 'webgpu').fragment).not.toMatch(/mx_|noise/i);
  });

  it('builds WGSL and GLSL for the window and the room on every tier', () => {
    for (const tier of TIERS) {
      const { room } = lit(tier);
      const pane = room.pane;
      if (!pane) throw new Error('no pane');
      const wall = room.group.getObjectByName('room-wall-back');
      if (!(wall instanceof Mesh)) throw new Error('no back wall');
      for (const backend of ['webgpu', 'webgl'] as const) {
        expect(buildShaders(pane, backend).fragment.length).toBeGreaterThan(0);
        const lit = buildShaders(wall, backend, [new DirectionalLight()]).fragment;
        expect(lit).toContain('getUV');
      }
      expect(reversedSmoothsteps(paneMaterial(room).colorNode)).toEqual([]);
      const emissive = (wall.material as MeshStandardNodeMaterial).emissiveNode as Node | null;
      expect(reversedSmoothsteps(emissive)).toEqual([]);
    }
  });

  it('dresses the room again after it rebuilds, and the new tier on a tier change', () => {
    const { light, room } = lit('low');
    room.build();
    light.setTier('high');
    light.update(NOON);
    expect(paneMaterial(room).colorNode).not.toBeNull();
    for (const material of standardMaterials(room)) {
      expect(material.emissiveNode).not.toBeNull();
    }
    light.setTier('low');
    for (const material of standardMaterials(room)) expect(material.envNode).toBeNull();
    light.update(NOON);
    for (const material of standardMaterials(room)) {
      expect(material.envNode).not.toBeNull();
      expect(material.emissiveNode).toBeNull();
    }
  });

  it('copes with no room, and lets go of a room that leaves', () => {
    const light = new RoomLight({ environment: environment(), tier: 'high', seed: 1 });
    expect(() => light.update(NOON)).not.toThrow();
    const room = new TestRoom();
    light.attach(room);
    light.update(NOON);
    const pane = paneMaterial(room);
    room.clear();
    light.update(NOON);
    expect(pane.colorNode).toBeNull();
    light.attach(null);
    expect(() => light.update(NOON)).not.toThrow();
  });

  it('applies the time of day and the weather for its seed', () => {
    const { light } = lit('high');
    const state = light.update({ ...NOON, minute: 0 });
    expect(light.weather).not.toBeNull();
    const weather = light.weather;
    if (!weather) throw new Error('no weather');
    expect(state).toEqual(roomLightAt(0, weather));
    expect(state.sunRadiance).toEqual([0, 0, 0]);
  });

  it('is deterministic for a time and seed', () => {
    const a = lit('high').light;
    const b = lit('high').light;
    for (let h = 0; h < 48; h += 5) {
      const input = { nowMs: NOON.nowMs + h * 3_600_000, minute: (h % 24) * 60, hood: 0.5 };
      expect(a.update(input)).toEqual(b.update(input));
    }
  });

  it('lets the tank lamp outshine the room at night', () => {
    const night = roomLightAt(0);
    const lamp = tankGlow(1);
    const room = Math.max(...night.ambient);
    expect(Math.max(lamp.r, lamp.g, lamp.b) / Math.PI).toBeGreaterThan(5 * room);
    const moon = tankGlow(0);
    expect(moon.b).toBeGreaterThan(moon.r);
    expect(moon.b).toBeLessThan(lamp.b);
    expect(tankGlow(4)).toEqual(lamp);
  });

  it('puts the room back as it was built on dispose, and refuses use after', () => {
    const { light, room } = lit('ultra');
    light.dispose();
    expect(paneMaterial(room).colorNode).toBeNull();
    for (const material of standardMaterials(room)) {
      expect(material.envNode).toBeNull();
      expect(material.emissiveNode).toBeNull();
    }
    expect(() => light.dispose()).not.toThrow();
    expect(() => light.update(NOON)).toThrow(/after dispose/);
    expect(() => light.attach(room)).toThrow(/after dispose/);
    expect(() => light.setTier('low')).toThrow(/after dispose/);
  });

  it('rejects a seed or hood level it cannot use', () => {
    expect(() => new RoomLight({ environment: environment(), tier: 'low', seed: 0.5 })).toThrow(
      RangeError,
    );
    const { light } = lit('low');
    expect(() => light.update({ ...NOON, hood: Number.NaN })).toThrow(/hood/);
  });

  it('reuses the light it computed until the clock moves by a few seconds', () => {
    const { light } = lit('high');
    const first = light.update(NOON);
    expect(light.update({ ...NOON, nowMs: NOON.nowMs + 1_000, minute: NOON.minute + 1 / 60 })).toBe(
      first,
    );
    const moved = light.update({
      ...NOON,
      nowMs: NOON.nowMs + 10_000,
      minute: NOON.minute + 1 / 6,
    });
    expect(moved).not.toBe(first);
    expect(light.update({ ...NOON, minute: NOON.minute - 1 })).not.toBe(moved);
  });

  it('holds the light while ?clock= pins the minute and real time runs on', () => {
    const { light } = lit('high');
    const pinned = light.update(NOON);
    for (const ms of [10_000, 3_600_000, 4 * 3_600_000]) {
      expect(light.update({ ...NOON, nowMs: NOON.nowMs + ms })).toBe(pinned);
    }
  });

  it('writes each cross-fade copy into the window uniforms that copy reads', () => {
    const nowMs = NOON.nowMs + 1_290_000;
    const { light, room } = lit('ultra');
    light.update({ ...NOON, nowMs });
    const graph = paneMaterial(room).colorNode;
    if (!graph) throw new Error('no sky');
    const expected = windowMotionAt(nowMs, 12, windowMotion());

    const uniformValues = (node: Node): number[] => {
      const found: number[] = [];
      node.traverse((child) => {
        if (child instanceof UniformNode && typeof child.value === 'number')
          found.push(child.value);
      });
      return found;
    };

    for (const pattern of ['clouds', 'beads'] as const) {
      const p = expected[pattern];
      const values = [p.offsetA, p.offsetB, p.layerA, p.layerB, p.gainA, p.gainB];
      expect(new Set(values).size).toBe(values.length);
      for (const [gain, own, other] of [
        [p.gainA, [p.offsetA, p.layerA], [p.offsetB, p.layerB, p.gainB]],
        [p.gainB, [p.offsetB, p.layerB], [p.offsetA, p.layerA, p.gainA]],
      ] as const) {
        const weighted: Node[] = [];
        graph.traverse((node) => {
          if (
            node instanceof OperatorNode &&
            node.op === '*' &&
            node.bNode instanceof UniformNode &&
            node.bNode.value === gain
          ) {
            weighted.push(node.aNode);
          }
        });
        expect(weighted.length).toBeGreaterThan(0);
        for (const copy of weighted) {
          const read = uniformValues(copy);
          for (const v of own) expect(read).toContain(v);
          for (const v of other) expect(read).not.toContain(v);
        }
      }
    }
  });
});

describe('room lamps', () => {
  const lamp = (asset: string, position: PracticalLight['position']): PracticalLight => ({
    asset,
    position,
    color: '#ff8040',
    intensity: 2,
    distance: 3,
  });
  /** '#ff8040' decoded from sRGB to linear, as three's ColorManagement does for a hex colour. */
  const LAMP_LINEAR = [1, 0.21586050011389926, 0.05126945837404324];
  const ALBEDO = [0.6, 0.5, 0.4];
  const DARK: RoomRig = {
    key: { color: '#000000', intensity: 0, position: [0, 0, 0] },
    ambient: { color: '#ffffff', intensity: 1 },
  };
  const LAMP_AT: PracticalLight['position'] = [0.3, 1.2, 0.1];
  const ROOM_OFFSET = [0.5, 0, -0.25];
  const LAMP_WORLD = LAMP_AT.map((x, i) => x + (ROOM_OFFSET[i] ?? 0));

  /** three's PointLightNode with decay 2 and a cut-off (`getDistanceAttenuation`), into Lambert. */
  function pointLight(distance: number, cosine: number): number[] {
    const cutoff = Math.min(1, Math.max(0, 1 - (distance / 3) ** 4)) ** 2;
    const falloff = cutoff / Math.max(distance ** 2, 0.01);
    return LAMP_LINEAR.map((c, i) => ((ALBEDO[i] ?? 0) / Math.PI) * 2 * c * cosine * falloff);
  }

  /** What the lamp adds to a room surface at world `p` facing `n`: lit minus unlit. */
  function lampAdds(p: number[], n: number[]): number[] {
    const room = new TestRoom({
      window: false,
      rig: { ...DARK, practical: [lamp('lamp', LAMP_AT)] },
    });
    room.group.position.set(ROOM_OFFSET[0] ?? 0, ROOM_OFFSET[1] ?? 0, ROOM_OFFSET[2] ?? 0);
    const { light } = lit('high', room);
    const emissive = (room.surface('room-floor').material as MeshStandardNodeMaterial)
      .emissiveNode as Node | null;
    if (!emissive) throw new Error('no room glow');
    const inputs = new Map<Node, number[]>([
      [positionWorld, p],
      [normalWorld, n],
      [diffuseContribution, ALBEDO],
    ]);
    expect(light.litLamps).toBe(1);
    const on = evaluate(emissive, inputs);
    room.rig = { ...DARK, practical: [] };
    room.revision++;
    light.update(NOON);
    expect(light.litLamps).toBe(0);
    const off = evaluate(emissive, inputs);
    return on.map((v, i) => v - (off[i] ?? 0));
  }

  it('lights a surface as three lights it with a PointLight of the lamp', () => {
    const toLamp = [0, 1.2, 0.5];
    const distance = Math.hypot(...toLamp);
    const added = lampAdds(
      LAMP_WORLD.map((x, i) => x - (toLamp[i] ?? 0)),
      [0, 1, 0],
    );
    const expected = pointLight(distance, 1.2 / distance);
    expect(added[0]).toBeGreaterThan(0.01);
    added.forEach((v, i) => expect(v).toBeCloseTo(expected[i] ?? Number.NaN, 6));
  });

  it("adds nothing past the lamp's reach or behind the surface", () => {
    const below = (drop: number) => [
      LAMP_WORLD[0] ?? 0,
      (LAMP_WORLD[1] ?? 0) - drop,
      LAMP_WORLD[2] ?? 0,
    ];
    for (const v of lampAdds(below(3.2), [0, 1, 0])) expect(v).toBeCloseTo(0, 12);
    for (const v of lampAdds(below(1), [0, -1, 0])) expect(v).toBeCloseTo(0, 12);
  });

  it("fits a plan's lamps into the slots and refuses more when the room is planned", () => {
    const a = lamp('lamp-a', [0, 1, 0]);
    const b = lamp('lamp-b', [1, 1, 0]);
    expect(roomLamps([])).toEqual([]);
    expect(roomLamps([a])).toEqual([a]);
    expect(roomLamps([a, b])).toEqual([a, b]);
    const over = Array.from({ length: ROOM_LAMP_SLOTS + 1 }, (_, i) =>
      lamp(`lamp-${i}`, [i, 1, 0]),
    );
    expect(() => roomLamps(over)).toThrow(/3 lamps exceed ROOM_LAMP_SLOTS \(2\)/);
  });
});

describe('windowMotionAt', () => {
  const STEP_S = 1;

  function copies(motion: WindowMotion, pattern: 'clouds' | 'beads') {
    const p: PatternMotion = motion[pattern];
    return [
      { offset: p.offsetA, layer: p.layerA, gain: p.gainA },
      { offset: p.offsetB, layer: p.layerB, gain: p.gainB },
    ];
  }

  function expectSmooth(fromMs: number, toMs: number) {
    const before = windowMotion();
    const after = windowMotion();
    let restarts = 0;
    for (let t = fromMs; t < toMs; t += STEP_S * 1000) {
      windowMotionAt(t, 12, before);
      windowMotionAt(t + STEP_S * 1000, 12, after);
      for (const [pattern, period, rate] of [
        ['clouds', 7_200, 0.004],
        ['beads', 240, 0.002],
      ] as const) {
        const a = copies(before, pattern);
        const b = copies(after, pattern);
        for (let i = 0; i < 2; i++) {
          const x = a[i];
          const y = b[i];
          if (!x || !y) throw new Error('two copies');
          expect(Math.abs(y.gain - x.gain)).toBeLessThan((4 * STEP_S) / period);
          expect(x.offset).toBeLessThanOrEqual(period * rate);
          const moved = y.offset - x.offset;
          if (y.layer === x.layer && Math.abs(moved - rate * STEP_S) < 1e-6) continue;
          restarts++;
          expect(Math.max(x.gain, y.gain)).toBeLessThan((4 * STEP_S) / period);
        }
      }
      const fallen = (after.rainSeconds - before.rainSeconds + 3_600) % 3_600;
      for (const rate of RAIN_RATES) {
        const slip = ((((fallen - STEP_S) * rate) % 1) + 1) % 1;
        expect(Math.min(slip, 1 - slip)).toBeLessThan(1e-6);
      }
    }
    return restarts;
  }

  it('moves without a jump across UTC midnight', () => {
    const midnight = Date.UTC(2026, 9, 20);
    expect(expectSmooth(midnight - 3_600_000, midnight + 3_600_000)).toBeGreaterThan(0);
  });

  it('moves without a jump across the hour, where the rain clock wraps', () => {
    const hour = Date.UTC(2026, 9, 20, 13);
    expect(expectSmooth(hour - 600_000, hour + 600_000)).toBeGreaterThan(0);
  });

  it('wraps the rain clock at the UTC hour and keeps offsets small for f32', () => {
    const motion = windowMotionAt(Date.UTC(2026, 9, 20, 13, 0, 1), 12, windowMotion());
    expect(motion.rainSeconds).toBeCloseTo(1, 9);
    windowMotionAt(Date.UTC(2026, 9, 20, 12, 59, 59), 12, motion);
    expect(motion.rainSeconds).toBeCloseTo(3_599, 9);
    for (const t of [0, 1e12, 4e12]) {
      windowMotionAt(t, 12, motion);
      for (const v of Object.values(motion.clouds)) expect(Math.abs(v)).toBeLessThan(1_000);
      for (const v of Object.values(motion.beads)) expect(Math.abs(v)).toBeLessThan(1_000);
    }
  });

  it('keeps the cloud contrast through the blend and fades beads plainly', () => {
    const motion = windowMotion();
    for (let t = 0; t < 7_200_000; t += 61_000) {
      windowMotionAt(t, 3, motion);
      const { clouds, beads } = motion;
      expect(Math.hypot(clouds.gainA, clouds.gainB)).toBeCloseTo(1, 9);
      expect(beads.gainA + beads.gainB).toBeCloseTo(1, 9);
      expect(clouds.layerA).not.toBe(clouds.layerB);
    }
    expect(() => windowMotionAt(Number.NaN, 3, motion)).toThrow(RangeError);
  });
});
