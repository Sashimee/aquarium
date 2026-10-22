import { describe, expect, it } from 'vitest';
import type { Biome, DecorItem } from '@aquarium/shared';
import { DEFAULT_TANK, TANK_DIMENSIONS, WATER_INSET } from '../engine/tank/dimensions';
import { bankAnchors } from './bank';
import { loadPreset } from './preset';

type Tank = typeof DEFAULT_TANK;
const waterTop = (d: Tank) => d.height - d.freeboard;
const reach = (d: Tank) => ({
  halfX: d.length / 2 - d.glass - WATER_INSET,
  halfZ: d.depth / 2 - d.glass - WATER_INSET,
});
const stump = (over: Partial<DecorItem>): DecorItem => ({
  assetId: 'mangrove-stump',
  position: [0, 0.06, 0],
  rotationY: 0,
  scale: 1.55,
  ...over,
});

describe('bank anchors', () => {
  it('gives the mangrove preset a perch that clears the water top inside the tank', () => {
    const banks = bankAnchors(
      loadPreset('mangrove').decor,
      waterTop(DEFAULT_TANK),
      reach(DEFAULT_TANK),
    );
    expect(banks.length).toBeGreaterThan(0);
    for (const b of banks) {
      expect(b.kind).toBe('bank');
      expect(b.position[1]).toBeGreaterThanOrEqual(waterTop(DEFAULT_TANK));
      expect(b.position[1]).toBeLessThanOrEqual(DEFAULT_TANK.height);
    }
  });

  it.each(['freshwater', 'reef', 'cichlid', 'blackwater'] satisfies Biome[])(
    '%s has no bank',
    (biome) => {
      expect(bankAnchors(loadPreset(biome).decor, waterTop(DEFAULT_TANK))).toEqual([]);
    },
  );

  it('drops a stump whose top stays under the water', () => {
    expect(bankAnchors([stump({ scale: 1 })], waterTop(DEFAULT_TANK))).toEqual([]);
  });

  it('drops a perch outside the water footprint and keeps ids tied to list order', () => {
    const items = [stump({ position: [0.8, 0.06, 0] }), stump({ position: [0.1, 0.06, 0] })];
    const banks = bankAnchors(items, waterTop(DEFAULT_TANK), reach(DEFAULT_TANK));
    expect(banks.map((b) => b.id)).toEqual(['bank-2']);
  });

  it('drops the preset perch in a nano tank, where it lies outside the water', () => {
    const d = TANK_DIMENSIONS.nano30;
    expect(bankAnchors(loadPreset('mangrove').decor, waterTop(d), reach(d))).toEqual([]);
  });
});
