import { describe, expect, it } from 'vitest';
import type { Biome, DecorItem, TankSize } from '@aquarium/shared';
import { TANK_DIMENSIONS, WATER_INSET } from '../engine/tank/dimensions';
import catalog from '../../public/assets/index.json';
import { BANK_RIM_MARGIN, bankAnchors, BANK_TOPS } from './bank';
import { fitPresetToTank, type BoundsOf } from './presetFit';
import { loadPreset } from './preset';

type Tank = (typeof TANK_DIMENSIONS)[TankSize];
const standard = TANK_DIMENSIONS.standard;
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

const entries = new Map(catalog.assets.map((a) => [a.id, a]));
const boundsOf: BoundsOf = (assetId) => {
  const bounds = entries.get(assetId)?.bounds;
  return bounds ? { bounds, swayReach: null } : null;
};

function fittedBanks(size: TankSize) {
  const d = TANK_DIMENSIONS[size];
  const fitted = fitPresetToTank(loadPreset('mangrove'), size, d, boundsOf, () => 0);
  return { d, fitted, banks: bankAnchors(fitted.decor, waterTop(d), reach(d)) };
}

describe('bank anchors on the fitted mangrove preset', () => {
  it.each(['standard', 'std200', 'long300'] satisfies TankSize[])(
    '%s keeps exactly one perch above the water, under the rim',
    (size) => {
      const { d, banks } = fittedBanks(size);
      expect(banks).toHaveLength(1);
      const [bank] = banks;
      expect(bank?.kind).toBe('bank');
      expect(bank?.position[1]).toBeGreaterThanOrEqual(waterTop(d));
      expect(bank?.position[1]).toBeLessThan(d.height - BANK_RIM_MARGIN);
    },
  );

  it('keeps the ordinary stump under the water in every tank', () => {
    for (const size of ['standard', 'std200', 'long300', 'nano30'] satisfies TankSize[]) {
      const { d, fitted } = fittedBanks(size);
      const peaks = fitted.decor
        .filter((i) => i.assetId === 'mangrove-stump')
        .map((i) => i.position[1] + 0.28 * i.scale)
        .sort((a, b) => a - b);
      expect(peaks.length, size).toBe(2);
      expect(peaks[0], size).toBeLessThan(waterTop(d));
    }
  });

  it('has no perch in the nano tank because the fitted trunk stays under the water', () => {
    const { d, fitted, banks } = fittedBanks('nano30');
    expect(banks).toEqual([]);
    for (const item of fitted.decor.filter((i) => i.assetId === 'mangrove-stump')) {
      expect(item.position[1] + 0.28 * item.scale).toBeLessThan(waterTop(d));
    }
  });
});

describe('bank anchors', () => {
  it.each(['freshwater', 'reef', 'cichlid', 'blackwater'] satisfies Biome[])(
    '%s has no bank',
    (biome) => {
      expect(bankAnchors(loadPreset(biome).decor, waterTop(standard))).toEqual([]);
    },
  );

  it('drops a stump whose point stays under the water, with a footprint given', () => {
    expect(bankAnchors([stump({ scale: 1 })], waterTop(standard), reach(standard))).toEqual([]);
  });

  it('keeps a perch whose point is exactly at the water line', () => {
    const top = BANK_TOPS['mangrove-stump']?.position[1] ?? 0;
    const scale = 1.5;
    const water = 0.06 + top * scale;
    const kept = bankAnchors([stump({ scale })], water, reach(standard));
    expect(kept).toHaveLength(1);
    expect(bankAnchors([stump({ scale })], water + 1e-6, reach(standard))).toEqual([]);
  });

  it('drops a perch outside the water footprint and keeps ids tied to list order', () => {
    const items = [stump({ position: [0.8, 0.06, 0] }), stump({ position: [0.1, 0.06, 0] })];
    const banks = bankAnchors(items, waterTop(standard), reach(standard));
    expect(banks.map((b) => b.id)).toEqual(['bank-2']);
  });
});
