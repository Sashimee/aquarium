import { keptPresetDecor, type DecorItem, type SpeciesSummary, type Tank } from '@aquarium/shared';
import { loadPreset } from '../scene/preset';
import { BUNDLED_CHEMISTRY } from './bundledEconomy';
import { isBundledTerritorial } from './bundledSpecies';
import { livingFish } from './life';

export type DriftLevel = 'watch' | 'caution' | 'danger';

export interface DriftNote {
  metric: 'kh' | 'ph';
  level: DriftLevel;
  text: string;
  fix: 'water-change' | 'no-fix' | null;
}

export interface LakeReadings {
  kh?: number | undefined;
  ph?: number | undefined;
}

const WATCH_MARGIN_KH = 1.5;
const WATCH_MARGIN_PH = 0.2;

const level = (deviation: number, full: number): DriftLevel =>
  deviation >= full ? 'danger' : 'caution';

/**
 * Hardness and pH against what the fish in the tank need. A water change only pulls KH toward the
 * source water, so when the tank is already at or above that, no chore can raise it: `no-fix`.
 */
export function lakeWaterNotes(
  tank: Tank,
  species: readonly SpeciesSummary[],
  readings: LakeReadings,
): DriftNote[] {
  const byId = new Map(species.map((s) => [s.id, s]));
  const kinds = livingFish(tank).flatMap((f) => byId.get(f.species) ?? []);
  if (kinds.length === 0) return [];
  const notes: DriftNote[] = [];
  const { fullStressDeviation } = BUNDLED_CHEMISTRY.stress;
  const sourceKh = BUNDLED_CHEMISTRY.kh.sourceWater[tank.biome];

  const khNeed = Math.max(...kinds.map((s) => s.chemistry.khMin));
  const { kh, ph } = readings;
  if (kh !== undefined && khNeed > 0) {
    const fix = kh < sourceKh ? 'water-change' : 'no-fix';
    const how =
      fix === 'water-change'
        ? 'A water change brings it back toward the tap water.'
        : 'Your tap water is no harder than this, so a water change will not lift it. The tank needs the hardness raised.';
    if (kh < khNeed) {
      notes.push({
        metric: 'kh',
        level: level(khNeed - kh, fullStressDeviation.kh),
        text: `Hardness is ${kh} dKH. Your fish want at least ${khNeed}. Soft water slowly harms them. ${how}`,
        fix,
      });
    } else if (kh < khNeed + WATCH_MARGIN_KH) {
      notes.push({
        metric: 'kh',
        level: 'watch',
        text: `Hardness is ${kh} dKH, close to the ${khNeed} your fish want. The filter eats hardness as it works, so keep up the water changes.`,
        fix: kh < sourceKh ? 'water-change' : null,
      });
    }
  }

  if (ph !== undefined) {
    const low = Math.max(...kinds.map((s) => s.chemistry.phRange[0]));
    const high = Math.min(...kinds.map((s) => s.chemistry.phRange[1]));
    if (low > high) {
      notes.push({
        metric: 'ph',
        level: 'caution',
        text: `pH is ${ph}. The fish in this tank need pH ranges that do not overlap (${low} and up for some, ${high} and down for others), so no pH suits all of them.`,
        fix: null,
      });
    } else if (ph < low) {
      const co2 = tank.equipment.co2.tier > 0;
      notes.push({
        metric: 'ph',
        level: level(low - ph, fullStressDeviation.ph),
        text: co2
          ? `pH is ${ph}, below the ${low} your fish need. The CO2 system is pulling the pH down, and a water change will not undo that.`
          : `pH is ${ph}, below the ${low} your fish need. Nitrate from waste turns the water acidic; a water change takes it out.`,
        fix: co2 ? 'no-fix' : 'water-change',
      });
    } else if (ph > high) {
      notes.push({
        metric: 'ph',
        level: level(ph - high, fullStressDeviation.ph),
        text: `pH is ${ph}, above the ${high} your fish tolerate.`,
        fix: null,
      });
    } else if (ph < low + WATCH_MARGIN_PH) {
      notes.push({
        metric: 'ph',
        level: 'watch',
        text: `pH is ${ph}, near the bottom of what your fish need (${low}).${tank.equipment.co2.tier > 0 ? ' The CO2 system pulls the pH down.' : ''}`,
        fix: tank.equipment.co2.tier > 0 ? 'no-fix' : 'water-change',
      });
    }
  }
  return notes;
}

export const SHELTER_ASSET_IDS: ReadonlySet<string> = new Set([
  'reef-arch',
  'rock-pile-cave',
  'rock-pile-stack',
  'neothauma-shell',
]);

export const isShelterAsset = (assetId: string): boolean => SHELTER_ASSET_IDS.has(assetId);

export function shelterCount(
  tank: Pick<Tank, 'biome' | 'decorEdited' | 'decorLayout' | 'size'>,
): number {
  const items: readonly DecorItem[] = tank.decorEdited
    ? tank.decorLayout
    : keptPresetDecor(loadPreset(tank.biome).decor, tank.size);
  return items.filter((i) => isShelterAsset(i.assetId)).length;
}

export const isTerritorial = isBundledTerritorial;

const claimsHome = (s: SpeciesSummary): boolean => isTerritorial(s.id) || s.breeding.needsCave;

/** Advice only: a crowded lake tank still works, the fish just fight. The shop lets the player add anyway. */
export function territoryWarning(
  tank: Tank,
  candidate: SpeciesSummary,
  all: readonly SpeciesSummary[],
): string | null {
  if (tank.biome !== 'cichlid') return null;
  const byId = new Map(all.map((s) => [s.id, s]));
  const residents = livingFish(tank).flatMap((f) => byId.get(f.species) ?? []);
  const holders = residents.filter(claimsHome);
  const shelters = shelterCount(tank);

  if (claimsHome(candidate) && holders.length + 1 > shelters) {
    const have =
      holders.length === 0
        ? `this tank has ${shelters}`
        : `this tank has ${shelters} for ${holders.length} fish that already do`;
    return `${candidate.commonName} claims a hiding place of its own, and ${have}. With too few, the territorial fish fight over them and the losers get chased and stressed. Add rocks, caves or shells in decorate mode first, or add it anyway.`;
  }
  if (
    isTerritorial(candidate.id) &&
    residents.some((r) => isTerritorial(r.id) && r.id !== candidate.id)
  ) {
    return `${candidate.commonName} defends a territory, and so do some of your fish. Expect chasing while they sort out borders. Plenty of rocks and sight breaks keep it to bluffing.`;
  }
  return null;
}
