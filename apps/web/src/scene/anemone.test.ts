import { describe, expect, it } from 'vitest';
import { Box3, Color, DirectionalLight, Vector3 } from 'three/webgpu';
import type { DecorItem } from '@aquarium/shared';
import { WaterMedium } from '../engine/water/medium';
import type { Engine } from '../engine/Engine';
import { anemoneAnchor, anemoneCollider, anemoneReach } from './anemone';
import type { CatalogEntry } from './assets';
import { applyBiomeLighting } from './lighting';

const entry: CatalogEntry = {
  id: 'host-anemone',
  kind: 'anemone',
  lods: [],
  bounds: { min: [-0.14, 0, -0.15], max: [0.15, 0.15, 0.14] },
};
const item: DecorItem = {
  assetId: 'host-anemone',
  position: [-0.3, 0.07, 0.07],
  rotationY: 0.8,
  scale: 0.65,
};

describe('anemone hosting data', () => {
  it('anchors in free water above the foot, inside the crown', () => {
    const anchor = anemoneAnchor('anemone-1', entry, item);
    expect(anchor.kind).toBe('anemone');
    expect(anchor.position[0]).toBe(-0.3);
    expect(anchor.position[1]).toBeGreaterThan(item.position[1]);
    expect(anchor.position[1]).toBeLessThan(item.position[1] + 0.15 * item.scale);
    expect(anchor.radius).toBeGreaterThan(0.03);
    expect(anchor.radius).toBeLessThan(0.15 * item.scale);
  });

  it('is a soft collider that does not stop fish', () => {
    const collider = anemoneCollider(entry, item);
    expect(collider.kind).toBe('capsule');
    expect(collider.hard).toBe(false);
    expect(collider.a[1]).toBeGreaterThanOrEqual(item.position[1]);
    expect(collider.b[1]).toBeGreaterThanOrEqual(collider.a[1]);
  });

  it('reaches further in a stronger current', () => {
    const calm = { direction: [1, 0] as const, speed: 0.02, gustPeriodS: 8, gustDepth: 0.2 };
    const brisk = { ...calm, speed: 0.1, gustDepth: 0.5 };
    expect(anemoneReach(entry, item, brisk)).toBeGreaterThan(anemoneReach(entry, item, calm));
    expect(anemoneReach(entry, item, calm)).toBeGreaterThan(0.15 * item.scale);
  });

  it('adds the sideways meander to the ambient lean', () => {
    const tall: CatalogEntry = { ...entry, bounds: { min: [-0.1, 0, -0.1], max: [0.1, 10, 0.1] } };
    const still = { direction: [1, 0] as const, speed: 0, gustPeriodS: 8, gustDepth: 0 };
    const gusty = { ...still, speed: 0.05, gustDepth: 0.5 };
    const flowOnly = gusty.speed * (1 + gusty.gustDepth) * 0.35;
    const extra = anemoneReach(tall, item, gusty) - anemoneReach(tall, item, still);
    expect(extra).toBeGreaterThan(flowOnly + 1e-6);
  });

  it('stays finite at scale 0 with no pump and no gust', () => {
    const still = { direction: [1, 0] as const, speed: 0, gustPeriodS: 8, gustDepth: 0 };
    expect(anemoneReach(entry, { ...item, scale: 0 }, still)).toBe(0);
  });

  it('counts a rotated corner in its reach', () => {
    const square: CatalogEntry = {
      ...entry,
      bounds: { min: [-0.1, 0, -0.1], max: [0.1, 0.15, 0.1] },
    };
    const still = { direction: [1, 0] as const, speed: 0, gustPeriodS: 8, gustDepth: 0 };
    const turned = { ...item, scale: 1, rotationY: Math.PI / 4 };
    expect(anemoneReach(square, turned, still)).toBeGreaterThan(Math.hypot(0.1, 0.1));
  });

  it('refuses an anemone asset without bounds', () => {
    expect(() => anemoneAnchor('a', { id: 'x', kind: 'anemone', lods: [] }, item)).toThrow(
      /no bounds/,
    );
  });
});

describe('applyBiomeLighting', () => {
  function fakeEngine(): Engine {
    const hood = new DirectionalLight(new Color(1, 0.97, 0.92), 3);
    const medium = new WaterMedium(new Box3(new Vector3(-1, 0, -1), new Vector3(1, 1, 1)), {
      cdom440: 0.05,
      turbidity: 0.08,
    });
    return {
      hood,
      medium,
      ambientScatter: new Color(0.02, 0.03, 0.034),
      substrateAlbedo: new Color(0.13, 0.09, 0.055),
      interior: { fillLevel: 0.28 },
    } as unknown as Engine;
  }

  it('leaves freshwater untouched', () => {
    const engine = fakeEngine();
    const restore = applyBiomeLighting(engine, 'freshwater');
    expect(engine.hood.intensity).toBe(3);
    expect(engine.medium.getQuality()).toEqual({ cdom440: 0.05, turbidity: 0.08 });
    expect(engine.interior.fillLevel).toBe(0.28);
    restore();
    expect(engine.hood.intensity).toBe(3);
  });

  it('cools and clears the reef, then restores the previous lighting exactly', () => {
    const engine = fakeEngine();
    const restore = applyBiomeLighting(engine, 'reef');
    expect(engine.hood.color.b).toBeGreaterThan(engine.hood.color.r);
    expect(engine.medium.getQuality().cdom440).toBeLessThan(0.05);
    expect(engine.substrateAlbedo.r).toBeGreaterThan(0.5);
    expect(engine.interior.fillLevel).toBe(0);
    restore();
    expect(engine.hood.color.getHex()).toBe(new Color(1, 0.97, 0.92).getHex());
    expect(engine.hood.intensity).toBe(3);
    expect(engine.medium.getQuality()).toEqual({ cdom440: 0.05, turbidity: 0.08 });
    expect(engine.ambientScatter.g).toBeCloseTo(0.03);
    expect(engine.substrateAlbedo.getHex()).toBe(new Color(0.13, 0.09, 0.055).getHex());
    expect(engine.interior.fillLevel).toBe(0.28);
  });
});
