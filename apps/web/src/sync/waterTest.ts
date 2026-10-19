import type { Biome, SpeciesSummary, Tank } from '@aquarium/shared';
import { livingFish } from './life';

export type PadId = 'ph' | 'ammonia' | 'nitrite' | 'nitrate' | 'kh' | 'salinity';

export type Hazard = 'safe' | 'caution' | 'danger';

export interface ChartStep {
  value: number;
  colour: string;
  hazard: Hazard;
}

export interface PadSpec {
  id: PadId;
  label: string;
  unit: string;
  decimals: number;
  steps: readonly ChartStep[];
}

const step = (value: number, colour: string, hazard: Hazard = 'safe'): ChartStep => ({
  value,
  colour,
  hazard,
});

// Colour ramps follow the look of common dip strips; the numbers are the sim's own units.
export const PADS: Readonly<Record<PadId, PadSpec>> = {
  ph: {
    id: 'ph',
    label: 'pH',
    unit: '',
    decimals: 1,
    steps: [
      step(5, '#e9d24a'),
      step(5.5, '#f0b23d'),
      step(6, '#f09a3a'),
      step(6.5, '#e8784a'),
      step(7, '#d9605f'),
      step(7.5, '#c24f78'),
      step(8, '#a2457f'),
      step(8.5, '#7e3f86'),
      step(9, '#5b3a86'),
    ],
  },
  ammonia: {
    id: 'ammonia',
    label: 'Ammonia',
    unit: 'ppm',
    decimals: 2,
    steps: [
      step(0, '#e6e48a'),
      step(0.05, '#c9d86a'),
      step(0.1, '#a5cc58', 'caution'),
      step(0.25, '#7fb84f', 'caution'),
      step(0.5, '#4f9f4a', 'danger'),
      step(1, '#2f8147', 'danger'),
    ],
  },
  nitrite: {
    id: 'nitrite',
    label: 'Nitrite',
    unit: 'ppm',
    decimals: 2,
    steps: [
      step(0, '#f2d6dc'),
      step(0.1, '#eab7c8'),
      step(0.25, '#de93b4', 'caution'),
      step(0.5, '#cc6fa0', 'caution'),
      step(1, '#b04a8e', 'danger'),
      step(2, '#8a2f78', 'danger'),
    ],
  },
  nitrate: {
    id: 'nitrate',
    label: 'Nitrate',
    unit: 'ppm',
    decimals: 0,
    steps: [
      step(0, '#f7e6c8'),
      step(10, '#f2c98f'),
      step(20, '#ec9f6c', 'caution'),
      step(40, '#e0714f', 'caution'),
      step(80, '#c9473f', 'danger'),
      step(160, '#a02a35', 'danger'),
    ],
  },
  kh: {
    id: 'kh',
    label: 'KH (carbonate hardness)',
    unit: 'dKH',
    decimals: 0,
    steps: [
      step(0, '#e8d86a'),
      step(3, '#b9cc6a'),
      step(6, '#7fb38a'),
      step(10, '#4f9a9a'),
      step(15, '#3c7ca8'),
      step(20, '#2f5c9a'),
    ],
  },
  salinity: {
    id: 'salinity',
    label: 'Salinity',
    unit: 'ppt',
    decimals: 0,
    steps: [
      step(0, '#dfe8f2'),
      step(10, '#b6d0e6'),
      step(20, '#86b4d6'),
      step(30, '#5b97c6'),
      step(35, '#3f7fb4'),
      step(40, '#2e659c'),
    ],
  },
};

const BASE_PADS: readonly PadId[] = ['ph', 'ammonia', 'nitrite', 'nitrate', 'kh'];
const SALT_BIOMES: ReadonlySet<Biome> = new Set<Biome>(['reef', 'mangrove']);

export const padsFor = (biome: Biome): readonly PadId[] =>
  SALT_BIOMES.has(biome) ? [...BASE_PADS, 'salinity'] : BASE_PADS;

export type Offscale = 'below' | 'above' | null;

export interface PadReading {
  id: PadId;
  stepIndex: number;
  colour: string;
  hazard: Hazard;
  offscale: Offscale;
  value: number;
}

export type RawValues = Readonly<Partial<Record<PadId | 'temperatureC', number | undefined>>>;

export function rawValues(tank: Tank): RawValues {
  return {
    ph: tank.chemistry.ph,
    ammonia: tank.water.ammonia,
    nitrite: tank.chemistry.nitrite,
    nitrate: tank.water.nitrate,
    kh: tank.chemistry.kh,
    salinity: tank.chemistry.salinity,
    temperatureC: tank.chemistry.temperatureC,
  };
}

// A tie goes to the higher step, so a value on a boundary is never under-reported.
export function nearestStep(steps: readonly ChartStep[], value: number): number {
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  steps.forEach((s, i) => {
    const gap = Math.abs(s.value - value);
    if (gap < bestGap || (gap === bestGap && s.value > (steps[best]?.value ?? 0))) {
      best = i;
      bestGap = gap;
    }
  });
  return best;
}

export function readPad(id: PadId, value: number | undefined): PadReading | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const { steps } = PADS[id];
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!first || !last) return null;
  const stepIndex = nearestStep(steps, value);
  const chosen = steps[stepIndex] ?? first;
  const offscale: Offscale = value < first.value ? 'below' : value > last.value ? 'above' : null;
  return { id, stepIndex, colour: chosen.colour, hazard: chosen.hazard, offscale, value };
}

export type StripResult = Readonly<Partial<Record<PadId, PadReading>>>;

export function dipStrip(biome: Biome, values: RawValues): StripResult {
  const result: Partial<Record<PadId, PadReading>> = {};
  for (const id of padsFor(biome)) {
    const reading = readPad(id, values[id]);
    if (reading) result[id] = reading;
  }
  return result;
}

export function formatStep(id: PadId, stepIndex: number): string {
  const spec = PADS[id];
  const s = spec.steps[stepIndex];
  if (!s) return 'no reading';
  const n = s.value.toFixed(spec.decimals);
  return spec.unit ? `${n} ${spec.unit}` : n;
}

export function describeReading(reading: PadReading | undefined): string {
  if (!reading) return 'no reading';
  const base = formatStep(reading.id, reading.stepIndex);
  if (reading.offscale === 'below') return `below ${base}`;
  if (reading.offscale === 'above') return `above ${base}`;
  return base;
}

export type Suitability = 'suits' | 'outside' | 'no-fish';
export type SuitKey = 'ph' | 'salinity' | 'kh' | 'temperatureC';

export function suitability(
  tank: Tank,
  species: readonly SpeciesSummary[],
  key: SuitKey,
  value: number | undefined,
): Suitability {
  const byId = new Map(species.map((s) => [s.id, s]));
  const kinds = livingFish(tank)
    .map((f) => byId.get(f.species))
    .filter((s): s is SpeciesSummary => s !== undefined);
  if (kinds.length === 0 || value === undefined || !Number.isFinite(value)) return 'no-fish';
  const fits = kinds.every(({ chemistry: c }) => {
    if (key === 'kh') return value >= c.khMin;
    const [lo, hi] = key === 'ph' ? c.phRange : key === 'salinity' ? c.salinityPpt : c.temperatureC;
    return value >= lo && value <= hi;
  });
  return fits ? 'suits' : 'outside';
}

export const HAZARD_LABEL: Record<Hazard, string> = {
  safe: 'Safe',
  caution: 'Watch it',
  danger: 'Dangerous',
};

export const SUIT_LABEL: Record<Suitability, string> = {
  suits: 'Suits your fish',
  outside: 'Outside what your fish like',
  'no-fish': 'No fish to compare with',
};

export function gradeGuess(reading: PadReading, guessIndex: number): 'exact' | 'close' | 'off' {
  const gap = Math.abs(reading.stepIndex - guessIndex);
  return gap === 0 ? 'exact' : gap === 1 ? 'close' : 'off';
}
