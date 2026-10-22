import type { Biome, SpeciesSummary, Tank } from '@aquarium/shared';
import { livingFish } from './life';

export type PhStanding = 'no-fish' | 'in-range' | 'near-edge' | 'too-high' | 'too-low';

export interface PhGuidance {
  standing: PhStanding;
  text: string;
}

const EDGE_MARGIN = 0.2;

/** The pH window every living fish in the tank accepts, or null when nobody lives there or the ranges do not overlap. */
export function sharedPhRange(
  tank: Tank,
  species: readonly SpeciesSummary[],
): readonly [number, number] | null {
  const byId = new Map(species.map((s) => [s.id, s]));
  const kinds = livingFish(tank)
    .map((f) => byId.get(f.species))
    .filter((s): s is SpeciesSummary => s !== undefined);
  if (kinds.length === 0) return null;
  const lo = Math.max(...kinds.map((s) => s.chemistry.phRange[0]));
  const hi = Math.min(...kinds.map((s) => s.chemistry.phRange[1]));
  return lo <= hi ? [lo, hi] : null;
}

export function isBlackwater(biome: Biome): boolean {
  return biome === 'blackwater';
}

// Water changes are the only pH lever in the care contract: the replacement water is soft
// (about 1 dKH), so it pulls hard-water creep down and washes out the nitrate that acidifies an
// unbuffered tank. CO2 is never part of the advice.
export function blackwaterPhGuidance(
  tank: Tank,
  species: readonly SpeciesSummary[],
  ph: number,
): PhGuidance | null {
  if (!isBlackwater(tank.biome) || !Number.isFinite(ph)) return null;
  const shown = ph.toFixed(1);
  if (livingFish(tank).length === 0) {
    return {
      standing: 'no-fish',
      text: `pH ${shown}. Blackwater settles near pH 6 with almost no carbonate hardness, so there is no buffer to hold it steady once fish arrive.`,
    };
  }
  const range = sharedPhRange(tank, species);
  if (!range) {
    return {
      standing: 'too-low',
      text: `pH ${shown}. The fish in this tank do not share a pH range. Check each fish card and keep only the ones that agree.`,
    };
  }
  const [lo, hi] = range;
  const window = `${lo.toFixed(1)} to ${hi.toFixed(1)}`;
  if (ph > hi) {
    return {
      standing: 'too-high',
      text: `pH ${shown} is above your fish's ${window}. Change some water: the soft replacement water pulls the pH back toward 6. CO₂ is not used in blackwater.`,
    };
  }
  if (ph < lo) {
    return {
      standing: 'too-low',
      text: `pH ${shown} is below your fish's ${window}. Nitrate acidifies soft water, so vacuum the gravel and change some water to bring it up.`,
    };
  }
  if (ph - lo < EDGE_MARGIN || hi - ph < EDGE_MARGIN) {
    return {
      standing: 'near-edge',
      text: `pH ${shown} is within your fish's ${window} but close to the edge. Soft water has little buffer, so test again after the next feed or water change.`,
    };
  }
  return { standing: 'in-range', text: `pH ${shown} suits your fish (${window}).` };
}

export const NO_CO2_NOTE =
  'CO₂ is not sold for blackwater tanks. With almost no carbonate hardness it would crash the pH below what these fish accept.';

export function equipmentNote(biome: Biome): string | null {
  return isBlackwater(biome) ? NO_CO2_NOTE : null;
}

export function blackwaterReportLines(tank: Tank, species: readonly SpeciesSummary[]): string[] {
  const guidance = blackwaterPhGuidance(tank, species, tank.chemistry.ph);
  return guidance ? [guidance.text] : [];
}
