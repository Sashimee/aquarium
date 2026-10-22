import { describe, expect, it } from 'vitest';
import { TIERS, TIER_SETTINGS, type Tier } from '../engine/quality/tiers';
import catalog from '../../public/assets/index.json';
import type { ModelLod } from './assets';
import { plantCastsShadow, plantLodFor } from './plants';
import { loadPreset } from './preset';
import { PLANT_LOD } from './TankScene';

const triangles = new Map(
  catalog.assets.map((a) => [a.id, a.lods.map((l) => (l as { triangles: number }).triangles)]),
);

interface FrameCost {
  readonly shadow: number;
  readonly main: number;
  readonly frame: number;
}

function plantCost(
  tier: Tier,
  lodFor: (assetId: string, lod: ModelLod) => ModelLod,
  casts: (assetId: string) => boolean,
): FrameCost {
  const preset = loadPreset('freshwater');
  const { plantDensity, shadowMapSize, surfaceReflection } = TIER_SETTINGS[tier];
  let main = 0;
  let shadow = 0;
  const add = (assetId: string, instances: number) => {
    const cost = instances * (triangles.get(assetId)?.[lodFor(assetId, PLANT_LOD[tier])] ?? 0);
    main += cost;
    if (casts(assetId)) shadow += cost;
  };
  for (const patch of preset.plantPatches) add(patch.assetId, patch.count * plantDensity);
  for (const item of preset.decor) if (triangles.has(item.assetId)) add(item.assetId, 1);
  const passes = 1 + (surfaceReflection > 0 ? 1 : 0);
  const shadowPass = shadowMapSize > 0 ? shadow : 0;
  return { shadow: shadowPass, main, frame: main * passes + shadowPass };
}

const before = (tier: Tier) =>
  plantCost(
    tier,
    (_id, lod) => lod,
    () => true,
  );
const after = (tier: Tier) => plantCost(tier, plantLodFor, plantCastsShadow);

describe('freshwater plant triangles per frame', () => {
  it('cuts the frame cost by more than 40% on the tiers that shadow, against the cost before the carpet stops casting and drops a LOD', () => {
    const rows = TIERS.map((tier) => ({
      tier,
      before: Math.round(before(tier).frame),
      after: Math.round(after(tier).frame),
      shadowBefore: Math.round(before(tier).shadow),
      shadowAfter: Math.round(after(tier).shadow),
    }));
    const reduction = (tier: Tier) => {
      const row = rows.find((r) => r.tier === tier);
      return (row?.after ?? 0) / (row?.before ?? 1);
    };
    for (const tier of ['medium', 'high', 'ultra'] as const) {
      expect(reduction(tier), tier).toBeLessThan(0.6);
    }
    expect(rows.find((r) => r.tier === 'low')?.after).toBe(
      rows.find((r) => r.tier === 'low')?.before,
    );
    expect(rows.find((r) => r.tier === 'medium')?.before).toBeGreaterThan(1_000_000);
  });

  it('keeps the carpet out of the shadow pass', () => {
    expect(plantCastsShadow('staurogyne-repens')).toBe(false);
    expect(plantCastsShadow('vallisneria')).toBe(true);
    for (const tier of ['medium', 'high', 'ultra'] as const) {
      expect(after(tier).shadow).toBeLessThan(before(tier).shadow * 0.5);
    }
  });

  it('draws the carpet one LOD coarser than other plants, down to the coarsest', () => {
    expect([0, 1, 2].map((lod) => plantLodFor('staurogyne-repens', lod as ModelLod))).toEqual([
      1, 2, 2,
    ]);
    for (const lod of [0, 1, 2] as const) expect(plantLodFor('vallisneria', lod)).toBe(lod);
  });

  it('stays within a frame budget per tier', () => {
    const budget: Record<Tier, number> = {
      low: 150_000,
      medium: 700_000,
      high: 1_500_000,
      ultra: 4_200_000,
    };
    for (const tier of TIERS) expect(after(tier).frame, tier).toBeLessThan(budget[tier]);
  });
});
