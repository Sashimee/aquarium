import { MAX_MEDICINE_DOSES, type DiseaseKind, type MedicinePotency } from '@aquarium/shared';
import { unitHash } from './breeding.ts';
import { WATER_CHANGE_FRACTION } from './params.ts';
import type { ActiveMedicine, FishDisease, LifecycleFish } from './types.ts';

const HOUR_MS = 3_600_000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export interface DiseaseProfile {
  /** Severity gained per hour while untreated; 1 / this is the hours from first spots to the worst. */
  readonly progressPerHour: number;
  /** Share of a starving fish's hourly health loss that severity 1 costs. */
  readonly lossFraction: number;
  /** Hours a standard dose stays in the water. */
  readonly courseHours: number;
  /** Severity lost per hour in water with no stress, which also stops it progressing; 0 means it never clears alone. */
  readonly selfHealPerHour: number;
}

export const DISEASE_PROFILES: Readonly<Record<DiseaseKind, DiseaseProfile>> = {
  ich: { progressPerHour: 1 / 120, lossFraction: 0.3, courseHours: 96, selfHealPerHour: 0 },
  'fin-rot': {
    progressPerHour: 1 / 96,
    lossFraction: 0.25,
    courseHours: 72,
    selfHealPerHour: 1 / 240,
  },
  velvet: { progressPerHour: 1 / 72, lossFraction: 0.5, courseHours: 120, selfHealPerHour: 0 },
};

export const PREMIUM_COURSE_FACTOR = 0.5;
/** Medicine clears severity 1 in this share of its course, so a whole course always cures. */
export const CURE_COURSE_FRACTION = 0.75;
export const ONSET_SEVERITY = 0.1;
/** A sick fish spreads the disease from this severity on. */
export const CONTAGIOUS_FROM_SEVERITY = 0.15;
/** Health loss per extra dose per hour, as a share of a starving fish's loss. */
export const OVERDOSE_LOSS_FRACTION = 0.6;
export const NEW_FISH_WINDOW_MS = 7 * 86_400_000;
/** Water stress below this is the ordinary wobble of a healthy tank and never starts a disease. */
export const STRESS_DEADBAND = 0.1;
/** Ammonia and nitrite above tolerance, in tolerances; a stocked nano brushes 0.2 on a good routine. */
export const POLLUTION_DEADBAND = 0.5;

const TEMPERATURE_ICH_PER_HOUR = 0.02;
const POLLUTION_FIN_ROT_PER_HOUR = 0.015;
const CHEMISTRY_VELVET_PER_HOUR = 0.015;
const NEW_FISH_PER_HOUR = 0.0006;
const CONTAGION_PER_HOUR = 0.01;

/**
 * Invertebrates take none of the fish diseases. Kept as ids because the lifecycle block carries no
 * body plan; a test checks every id still exists in content/species.
 */
export const DISEASE_IMMUNE_SPECIES: ReadonlySet<string> = new Set([
  'cherry-shrimp',
  'cleaner-shrimp',
]);

export const courseHours = (kind: DiseaseKind, potency: MedicinePotency): number =>
  DISEASE_PROFILES[kind].courseHours * (potency === 'premium' ? PREMIUM_COURSE_FACTOR : 1);

export type KindRates = Readonly<Record<DiseaseKind, number>>;

export const NO_CONTAGION: KindRates = { ich: 0, 'fin-rot': 0, velvet: 0 };

export interface OnsetPressure {
  /** Water stress from temperature alone (ich), in units of full stress. */
  readonly temperatureStress: number;
  /** Ammonia above tolerance in tolerances, plus the nitrite factor (fin rot). */
  readonly pollution: number;
  /** Water stress from pH, salinity and hardness (velvet). */
  readonly chemistryStress: number;
  readonly newFish: boolean;
  /** Sum of the severities of the sick tank-mates, per kind. */
  readonly contagion: KindRates;
  readonly health: number;
}

/** Chance per hour, per kind, that a healthy fish falls ill. All zero in clean, settled water. */
export function onsetRates(p: OnsetPressure): KindRates {
  const susceptibility = 0.25 + 0.75 * (1 - clamp01(p.health));
  const excess = (stress: number, deadband = STRESS_DEADBAND) => Math.max(0, stress - deadband);
  const fresh = p.newFish ? NEW_FISH_PER_HOUR * susceptibility : 0;
  const spread = (kind: DiseaseKind) => CONTAGION_PER_HOUR * p.contagion[kind] * susceptibility;
  return {
    ich: TEMPERATURE_ICH_PER_HOUR * excess(p.temperatureStress) + fresh + spread('ich'),
    'fin-rot':
      POLLUTION_FIN_ROT_PER_HOUR * excess(p.pollution, POLLUTION_DEADBAND) + spread('fin-rot'),
    velvet: CHEMISTRY_VELVET_PER_HOUR * excess(p.chemistryStress) + fresh + spread('velvet'),
  };
}

export function contagionFrom(fish: readonly LifecycleFish[]): KindRates {
  const total = { ...NO_CONTAGION } as Record<DiseaseKind, number>;
  for (const f of fish) {
    if (f.alive && f.disease && f.disease.severity >= CONTAGIOUS_FROM_SEVERITY) {
      total[f.disease.kind] += f.disease.severity;
    }
  }
  return total;
}

export function isNewFish(fish: LifecycleFish, nowMs: number): boolean {
  return fish.introducedAtMs !== null && nowMs - fish.introducedAtMs < NEW_FISH_WINDOW_MS;
}

/** The kind that falls ill this step, or null. One hash per fish and step keeps it a pure function. */
export function rollOnset(
  fishId: string,
  nowMs: number,
  rates: KindRates,
  dtHours: number,
): DiseaseKind | null {
  const total = rates.ich + rates['fin-rot'] + rates.velvet;
  if (total <= 0) return null;
  const chance = Math.min(1, total * dtHours);
  const u = unitHash(`${fishId}|${nowMs}|disease`);
  if (u >= chance) return null;
  const pick = (u / chance) * total;
  if (pick < rates.ich) return 'ich';
  if (pick < rates.ich + rates['fin-rot']) return 'fin-rot';
  return 'velvet';
}

/** Share of the step `[nowMs - dt, nowMs]` during which the medicine was in the water. */
export function medicineFraction(
  medicine: ActiveMedicine | null,
  nowMs: number,
  dtHours: number,
): number {
  if (!medicine) return 0;
  return clamp01((medicine.untilMs - (nowMs - dtHours * HOUR_MS)) / (dtHours * HOUR_MS));
}

export interface DiseaseStepInput {
  readonly nowMs: number;
  readonly dtHours: number;
  readonly grace: boolean;
  readonly medicine: ActiveMedicine | null;
  readonly pressure: OnsetPressure;
  /** Total water stress; in stressed or polluted water the disease progresses faster and fin rot cannot heal. */
  readonly stress: number;
}

export interface DiseaseStep {
  readonly disease: FishDisease | null;
  /** Health lost this step to the disease, in units of a starving fish's hourly loss times `dtHours`. */
  readonly lossUnits: number;
  /** Health lost this step to a medicine overdose, same units. */
  readonly overdoseUnits: number;
}

export function stepDisease(fish: LifecycleFish, input: DiseaseStepInput): DiseaseStep {
  const { nowMs, dtHours, medicine } = input;
  const inMedicine = medicineFraction(medicine, nowMs, dtHours);
  const overdoseUnits =
    medicine && medicine.doses > 1 ? OVERDOSE_LOSS_FRACTION * (medicine.doses - 1) * inMedicine : 0;

  if (!fish.disease) {
    if (input.grace) return { disease: null, lossUnits: 0, overdoseUnits };
    const kind = rollOnset(fish.id, nowMs, onsetRates(input.pressure), dtHours);
    if (!kind) return { disease: null, lossUnits: 0, overdoseUnits };
    return {
      disease: { kind, sinceMs: nowMs, severity: ONSET_SEVERITY, treatedUntilMs: null },
      lossUnits: 0,
      overdoseUnits,
    };
  }

  const { kind, severity } = fish.disease;
  const profile = DISEASE_PROFILES[kind];
  const treated = medicine?.kind === kind ? inMedicine : 0;
  const curePerHour =
    treated > 0 && medicine ? 1 / (CURE_COURSE_FRACTION * courseHours(kind, medicine.potency)) : 0;
  const untreatedHours = dtHours * (1 - treated);
  const calm = input.stress === 0 && input.pressure.pollution === 0;
  const heals = calm && profile.selfHealPerHour > 0;
  const progress = heals ? 0 : profile.progressPerHour * (1 + input.stress * 0.5) * untreatedHours;
  const heal = heals ? profile.selfHealPerHour * untreatedHours : 0;
  const next = clamp01(severity + progress - heal - curePerHour * dtHours * treated);
  const lossUnits = severity * profile.lossFraction;

  if (next <= 0) return { disease: null, lossUnits, overdoseUnits };
  return {
    disease: {
      kind,
      sinceMs: fish.disease.sinceMs,
      severity: next,
      treatedUntilMs: medicine?.kind === kind && medicine.untilMs > nowMs ? medicine.untilMs : null,
    },
    lossUnits,
    overdoseUnits,
  };
}

/** What a water change leaves of a course: half the water, so half the time and one dose fewer. */
export function diluteMedicine(
  medicine: ActiveMedicine | null,
  nowMs: number,
): ActiveMedicine | null {
  if (!medicine || medicine.untilMs <= nowMs) return null;
  const remaining = (medicine.untilMs - nowMs) * (1 - WATER_CHANGE_FRACTION);
  return {
    ...medicine,
    doses: Math.max(1, Math.ceil(medicine.doses * (1 - WATER_CHANGE_FRACTION))),
    untilMs: nowMs + remaining,
  };
}

export interface DoseResult {
  readonly medicine: ActiveMedicine;
  readonly overdose: boolean;
}

export type DoseRefusal = 'other-medicine' | 'at-limit';

export function addDose(
  current: ActiveMedicine | null,
  kind: DiseaseKind,
  potency: MedicinePotency,
  nowMs: number,
): DoseResult | DoseRefusal {
  const active = current && current.untilMs > nowMs ? current : null;
  if (active && active.kind !== kind) return 'other-medicine';
  if (active && active.doses >= MAX_MEDICINE_DOSES) return 'at-limit';
  const doses = (active?.doses ?? 0) + 1;
  return {
    medicine: { kind, potency, doses, untilMs: nowMs + courseHours(kind, potency) * HOUR_MS },
    overdose: doses > 1,
  };
}

/** Points each sick fish's `treatedUntilMs` at the medicine now in the water. */
export function syncTreatment(fish: readonly LifecycleFish[], medicine: ActiveMedicine | null) {
  return fish.map((f) => {
    if (!f.disease) return f;
    const until = medicine?.kind === f.disease.kind ? medicine.untilMs : null;
    return until === f.disease.treatedUntilMs
      ? f
      : { ...f, disease: { ...f.disease, treatedUntilMs: until } };
  });
}
