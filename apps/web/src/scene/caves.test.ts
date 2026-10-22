import { describe, expect, it } from 'vitest';
import type { Biome, DecorItem } from '@aquarium/shared';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { caveAnchor, caveAnchors } from './caves';
import { loadPreset } from './preset';

const SHELTERED: readonly Biome[] = ['reef', 'cichlid'];
const BARE: readonly Biome[] = ['freshwater', 'blackwater', 'mangrove'];
const half = (n: number) => n / 2 - DEFAULT_TANK.glass;

const arch = (over: Partial<DecorItem>): DecorItem => ({
  assetId: 'reef-arch',
  position: [0, 0.1, 0],
  rotationY: 0,
  scale: 1.7,
  ...over,
});

describe('cave anchors from presets', () => {
  it.each(SHELTERED)('%s offers caves inside the water, clear of the substrate', (biome) => {
    const anchors = caveAnchors(loadPreset(biome).decor);
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      const [x, y, z] = a.position;
      expect(a.kind).toBe('cave');
      expect(Math.abs(x)).toBeLessThan(half(DEFAULT_TANK.length));
      expect(Math.abs(z)).toBeLessThan(half(DEFAULT_TANK.depth));
      expect(y).toBeGreaterThan(substrateHeight(DEFAULT_TANK, x, z));
      expect(y).toBeLessThan(DEFAULT_TANK.height - DEFAULT_TANK.freeboard);
    }
  });

  it.each(SHELTERED)('%s anchors have unique ids and a unit horizontal facing', (biome) => {
    const anchors = caveAnchors(loadPreset(biome).decor);
    expect(new Set(anchors.map((a) => a.id)).size).toBe(anchors.length);
    for (const a of anchors) {
      const [fx = 0, fy = 0, fz = 0] = a.facing ?? [];
      expect(Math.hypot(fx, fy, fz)).toBeCloseTo(1, 10);
      expect(fy).toBe(0);
    }
  });

  it('puts one cichlid anchor on every shell and rock shelter', () => {
    const preset = loadPreset('cichlid');
    const shelters = preset.decor.filter((d) =>
      ['neothauma-shell', 'rock-pile-cave', 'rock-pile-stack'].includes(d.assetId),
    );
    expect(caveAnchors(preset.decor)).toHaveLength(shelters.length);
  });

  it.each(BARE)('%s has no shelter decor and so no cave anchors', (biome) => {
    expect(caveAnchors(loadPreset(biome).decor)).toEqual([]);
  });
});

describe('caveAnchor', () => {
  it('faces outward along +z when unrotated, with the mouth in front of the body', () => {
    const a = caveAnchor('c', arch({ position: [0.1, 0.1, 0.2] }));
    expect(a.facing).toEqual([0, 0, 1]);
    expect(a.position[2]).toBeGreaterThan(0.2);
  });

  it('turns the mouth and its facing together with the decor', () => {
    const a = caveAnchor('c', arch({ rotationY: Math.PI / 2 }));
    const [fx = 0, , fz = 0] = a.facing ?? [];
    expect(fx).toBeCloseTo(1, 10);
    expect(fz).toBeCloseTo(0, 10);
    expect(a.position[0]).toBeGreaterThan(0);
  });

  it('scales the radius with the decor', () => {
    const small = caveAnchor('c', arch({ scale: 1 }));
    const big = caveAnchor('c', arch({ scale: 2 }));
    expect(big.radius).toBeCloseTo(small.radius * 2, 10);
  });

  it('rejects an asset with no known mouth', () => {
    expect(() => caveAnchor('c', arch({ assetId: 'boulder-01' }))).toThrow(/no cave mouth/);
  });
});
