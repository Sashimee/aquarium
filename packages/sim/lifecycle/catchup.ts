import type { WaterParameters } from '@aquarium/shared';
import { MAX_CATCH_UP_MS, STEP_MINUTES, STEP_MS } from './params.ts';
import { stepTank } from './step.ts';
import type { DeathRecord, LifecycleState, SpeciesTable } from './types.ts';

export interface CatchUpInput {
  readonly state: LifecycleState;
  readonly fromMs: number;
  readonly toMs: number;
  readonly species: SpeciesTable;
  readonly params: WaterParameters;
  readonly graceEndsAtMs: number;
  readonly vacationFeeder: boolean;
}

export interface CatchUpResult {
  readonly state: LifecycleState;
  readonly steps: number;
  readonly elapsedMinutes: number;
  readonly capped: boolean;
  /** New last_tick_at: the end of the last whole step, or `toMs` when the cap applied. */
  readonly advancedToMs: number;
  readonly deaths: readonly DeathRecord[];
}

export function catchUp(input: CatchUpInput): CatchUpResult {
  const { fromMs, toMs } = input;
  const elapsed = Math.max(0, toMs - fromMs);
  const capped = elapsed > MAX_CATCH_UP_MS;
  const steps = Math.floor(Math.min(elapsed, MAX_CATCH_UP_MS) / STEP_MS);

  let state = input.state;
  const deaths: DeathRecord[] = [];
  for (let i = 0; i < steps; i++) {
    const startMs = fromMs + i * STEP_MS;
    const result = stepTank(state, {
      nowMs: startMs + STEP_MS,
      dtHours: STEP_MINUTES / 60,
      vacationFeeder: input.vacationFeeder,
      grace: startMs < input.graceEndsAtMs,
      species: input.species,
      params: input.params,
    });
    state = result.state;
    deaths.push(...result.deaths);
  }

  return {
    state,
    steps,
    elapsedMinutes: Math.round(Math.min(elapsed, MAX_CATCH_UP_MS) / 60_000),
    capped,
    advancedToMs: capped ? toMs : fromMs + steps * STEP_MS,
    deaths,
  };
}
