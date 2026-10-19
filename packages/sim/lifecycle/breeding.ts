import type { Breeding, FishSex, SpeciesLifecycle } from '@aquarium/shared';
import {
  BREEDING_CHANCE_PER_STEP,
  BREEDING_DEFAULT_MAX_HUNGER,
  BREEDING_DEFAULT_MIN_HEALTH,
  MAX_YOUNG_FRACTION,
} from './params.ts';
import type { LifecycleFish, LifecycleState, SpeciesTable } from './types.ts';

const DAY_MS = 86_400_000;

export type BreedingTable = ReadonlyMap<string, Breeding>;

export interface BreedingEnvironment {
  readonly temperatureC: number;
  readonly hasCave: boolean;
  /** Fish, fry and invertebrates together (PLAN 9.1). */
  readonly maxAnimals: number;
  readonly bioloadCapacity: number;
  readonly newId: () => string;
}

export interface BreedingContext {
  readonly nowMs: number;
  readonly species: SpeciesTable;
  readonly breeding: BreedingTable;
  readonly environment: BreedingEnvironment;
}

export interface BirthRecord {
  readonly fishId: string;
  readonly parentId: string;
  readonly species: string;
  readonly bornAtMs: number;
}

/** Deterministic uniform value in [0, 1): the lifecycle is pure, so "chance" is a hash of the step. */
export function unitHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

const brooderSex = (b: Breeding): FishSex => (b.mode === 'mouthbrooder' ? 'male' : 'female');

export function stageAt(fish: LifecycleFish, b: Breeding, nowMs: number): LifecycleFish['stage'] {
  if (!b.fryGrowth || fish.stage === 'adult') return fish.stage;
  const ageDays = (nowMs - fish.bornAtMs) / DAY_MS;
  if (ageDays >= b.fryGrowth.adultAfterDays) return 'adult';
  if (ageDays >= b.fryGrowth.juvenileAfterDays) return 'juvenile';
  return fish.stage;
}

/**
 * Species with no `fryGrowth` timeline have no age at which they mature, so a juvenile bought from
 * the shop becomes an adult once it has grown to this fraction of the species' full size.
 */
export const JUVENILE_ADULT_SIZE_FRACTION = 0.8;

export function stageBySize(
  fish: LifecycleFish,
  spec: SpeciesLifecycle | undefined,
): LifecycleFish['stage'] {
  if (!spec || fish.stage !== 'juvenile') return fish.stage;
  return fish.size >= spec.maxSizeM * JUVENILE_ADULT_SIZE_FRACTION ? 'adult' : fish.stage;
}

function conditionsMet(
  fish: LifecycleFish,
  b: Breeding,
  spec: SpeciesLifecycle,
  water: LifecycleState['water'],
  ctx: BreedingContext,
): boolean {
  const { nowMs, environment } = ctx;
  if (!fish.alive || fish.stage !== 'adult') return false;
  if (b.minAgeDays === undefined || b.intervalDays === undefined) return false;
  if (nowMs - fish.bornAtMs < b.minAgeDays * DAY_MS) return false;
  if (fish.lastBroodAtMs !== null && nowMs - fish.lastBroodAtMs < b.intervalDays * DAY_MS) {
    return false;
  }
  if (fish.health < (b.minHealth ?? BREEDING_DEFAULT_MIN_HEALTH)) return false;
  if (fish.hunger > (b.maxHunger ?? BREEDING_DEFAULT_MAX_HUNGER)) return false;
  if (water.ammonia > spec.ammoniaTolerance) return false;
  if (b.temperatureC) {
    const [lo, hi] = b.temperatureC;
    if (environment.temperatureC < lo || environment.temperatureC > hi) return false;
  }
  return !b.needsCave || environment.hasCave;
}

export function stepBreeding(
  state: LifecycleState,
  ctx: BreedingContext,
): { state: LifecycleState; births: BirthRecord[] } {
  const { nowMs, environment } = ctx;
  const grown = state.fish.map((f) => {
    const b = ctx.breeding.get(f.species);
    if (!f.alive || !b) return f;
    const stage = b.fryGrowth ? stageAt(f, b, nowMs) : stageBySize(f, ctx.species.get(f.species));
    return stage === f.stage ? f : { ...f, stage };
  });

  const births: BirthRecord[] = [];
  const newborns: LifecycleFish[] = [];
  const brooded = new Map<string, number>();

  const maxBioload = (speciesId: string): number => ctx.species.get(speciesId)?.bioload ?? 0;
  const living = grown.filter((f) => f.alive);
  let animals = living.length;
  let young = living.filter((f) => f.stage !== 'adult').length;
  let load = living.reduce((sum, f) => sum + maxBioload(f.species), 0);
  const youngCap = Math.floor(environment.maxAnimals * MAX_YOUNG_FRACTION);

  const candidates = grown.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const parent of candidates) {
    const b = ctx.breeding.get(parent.species);
    const spec = ctx.species.get(parent.species);
    if (!b || !spec || b.mode === 'none' || !b.broodSize || !b.fryGrowth) continue;
    if (b.needsPair && parent.sex !== brooderSex(b)) continue;
    if (!conditionsMet(parent, b, spec, state.water, ctx)) continue;
    if (b.needsPair) {
      const mateSex: FishSex = brooderSex(b) === 'male' ? 'female' : 'male';
      const hasMate = grown.some(
        (m) =>
          m.species === parent.species &&
          m.sex === mateSex &&
          m.alive &&
          m.stage === 'adult' &&
          nowMs - m.bornAtMs >= (b.minAgeDays ?? 0) * DAY_MS,
      );
      if (!hasMate) continue;
    }
    if (unitHash(`${parent.id}:${nowMs}:chance`) >= BREEDING_CHANCE_PER_STEP) continue;

    const [lo, hi] = b.broodSize;
    const wanted = lo + Math.floor(unitHash(`${parent.id}:${nowMs}:size`) * (hi - lo + 1));
    let born = 0;
    while (
      born < wanted &&
      animals < environment.maxAnimals &&
      young < youngCap &&
      load + spec.bioload <= environment.bioloadCapacity + 1e-9
    ) {
      const id = environment.newId();
      newborns.push({
        id,
        species: parent.species,
        bornAtMs: nowMs,
        size: spec.birthSizeM,
        hunger: 0,
        health: 1,
        alive: true,
        diedAtMs: null,
        cause: null,
        sex: unitHash(`${parent.id}:${nowMs}:sex:${born}`) < 0.5 ? 'male' : 'female',
        stage: 'fry',
        lastBroodAtMs: null,
      });
      births.push({ fishId: id, parentId: parent.id, species: parent.species, bornAtMs: nowMs });
      born++;
      animals++;
      young++;
      load += spec.bioload;
    }
    if (born > 0) brooded.set(parent.id, nowMs);
  }

  if (births.length === 0 && grown.every((f, i) => f === state.fish[i])) {
    return { state, births };
  }
  const fish = grown.map((f) => {
    const at = brooded.get(f.id);
    return at === undefined ? f : { ...f, lastBroodAtMs: at };
  });
  return { state: { ...state, fish: [...fish, ...newborns] }, births };
}
