import {
  stepBreeding,
  type BirthRecord,
  type BreedingEnvironment,
  type BreedingTable,
} from './breeding.ts';
import { MAX_CATCH_UP_MS, STEP_MINUTES, STEP_MS } from './params.ts';
import { stepTank } from './step.ts';
import { heaterSetpoint } from './water.ts';
import type { DeathRecord, LifecycleState, TankEnvironment } from './types.ts';

export interface CatchUpInput extends TankEnvironment {
  readonly state: LifecycleState;
  readonly fromMs: number;
  readonly toMs: number;
  readonly graceEndsAtMs: number;
  readonly vacationFeeder: boolean;
  readonly breeding: BreedingTable;
  readonly breedingEnvironment: Omit<BreedingEnvironment, 'temperatureC'>;
}

export interface CatchUpResult {
  readonly state: LifecycleState;
  readonly steps: number;
  readonly elapsedMinutes: number;
  readonly capped: boolean;
  /** New last_tick_at: the end of the last whole step, or `toMs` when the cap applied. */
  readonly advancedToMs: number;
  readonly deaths: readonly DeathRecord[];
  readonly births: readonly BirthRecord[];
  readonly setpointComputations: number;
}

export function catchUp(input: CatchUpInput): CatchUpResult {
  const { fromMs, toMs } = input;
  const elapsed = Math.max(0, toMs - fromMs);
  const capped = elapsed > MAX_CATCH_UP_MS;
  const steps = Math.floor(Math.min(elapsed, MAX_CATCH_UP_MS) / STEP_MS);

  let state = input.state;
  const deaths: DeathRecord[] = [];
  const births: BirthRecord[] = [];
  const computeSetpoint = () =>
    heaterSetpoint(state.fish, input.biome, input.speciesChemistry, input.chemistryParams);
  let setpointComputations = 1;
  let setpoint = computeSetpoint();
  for (let i = 0; i < steps; i++) {
    const startMs = fromMs + i * STEP_MS;
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
      heaterSetpointC: setpoint,
    });
    const bred = stepBreeding(result.state, {
      nowMs: startMs + STEP_MS,
      species: input.species,
      breeding: input.breeding,
      environment: {
        ...input.breedingEnvironment,
        temperatureC: result.state.chemistry.temperatureC,
      },
    });
    state = bred.state;
    deaths.push(...result.deaths);
    births.push(...bred.births);
    if (result.deaths.length > 0 || bred.births.length > 0) {
      setpoint = computeSetpoint();
      setpointComputations++;
    }
  }

  return {
    state,
    steps,
    elapsedMinutes: Math.round(Math.min(elapsed, MAX_CATCH_UP_MS) / 60_000),
    capped,
    advancedToMs: capped ? toMs : fromMs + steps * STEP_MS,
    deaths,
    births,
    setpointComputations,
  };
}
