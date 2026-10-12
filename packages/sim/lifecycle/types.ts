import type { CauseOfDeath, SpeciesLifecycle, Water, WaterParameters } from '@aquarium/shared';

export interface LifecycleFish {
  readonly id: string;
  readonly species: string;
  readonly bornAtMs: number;
  readonly size: number;
  readonly hunger: number;
  readonly health: number;
  readonly alive: boolean;
  readonly diedAtMs: number | null;
  readonly cause: CauseOfDeath | null;
}

export interface LifecycleState {
  readonly water: Water;
  readonly fish: readonly LifecycleFish[];
}

export type SpeciesTable = ReadonlyMap<string, SpeciesLifecycle>;

export interface StepContext {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly vacationFeeder: boolean;
  readonly grace: boolean;
  readonly species: SpeciesTable;
  readonly params: WaterParameters;
}

export interface DeathRecord {
  readonly fishId: string;
  readonly cause: CauseOfDeath;
  readonly diedAtMs: number;
}
