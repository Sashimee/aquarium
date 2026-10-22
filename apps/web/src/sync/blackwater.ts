import type { Biome, SpeciesSummary, Tank } from '@aquarium/shared';

export type PhStanding =
  'no-fish' | 'in-range' | 'near-edge' | 'too-high' | 'too-low' | 'no-overlap';

export interface PhGuidance {
  standing: PhStanding;
  text: string;
}

const EDGE_MARGIN = 0.2;

const roundPh = (ph: number): number => Math.round(ph * 10) / 10;

function knownKinds(tank: Tank, species: readonly SpeciesSummary[]): SpeciesSummary[] {
  const byId = new Map(species.map((s) => [s.id, s]));
  return tank.fish
    .filter((f) => f.status === 'alive')
    .map((f) => byId.get(f.species))
    .filter((s): s is SpeciesSummary => s !== undefined);
}

/** The pH window every living fish of a known species accepts, or null when there is none or the ranges do not overlap. */
export function sharedPhRange(
  tank: Tank,
  species: readonly SpeciesSummary[],
): readonly [number, number] | null {
  const kinds = knownKinds(tank, species);
  if (kinds.length === 0) return null;
  const lo = Math.max(...kinds.map((s) => s.chemistry.phRange[0]));
  const hi = Math.min(...kinds.map((s) => s.chemistry.phRange[1]));
  return lo <= hi ? [lo, hi] : null;
}

export function isBlackwater(biome: Biome): boolean {
  return biome === 'blackwater';
}

interface Assessment {
  standing: PhStanding;
  window: string;
}

function assess(tank: Tank, species: readonly SpeciesSummary[], ph: number): Assessment | null {
  if (!isBlackwater(tank.biome) || !Number.isFinite(ph)) return null;
  if (!tank.fish.some((f) => f.status === 'alive')) return { standing: 'no-fish', window: '' };
  if (knownKinds(tank, species).length === 0) return null;
  const range = sharedPhRange(tank, species);
  if (!range) return { standing: 'no-overlap', window: '' };
  const [lo, hi] = range;
  const window = `${lo.toFixed(1)} to ${hi.toFixed(1)}`;
  const shown = roundPh(ph);
  if (shown > hi) return { standing: 'too-high', window };
  if (shown < lo) return { standing: 'too-low', window };
  if (shown - lo < EDGE_MARGIN || hi - shown < EDGE_MARGIN)
    return { standing: 'near-edge', window };
  return { standing: 'in-range', window };
}

// Water changes do not move pH in the care contract: they halve nitrate and pull KH toward 1.
// Blackwater settles on its own near pH 6, so a high reading is waited out, not treated.
// CO2 is never part of the advice.
export function blackwaterPhGuidance(
  tank: Tank,
  species: readonly SpeciesSummary[],
  ph: number,
): PhGuidance | null {
  const a = assess(tank, species, ph);
  if (!a) return null;
  const shown = roundPh(ph).toFixed(1);
  switch (a.standing) {
    case 'no-fish':
      return {
        standing: a.standing,
        text: `pH ${shown}. Blackwater settles near pH 6 with almost no carbonate hardness, so there is no buffer to hold it steady once fish arrive.`,
      };
    case 'no-overlap':
      return {
        standing: a.standing,
        text: `pH ${shown}. The fish in this tank do not share a pH range. Check each fish card and keep only the ones that agree.`,
      };
    case 'too-high':
      return {
        standing: a.standing,
        text: `pH ${shown} is above your fish's ${a.window}. Soft blackwater drifts back toward pH 6 on its own, and a water change will not lower it, so wait and test again. CO₂ is not used in blackwater.`,
      };
    case 'too-low':
      return {
        standing: a.standing,
        text: `pH ${shown} is below your fish's ${a.window}. Nitrate acidifies soft water, so vacuum the gravel and change some water to bring it up.`,
      };
    case 'near-edge':
      return {
        standing: a.standing,
        text: `pH ${shown} is within your fish's ${a.window} but close to the edge. Soft water has little buffer, so test again after the next feed or water change.`,
      };
    case 'in-range':
      return { standing: a.standing, text: `pH ${shown} suits your fish (${a.window}).` };
  }
}

export const NO_CO2_NOTE =
  'CO₂ is not sold for blackwater tanks. With almost no carbonate hardness it would crash the pH below what these fish accept.';

export function equipmentNote(biome: Biome): string | null {
  return isBlackwater(biome) ? NO_CO2_NOTE : null;
}

export function blackwaterReportLines(tank: Tank, species: readonly SpeciesSummary[]): string[] {
  const a = assess(tank, species, tank.chemistry.ph);
  if (!a) return [];
  switch (a.standing) {
    case 'no-fish':
      return [
        'Blackwater settles near pH 6 with almost no buffer. Test the water once fish arrive.',
      ];
    case 'no-overlap':
      return ['The fish in this tank do not share a pH range. Check each fish card.'];
    case 'too-high':
      return [
        `The water is more alkaline than your fish's ${a.window}. Test it to find out how much.`,
      ];
    case 'too-low':
      return [
        `The water is more acidic than your fish's ${a.window}. Test it to find out how much.`,
      ];
    case 'near-edge':
      return [`The water is close to the edge of your fish's ${a.window} pH range. Test it.`];
    case 'in-range':
      return [`The water suits your fish's ${a.window} pH range.`];
  }
}
