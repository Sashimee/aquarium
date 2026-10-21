import type {
  Biome,
  CauseOfDeath,
  DiseaseKind,
  Chemistry,
  ChemistryParameters,
  Equipment,
  FishSex,
  FishStage,
  MedicinePotency,
  SpeciesChemistry,
  SpeciesLifecycle,
  Water,
  WaterParameters,
} from '@aquarium/shared';

export interface FishDisease {
  readonly kind: DiseaseKind;
  readonly sinceMs: number;
  readonly severity: number;
  readonly treatedUntilMs: number | null;
}

export interface ActiveMedicine {
  readonly kind: DiseaseKind;
  readonly potency: MedicinePotency;
  readonly doses: number;
  readonly untilMs: number;
}

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
  readonly sex: FishSex;
  readonly stage: FishStage;
  readonly lastBroodAtMs: number | null;
  readonly disease: FishDisease | null;
  /** When the player bought the fish; null for fry born in the tank. Starts the new-fish disease window. */
  readonly introducedAtMs: number | null;
}

export interface LifecycleState {
  /** Ammonia and nitrate live here (the wire shape since v1); nitrite and the rest are in `chemistry`. */
  readonly water: Water;
  readonly chemistry: Chemistry;
  readonly fish: readonly LifecycleFish[];
  readonly medicine: ActiveMedicine | null;
}

export type SpeciesTable = ReadonlyMap<string, SpeciesLifecycle>;
export type SpeciesChemistryTable = ReadonlyMap<string, SpeciesChemistry>;

export interface TankEnvironment {
  readonly biome: Biome;
  readonly litres: number;
  readonly bioloadCapacity: number;
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
  /** Where the thermostat holds the water; changes only when the live stock does (see `heaterSetpoint`). */
  readonly heaterSetpointC: number;
}

export interface DeathRecord {
  readonly fishId: string;
  readonly cause: CauseOfDeath;
  readonly diedAtMs: number;
}
