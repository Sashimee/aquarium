import {
  CubeUVReflectionMapping,
  DirectionalLight,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  RenderTarget,
  type Node,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { RoomBackdrop } from '../../scene/room/RoomBackdrop';
import { TANK_DIMENSIONS } from '../tank/dimensions';
import { TIERS, type Tier } from '../quality/tiers';
import { reversedSmoothsteps } from '../reversedSmoothsteps';
import { buildShaders } from '../shaderFixtures';
import { ROOM_LIGHT_DETAIL, RoomLight, tankGlow, type RoomLightInput } from './RoomLight';
import { roomLightAt } from './timeOfDay';

const tank = TANK_DIMENSIONS.standard;
const NOON: RoomLightInput = { nowMs: Date.UTC(2026, 9, 19, 12), minute: 13 * 60, hood: 1 };

function environment() {
  const texture = new RenderTarget(64, 64).texture;
  texture.mapping = CubeUVReflectionMapping;
  return texture;
}

function room(tier: Tier = 'high', choice: 'living-room' | 'office' | 'none' = 'living-room') {
  const backdrop = new RoomBackdrop();
  backdrop.update({ choice, tank, tier });
  return backdrop;
}

function standardMaterials(backdrop: RoomBackdrop): MeshStandardNodeMaterial[] {
  const found = new Set<MeshStandardNodeMaterial>();
  backdrop.group.traverse((object) => {
    const material = (object as Partial<Mesh>).material;
    if (material instanceof MeshStandardNodeMaterial) found.add(material);
  });
  return [...found];
}

function paneMaterial(backdrop: RoomBackdrop): MeshBasicNodeMaterial {
  const material = backdrop.pane?.material;
  if (!(material instanceof MeshBasicNodeMaterial)) throw new Error('no pane material');
  return material;
}

function lit(tier: Tier, backdrop = room(tier)) {
  const light = new RoomLight({ environment: environment(), tier, seed: 12 });
  light.attach(backdrop);
  light.update(NOON);
  return { light, backdrop };
}

describe('RoomLight', () => {
  it('paints the window and lights every room material', () => {
    const { backdrop } = lit('high');
    expect(paneMaterial(backdrop).colorNode).not.toBeNull();
    const materials = standardMaterials(backdrop);
    expect(materials.map((m) => m.name)).toContain('room-books');
    for (const material of materials) {
      expect(material.envNode).not.toBeNull();
      expect(material.emissiveNode).not.toBeNull();
    }
  });

  it('keeps the low tier to the sky and the ambient: no sun patch or tank glow', () => {
    const { backdrop } = lit('low');
    expect(paneMaterial(backdrop).colorNode).not.toBeNull();
    for (const material of standardMaterials(backdrop)) {
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
      const pane = lit(tier).backdrop.pane;
      if (!pane) throw new Error('no pane');
      return buildShaders(pane, 'webgpu').fragment.length;
    };
    const sizes = TIERS.map(size);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1] ?? Infinity);
    }
    const low = lit('low').backdrop.pane;
    if (!low) throw new Error('no pane');
    expect(buildShaders(low, 'webgpu').fragment).not.toMatch(/mx_|noise/i);
  });

  it('builds WGSL and GLSL for the window and the room on every tier', () => {
    for (const tier of TIERS) {
      const { backdrop } = lit(tier);
      const pane = backdrop.pane;
      if (!pane) throw new Error('no pane');
      const wall = backdrop.group.getObjectByName('room-wall-back');
      if (!(wall instanceof Mesh)) throw new Error('no back wall');
      for (const backend of ['webgpu', 'webgl'] as const) {
        expect(buildShaders(pane, backend).fragment.length).toBeGreaterThan(0);
        const lit = buildShaders(wall, backend, [new DirectionalLight()]).fragment;
        expect(lit).toContain('getUV');
      }
      expect(reversedSmoothsteps(paneMaterial(backdrop).colorNode)).toEqual([]);
      const emissive = (wall.material as MeshStandardNodeMaterial).emissiveNode as Node | null;
      expect(reversedSmoothsteps(emissive)).toEqual([]);
    }
  });

  it('dresses the room again after it rebuilds, and the new tier on a tier change', () => {
    const { light, backdrop } = lit('low', room('low'));
    backdrop.update({ choice: 'office', tank, tier: 'high' });
    light.setTier('high');
    light.update(NOON);
    expect(paneMaterial(backdrop).colorNode).not.toBeNull();
    for (const material of standardMaterials(backdrop)) {
      expect(material.emissiveNode).not.toBeNull();
    }
    light.setTier('low');
    for (const material of standardMaterials(backdrop)) expect(material.envNode).toBeNull();
    light.update(NOON);
    for (const material of standardMaterials(backdrop)) {
      expect(material.envNode).not.toBeNull();
      expect(material.emissiveNode).toBeNull();
    }
  });

  it('copes with no room, and lets go of a room that leaves', () => {
    const light = new RoomLight({ environment: environment(), tier: 'high', seed: 1 });
    expect(() => light.update(NOON)).not.toThrow();
    const backdrop = room('high');
    light.attach(backdrop);
    light.update(NOON);
    const pane = paneMaterial(backdrop);
    backdrop.update({ choice: 'none', tank, tier: 'high' });
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
    const { light, backdrop } = lit('ultra');
    light.dispose();
    expect(paneMaterial(backdrop).colorNode).toBeNull();
    for (const material of standardMaterials(backdrop)) {
      expect(material.envNode).toBeNull();
      expect(material.emissiveNode).toBeNull();
    }
    expect(() => light.dispose()).not.toThrow();
    expect(() => light.update(NOON)).toThrow(/after dispose/);
    expect(() => light.attach(backdrop)).toThrow(/after dispose/);
    expect(() => light.setTier('low')).toThrow(/after dispose/);
  });

  it('rejects a seed or hood level it cannot use', () => {
    expect(() => new RoomLight({ environment: environment(), tier: 'low', seed: 0.5 })).toThrow(
      RangeError,
    );
    const { light } = lit('low');
    expect(() => light.update({ ...NOON, hood: Number.NaN })).toThrow(/hood/);
  });
});
