import type { WaterAlertMetric } from '@aquarium/shared';
import {
  stepBreeding,
  type BirthRecord,
  type BreedingEnvironment,
  type BreedingTable,
} from './breeding.ts';
import { crewCleanup, type CleanupSurfaces, type CrewMember } from '../src/crew.ts';
import type { SimSpecies } from '../src/species.ts';
import { HUNGER_PER_PORTION, MAX_CATCH_UP_MS, STEP_MINUTES, STEP_MS } from './params.ts';
import { stepCorals, type CoralState, type CoralTable } from './corals.ts';
import {
  stepPlants,
  type Obstacle,
  type PlantBounds,
  type PlantState,
  type PlantTable,
} from './plants.ts';
import { stepTank } from './step.ts';
import {
  appendCapped,
  detectTransitions,
  initialFlags,
  type TimelineEntry,
  type TimelineFlags,
} from './timeline.ts';
import { heaterSetpoint, lampIsOn } from './water.ts';
import type { DeathRecord, LifecycleState, TankEnvironment } from './types.ts';

/**
 * The clean-up crew's offline model. Only species in `species` take part. Live crew tallies from a
 * running client must not be applied over a span this catch-up covers, or the cleaning counts twice.
 */
export interface CatchUpCrew {
  readonly species: ReadonlyMap<string, SimSpecies>;
  readonly surfaces: CleanupSurfaces;
}

/** The planting's offline model; `state` is already reconciled with the decor layout. */
export interface CatchUpPlants {
  readonly table: PlantTable;
  readonly state: readonly PlantState[];
  readonly bounds: PlantBounds;
  readonly obstacles: readonly Obstacle[];
}

/** The reef's offline model; `state` is already reconciled with the decor layout. */
export interface CatchUpCorals {
  readonly table: CoralTable;
  readonly state: readonly CoralState[];
}

export interface CatchUpInput extends TankEnvironment {
  readonly state: LifecycleState;
  readonly fromMs: number;
  readonly toMs: number;
  readonly graceEndsAtMs: number;
  readonly vacationFeeder: boolean;
  readonly breeding: BreedingTable;
  readonly breedingEnvironment: Omit<BreedingEnvironment, 'temperatureC'>;
  readonly crew?: CatchUpCrew;
  readonly plants?: CatchUpPlants;
  readonly corals?: CatchUpCorals;
}

export interface CatchUpResult {
  readonly state: LifecycleState;
  readonly plants: readonly PlantState[];
  readonly corals: readonly CoralState[];
  readonly steps: number;
  readonly elapsedMinutes: number;
  readonly capped: boolean;
  /** New last_tick_at: the end of the last whole step, or `toMs` when the cap applied. */
  readonly advancedToMs: number;
  readonly deaths: readonly DeathRecord[];
  readonly births: readonly BirthRecord[];
  readonly timeline: readonly TimelineEntry[];
  readonly setpointComputations: number;
}

export function catchUp(input: CatchUpInput): CatchUpResult {
  const { fromMs, toMs } = input;
  const elapsed = Math.max(0, toMs - fromMs);
  const capped = elapsed > MAX_CATCH_UP_MS;
  const steps = Math.floor(Math.min(elapsed, MAX_CATCH_UP_MS) / STEP_MS);
  // A capped absence simulates its last 60 days, so every timestamp lands just before now.
  const simFromMs = capped ? toMs - steps * STEP_MS : fromMs;

  let state = input.state;
  let plants: readonly PlantState[] = input.plants?.state ?? [];
  let corals: readonly CoralState[] = input.corals?.state ?? [];
  const deaths: DeathRecord[] = [];
  const births: BirthRecord[] = [];
  const timeline: TimelineEntry[] = [];
  let flags: TimelineFlags = initialFlags(state);
  const openAlerts = new Set<WaterAlertMetric>();
  const computeSetpoint = () =>
    heaterSetpoint(state.fish, input.biome, input.speciesChemistry, input.chemistryParams);
  let setpointComputations = 1;
  let setpoint = computeSetpoint();
  for (let i = 0; i < steps; i++) {
    const startMs = simFromMs + i * STEP_MS;
    const result = stepTank(state, {
      nowMs: startMs + STEP_MS,
      dtHours: STEP_MINUTES / 60,
      vacationFeeder: input.vacationFeeder,
      grace: startMs < input.graceEndsAtMs,
      biome: input.biome,
      litres: input.litres,
      bioloadCapacity: input.bioloadCapacity,
      equipment: input.equipment,
      species: input.species,
      speciesChemistry: input.speciesChemistry,
      params: input.params,
      chemistryParams: input.chemistryParams,
      ...(input.maxFishLengthM !== undefined && { maxFishLengthM: input.maxFishLengthM }),
      heaterSetpointC: setpoint,
    });
    const crewCleaned = cleanStep(result.state, input, startMs + STEP_MS);
    let cleaned = crewCleaned;
    if (input.plants) {
      const grown = stepPlants(plants, crewCleaned.water, {
        nowMs: startMs + STEP_MS,
        dtHours: STEP_MINUTES / 60,
        litres: input.litres,
        equipment: input.equipment,
        table: input.plants.table,
        bounds: input.plants.bounds,
        obstacles: input.plants.obstacles,
      });
      plants = grown.plants;
      cleaned = { ...crewCleaned, water: grown.water };
    }
    if (input.corals) {
      corals = stepCorals(corals, cleaned.chemistry, {
        nowMs: startMs + STEP_MS,
        dtHours: STEP_MINUTES / 60,
        equipment: input.equipment,
        table: input.corals.table,
      });
    }
    const bred = stepBreeding(cleaned, {
      nowMs: startMs + STEP_MS,
      species: input.species,
      breeding: input.breeding,
      environment: {
        ...input.breedingEnvironment,
        temperatureC: cleaned.chemistry.temperatureC,
      },
    });
    state = bred.state;
    const seen = detectTransitions(state, flags, startMs + STEP_MS);
    flags = seen.flags;
    appendCapped(timeline, openAlerts, seen.entries);
    deaths.push(...result.deaths);
    births.push(...bred.births);
    if (result.deaths.length > 0 || bred.births.length > 0) {
      setpoint = computeSetpoint();
      setpointComputations++;
    }
  }

  return {
    state,
    plants,
    corals,
    steps,
    elapsedMinutes: Math.round(Math.min(elapsed, MAX_CATCH_UP_MS) / 60_000),
    capped,
    advancedToMs: simFromMs + steps * STEP_MS,
    deaths,
    births,
    timeline,
    setpointComputations,
  };
}

function cleanStep(state: LifecycleState, input: CatchUpInput, nowMs: number): LifecycleState {
  const crew = input.crew;
  if (!crew) return state;
  const members: CrewMember[] = [];
  for (const f of state.fish) {
    if (f.alive && crew.species.has(f.species)) {
      members.push({
        id: f.id,
        species: f.species,
        alive: true,
        bodyLengthM: f.size,
        hunger: f.hunger,
      });
    }
  }
  if (members.length === 0) return state;
  const { light } = input.equipment;
  const cleaned = crewCleanup({
    crew: members,
    species: crew.species,
    algae: state.water.algae,
    uneatenFood: state.water.uneatenFood,
    ...(state.water.uneatenFoodTypes ? { uneatenFoodTypes: state.water.uneatenFoodTypes } : {}),
    dtHours: STEP_MINUTES / 60,
    litFraction: lampIsOn(nowMs, STEP_MINUTES / 60, light.onHour, light.offHour) ? 1 : 0,
    surfaces: crew.surfaces,
  });
  const eaten = new Map(cleaned.perFish.map((s) => [s.id, s.food]));
  return {
    ...state,
    water: {
      ...state.water,
      algae: Math.max(0, state.water.algae - cleaned.algaeGrazed),
      uneatenFood: Math.max(0, state.water.uneatenFood - cleaned.foodEaten),
    },
    fish: state.fish.map((f) => {
      const food = eaten.get(f.id);
      return food === undefined
        ? f
        : { ...f, hunger: Math.max(0, f.hunger - food * HUNGER_PER_PORTION) };
    }),
  };
}
