import { tankLengthRefusal, TANK_SIZES, type Economy } from '@aquarium/shared';
import { BUNDLED_ECONOMY } from './bundledEconomy';
import type {
  AwaySummary,
  CauseOfDeath,
  Fish,
  Memorial,
  SpeciesSummary,
  Tank,
  TankSize,
  Water,
} from '@aquarium/shared';
import { blackwaterReportLines } from './blackwater';
import { speciesNameMap, type SpeciesNames } from './speciesNames';
import { salinityNotice } from './salinityCare';
import {
  BIOLOAD_CAPACITY_BY_SIZE,
  hasCapacityFor,
  isAnimalCapReached,
} from '@aquarium/sim/lifecycle';

export { speciesNameMap, type SpeciesNames } from './speciesNames';

export function speciesName(names: SpeciesNames, id: string): string {
  return names.get(id)?.toLowerCase() ?? id.replaceAll('-', ' ');
}

export const CAUSE_TEXT: Record<CauseOfDeath, string> = {
  starvation: 'went too long without food',
  ammonia: 'was poisoned by ammonia in the water',
  nitrite: 'was poisoned by nitrite in the water',
  disease: 'died of an illness',
  water_quality: 'could not cope with the water chemistry',
  old_age: 'died of old age after a full life',
  unknown: 'died of a cause we could not tell',
};

const CAUSE_ADVICE: Record<CauseOfDeath, string> = {
  starvation: 'A little food each day keeps hunger away.',
  ammonia: 'Vacuuming the gravel and changing some water keeps ammonia down.',
  nitrite: 'Changing some water brings nitrite down while the filter catches up.',
  disease: 'Catching illness early and keeping the water clean helps.',
  water_quality:
    'Check the water test: pH, hardness, salinity and temperature must suit the species.',
  old_age: 'Nothing could have been done.',
  unknown: '',
};

export function deathSentence(name: string, species: string, cause: CauseOfDeath): string {
  return `${name} the ${species} ${CAUSE_TEXT[cause]}.`;
}

export function deathAdvice(cause: CauseOfDeath): string {
  return CAUSE_ADVICE[cause];
}

export const MIN_AWAY_MINUTES = 60;

export function shouldShowAway(away: AwaySummary | undefined | null): away is AwaySummary {
  if (!away) return false;
  return (
    away.deaths.length > 0 ||
    (away.births?.length ?? 0) > 0 ||
    away.elapsedMinutes >= MIN_AWAY_MINUTES
  );
}

/** Live fry the server added that the player did not buy: the brood that was just born. */
export function newborns(added: readonly Fish[], acclimateNew: boolean): Fish[] {
  if (acclimateNew) return [];
  return added.filter((f) => f.status === 'alive' && f.stage === 'fry');
}

export function birthSentence(brood: readonly Fish[], names: SpeciesNames): string {
  const first = brood[0];
  if (!first) throw new Error('birthSentence needs at least one newborn fish');
  const species = speciesName(names, first.species);
  if (brood.length === 1) return `A ${species} fry was born. Say hello to ${first.name}.`;
  const sameSpecies = brood.every((f) => f.species === first.species);
  return sameSpecies
    ? `${brood.length} ${species} fry were born.`
    : `${brood.length} fry were born.`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export interface AwayReport {
  title: string;
  lines: string[];
  deaths: { fishId: string; sentence: string; advice: string }[];
  tone: 'calm' | 'loss';
}

/** Renders the server's offline catch-up verbatim; nothing here is predicted on the client. */
export function describeAway(away: AwaySummary, names: SpeciesNames): AwayReport {
  const lines = [`You were away for ${formatDuration(away.elapsedMinutes)}.`];
  if (away.capped) {
    lines.push('The tank is simulated for at most 60 days, however long you stayed away.');
  }
  const deaths = away.deaths.map((d) => ({
    fishId: d.fishId,
    sentence: deathSentence(d.name, speciesName(names, d.species), d.cause),
    advice: deathAdvice(d.cause),
  }));
  const born = away.births?.length ?? 0;
  if (born > 0) lines.push(born === 1 ? 'One fry was born.' : `${born} fry were born.`);
  if (deaths.length === 0) lines.push('Everyone is still alive.');
  else {
    lines.push(
      deaths.length === 1
        ? 'One fish died while you were gone.'
        : `${deaths.length} fish died while you were gone.`,
    );
  }
  return {
    title: deaths.length > 0 ? 'We are sorry' : 'Welcome back',
    lines,
    deaths,
    tone: deaths.length > 0 ? 'loss' : 'calm',
  };
}

export function deadFish(tank: Tank): Fish[] {
  return tank.fish.filter((f) => f.status === 'dead');
}

export function livingFish(tank: Tank): Fish[] {
  return tank.fish.filter((f) => f.status === 'alive');
}

export interface NetStep {
  fish: Fish;
  prompt: string;
  confirmLabel: string;
}

export function netPrompt(fish: Fish, names: SpeciesNames): NetStep {
  if (fish.status !== 'dead' || !fish.cause) {
    throw new Error(`netPrompt needs a dead fish, got ${fish.name} (${fish.status})`);
  }
  const sentence = deathSentence(fish.name, speciesName(names, fish.species), fish.cause);
  return {
    fish,
    prompt: `${sentence} Net ${fish.name} and add them to the memorial?`,
    confirmLabel: `Net ${fish.name}`,
  };
}

export function lifespanDays(bornAt: string, diedAt: string): number {
  return Math.max(0, Math.floor((Date.parse(diedAt) - Date.parse(bornAt)) / 86_400_000));
}

export function memorialLine(m: Memorial, names: SpeciesNames): string {
  const days = lifespanDays(m.bornAt, m.diedAt);
  const lived = days === 0 ? 'less than a day' : days === 1 ? '1 day' : `${days} days`;
  return `${m.fishName}, ${speciesName(names, m.species)}. Lived ${lived}, died ${m.diedAt.slice(0, 10)}: ${CAUSE_TEXT[m.cause]}.`;
}

export interface Capacity {
  usedBioload: number;
  capacity: number;
  livingFish: number;
  maxFish: number;
}

export function tankCapacity(tank: Tank, species: readonly SpeciesSummary[]): Capacity {
  const bioload = new Map(species.map((s) => [s.id, s.lifecycle.bioload]));
  const living = livingFish(tank);
  return {
    usedBioload: living.reduce((sum, f) => sum + (bioload.get(f.species) ?? 0), 0),
    capacity: BIOLOAD_CAPACITY_BY_SIZE[tank.size],
    livingFish: living.length,
    maxFish: TANK_SIZES[tank.size].maxAnimals,
  };
}

const SIZE_NAME: Record<TankSize, string> = {
  nano30: 'Nano',
  standard: 'Standard',
  std200: 'Medium',
  long300: 'Long',
};

export const TANK_SIZE_ORDER: readonly TankSize[] = ['nano30', 'standard', 'std200', 'long300'];

export function tankSizeShort(size: TankSize): string {
  return `${SIZE_NAME[size]} ${TANK_SIZES[size].litres} L`;
}

export function tankSizeLabel(size: TankSize): string {
  const spec = TANK_SIZES[size];
  return `${SIZE_NAME[size]}, ${spec.litres} L, ${spec.dimensions.length.toFixed(1)} m long (up to ${spec.maxAnimals} animals, load ${BIOLOAD_CAPACITY_BY_SIZE[size]})`;
}

export type ShopVerdict = { ok: true } | { ok: false; reason: string };

export function canBuy(
  tank: Tank,
  candidate: SpeciesSummary,
  all: readonly SpeciesSummary[],
  economy: Economy = BUNDLED_ECONOMY,
): ShopVerdict {
  if (candidate.biome !== tank.biome) {
    return { ok: false, reason: `${candidate.commonName} needs a ${candidate.biome} tank.` };
  }
  const tooShort = tankLengthRefusal(economy, candidate.id, tank, candidate.commonName);
  if (tooShort !== undefined) return { ok: false, reason: tooShort };
  const bioload = new Map(all.map((s) => [s.id, s.lifecycle.bioload]));
  const existing = tank.fish.map((f) => ({
    alive: f.status === 'alive',
    maxBioload: bioload.get(f.species) ?? 0,
  }));
  const capacity = BIOLOAD_CAPACITY_BY_SIZE[tank.size];
  const maxAnimals = TANK_SIZES[tank.size].maxAnimals;
  if (hasCapacityFor(existing, candidate.lifecycle.bioload, capacity, maxAnimals)) {
    return { ok: true };
  }
  const advice = 'Start another tank for more fish.';
  if (isAnimalCapReached(existing, maxAnimals)) {
    return {
      ok: false,
      reason: `This tank is full: it holds at most ${maxAnimals} animals. ${advice}`,
    };
  }
  return {
    ok: false,
    reason: `This tank is full: ${candidate.commonName} would push the water load past ${capacity}. ${advice}`,
  };
}

export const ACCLIMATION_SECONDS = 45;

export const FOOD_LEFTOVER_VACUUM_AT = 3;

export type WaterQuality = 'good' | 'fair' | 'poor';

export interface WaterReport {
  ammonia: WaterQuality;
  nitrate: WaterQuality;
  algae: WaterQuality;
  leftoverFood: WaterQuality;
  needsVacuum: boolean;
}

const DEFAULT_AMMONIA_TOLERANCE = 0.1;

function rate(value: number, fair: number, poor: number): WaterQuality {
  return value >= poor ? 'poor' : value >= fair ? 'fair' : 'good';
}

export function waterReport(
  water: Water,
  tank: Tank,
  species: readonly SpeciesSummary[],
): WaterReport {
  const tolerance = new Map(species.map((s) => [s.id, s.lifecycle.ammoniaTolerance]));
  const strictest = livingFish(tank).reduce(
    (min, f) => Math.min(min, tolerance.get(f.species) ?? DEFAULT_AMMONIA_TOLERANCE),
    Number.POSITIVE_INFINITY,
  );
  const limit = Number.isFinite(strictest) ? strictest : DEFAULT_AMMONIA_TOLERANCE;
  return {
    ammonia: rate(water.ammonia, limit * 0.4, limit * 0.8),
    nitrate: rate(water.nitrate, 15, 30),
    algae: rate(water.algae, 0.4, 0.75),
    leftoverFood: rate(water.uneatenFood, FOOD_LEFTOVER_VACUUM_AT, 8),
    needsVacuum: water.uneatenFood >= FOOD_LEFTOVER_VACUUM_AT,
  };
}

function hungerWord(hunger: number): string {
  if (hunger >= 0.75) return 'starving';
  if (hunger >= 0.5) return 'hungry';
  if (hunger >= 0.25) return 'peckish';
  return 'well fed';
}

export function tankReportLines(tank: Tank, species: readonly SpeciesSummary[]): string[] {
  const names = speciesNameMap(species);
  const living = livingFish(tank);
  const dead = deadFish(tank);
  const water = waterReport(tank.water, tank, species);
  const lines = [
    `${tank.name}, a ${tank.biome} tank.`,
    living.length === 0
      ? 'No fish are alive in this tank.'
      : `${living.length} fish alive: ${living
          .map((f) => `${f.name} the ${speciesName(names, f.species)}, ${hungerWord(f.hunger)}`)
          .join('; ')}.`,
  ];
  if (dead.length > 0) {
    lines.push(
      `${dead.map((f) => f.name).join(', ')} ${dead.length === 1 ? 'has' : 'have'} died and can be netted.`,
    );
  }
  lines.push(
    `Water: ammonia ${water.ammonia}, nitrate ${water.nitrate}, algae ${water.algae}, leftover food ${water.leftoverFood}.`,
  );
  if (water.needsVacuum) lines.push('Leftover food is building up. Vacuum the gravel.');
  lines.push(...blackwaterReportLines(tank, species));
  const salinity = salinityNotice(tank, species);
  if (salinity) lines.push(salinity.text);
  return lines;
}
