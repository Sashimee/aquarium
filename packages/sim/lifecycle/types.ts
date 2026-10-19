import type {
  Biome,
  CauseOfDeath,
  Chemistry,
  ChemistryParameters,
  Equipment,
  SpeciesChemistry,
  SpeciesLifecycle,
  Water,
  WaterParameters,
} from '@aquarium/shared';

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
  /** Ammonia and nitrate live here (the wire shape since v1); nitrite and the rest are in `chemistry`. */
  readonly water: Water;
  readonly chemistry: Chemistry;
  readonly fish: readonly LifecycleFish[];
}

export type SpeciesTable = ReadonlyMap<string, SpeciesLifecycle>;
export type SpeciesChemistryTable = ReadonlyMap<string, SpeciesChemistry>;

export interface TankEnvironment {
  readonly biome: Biome;
  readonly equipment: Equipment;
  readonly species: SpeciesTable;
  readonly speciesChemistry: SpeciesChemistryTable;
  readonly params: WaterParameters;
  readonly chemistryParams: ChemistryParameters;
}

export interface StepContext extends TankEnvironment {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly vacationFeeder: boolean;
  readonly grace: boolean;
}

export interface DeathRecord {
  readonly fishId: string;
  readonly cause: CauseOfDeath;
  readonly diedAtMs: number;
}
