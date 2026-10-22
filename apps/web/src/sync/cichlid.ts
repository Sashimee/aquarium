import { speciesSchema, type DecorItem, type SpeciesSummary, type Tank } from '@aquarium/shared';
import { loadPreset } from '../scene/preset';
import { BUNDLED_CHEMISTRY } from './bundledEconomy';
import { livingFish } from './life';

export type DriftLevel = 'watch' | 'caution' | 'danger';

export interface DriftNote {
  metric: 'kh' | 'ph';
  level: DriftLevel;
  text: string;
  fix: 'water-change' | 'needs-buffer' | null;
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
 * source water, so when the tank is already at or above that, no chore can raise it: `needs-buffer`.
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
    const fix = kh < sourceKh ? 'water-change' : 'needs-buffer';
    const how =
      fix === 'water-change'
        ? 'A water change brings it back toward the tap water.'
        : 'Your tap water is no harder than this, so a water change will not lift it. A buffer is what the tank needs.';
    if (kh < khNeed) {
      notes.push({
        metric: 'kh',
        level: level(khNeed - kh, fullStressDeviation.kh),
        text: `Hardness is ${kh} dKH. Your fish want at least ${khNeed}. Soft water stunts rift lake cichlids and slowly harms them. ${how}`,
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
    if (ph < low) {
      notes.push({
        metric: 'ph',
        level: level(low - ph, fullStressDeviation.ph),
        text: `pH is ${ph}, below the ${low} your fish need. Lake water is hard and alkaline; soft water lets the pH slide down. Restore the hardness first.`,
        fix: kh !== undefined && kh >= sourceKh ? 'needs-buffer' : 'water-change',
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
        text: `pH is ${ph}, near the bottom of what your fish need (${low}).`,
        fix: 'water-change',
      });
    }
  }
  return notes;
}

const SHELTER_ASSETS: ReadonlySet<string> = new Set([
  'reef-arch',
  'rock-pile-cave',
  'rock-pile-stack',
  'neothauma-shell',
]);

export const isShelterAsset = (assetId: string): boolean => SHELTER_ASSETS.has(assetId);

export function shelterCount(tank: Pick<Tank, 'biome' | 'decorEdited' | 'decorLayout'>): number {
  const items: readonly DecorItem[] = tank.decorEdited
    ? tank.decorLayout
    : loadPreset(tank.biome).decor;
  return items.filter((i) => isShelterAsset(i.assetId)).length;
}

const files = import.meta.glob<unknown>('../../../../content/species/*.json', {
  eager: true,
  import: 'default',
});

const TERRITORIAL = new Set<string>();
for (const raw of Object.values(files)) {
  const parsed = speciesSchema.partial({ render: true }).parse(raw);
  if (parsed.behaviour.territorial) TERRITORIAL.add(parsed.id);
}

export const isTerritorial = (speciesId: string): boolean => TERRITORIAL.has(speciesId);

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
    return `${candidate.commonName} claims a hiding place of its own, and this tank has ${shelters} for ${holders.length} fish that already do. With too few, the territorial fish fight over them and the losers get chased and stressed. Add rocks, caves or shells in decorate mode first, or add it anyway.`;
  }
  if (
    isTerritorial(candidate.id) &&
    residents.some((r) => isTerritorial(r.id) && r.id !== candidate.id)
  ) {
    return `${candidate.commonName} defends a territory, and so do some of your fish. Expect chasing while they sort out borders. Plenty of rocks and sight breaks keep it to bluffing.`;
  }
  return null;
}
