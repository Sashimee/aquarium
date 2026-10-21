import type {
  DiseaseKind,
  Economy,
  Fish,
  Medicine,
  MedicinePotency,
  SpeciesSummary,
  Tank,
} from '@aquarium/shared';
import { addDose, courseHours } from '@aquarium/sim/lifecycle';
import { pearlText } from './economy';

// Mirrors ICH_HEAT_C in packages/sim/lifecycle/disease.ts, which the lifecycle index does not export.
const ICH_HEAT_C = 30;

export const DISEASE_KINDS: readonly DiseaseKind[] = ['ich', 'fin-rot', 'velvet'];

export const DISEASE_LABEL: Record<DiseaseKind, string> = {
  ich: 'Ich',
  'fin-rot': 'Fin rot',
  velvet: 'Velvet',
};

export const SYMPTOMS: Record<DiseaseKind, string> = {
  ich: 'tiny white spots, like grains of salt, on the body and fins',
  'fin-rot': 'ragged, frayed fins that get shorter',
  velvet: 'a fine gold dust sheen on the skin',
};

export function severityWord(severity: number): string {
  if (severity < 0.34) return 'just starting';
  if (severity < 0.67) return 'clearly sick';
  return 'very sick';
}

export function sickFish(tank: Tank, kind?: DiseaseKind): Fish[] {
  return tank.fish.filter(
    (f) =>
      f.status === 'alive' && f.disease !== null && (kind === undefined || f.disease.kind === kind),
  );
}

export function sickKinds(tank: Tank): DiseaseKind[] {
  return DISEASE_KINDS.filter((k) => sickFish(tank, k).length > 0);
}

export function liveMedicine(tank: Tank, nowMs: number): Medicine | null {
  const medicine = tank.medicine ?? null;
  return medicine !== null && Date.parse(medicine.until) > nowMs ? medicine : null;
}

export function courseDays(kind: DiseaseKind, potency: MedicinePotency): string {
  const days = courseHours(kind, potency) / 24;
  return `${Number(days.toFixed(1))} days`;
}

export function premiumPrice(economy: Economy, kind: DiseaseKind): number | null {
  return economy.items.consumables.premiumMedicine.prices[kind] ?? null;
}

export type Blocked = 'nothing-to-treat' | 'other-medicine' | 'at-limit';

export type DosePlan =
  | {
      kind: 'ok';
      overdose: boolean;
      /** The medicine this dose would end, and the fish still sick with that disease. */
      replaces: { medicine: Medicine; fish: Fish[] } | null;
    }
  | { kind: 'blocked'; reason: Blocked };

/** Applies the server's dosing rules, from the same lifecycle code, so the player is warned before the call. */
export function planDose(
  tank: Tank,
  kind: DiseaseKind,
  potency: MedicinePotency,
  nowMs: number,
): DosePlan {
  if (sickFish(tank, kind).length === 0) return { kind: 'blocked', reason: 'nothing-to-treat' };
  const current = liveMedicine(tank, nowMs);
  const dosed = addDose(
    current ? { ...current, untilMs: Date.parse(current.until) } : null,
    kind,
    potency,
    nowMs,
  );
  if (typeof dosed === 'string') return { kind: 'blocked', reason: dosed };
  const stranded = current && current.kind !== kind ? sickFish(tank, current.kind) : [];
  return {
    kind: 'ok',
    overdose: dosed.overdose,
    replaces: current && stranded.length > 0 ? { medicine: current, fish: stranded } : null,
  };
}

export function listNames(fish: readonly Fish[]): string {
  const names = fish.map((f) => f.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function switchWarning(
  replaces: { medicine: Medicine; fish: readonly Fish[] },
  next: DiseaseKind,
): string {
  const old = DISEASE_LABEL[replaces.medicine.kind].toLowerCase();
  const nextLabel = DISEASE_LABEL[next].toLowerCase();
  const verb = replaces.fish.length === 1 ? 'still has' : 'still have';
  return `${listNames(replaces.fish)} ${verb} ${old}. Switching to the ${nextLabel} medicine ends what is left of the ${old} course, so they are not cured unless you dose ${old} again later.`;
}

export const OVERDOSE_WARNING =
  'The water already holds a dose. Another dose is an overdose: it poisons every fish in the tank, sick or not, until the water is changed.';

export function blockedText(reason: Blocked): string {
  switch (reason) {
    case 'nothing-to-treat':
      return 'No living fish here has this illness, so there is nothing to treat.';
    case 'other-medicine':
      return 'A different medicine is still in the water at full strength. Change the water until only a trace is left, then switch.';
    case 'at-limit':
      return 'The water already holds the most medicine it safely can. Change the water.';
  }
}

/** The server words both of its water refusals alike, and a water change cures both. */
export function wantsWaterChange(message: string): boolean {
  return /change the water/i.test(message);
}

export function doseButtonText(
  economy: Economy,
  kind: DiseaseKind,
  potency: MedicinePotency,
): string {
  const length = courseDays(kind, potency);
  if (potency === 'standard') return `Give standard medicine (free, ${length})`;
  const price = premiumPrice(economy, kind);
  return `Give premium medicine (${price === null ? 'not for sale' : pearlText(price)}, ${length})`;
}

/** Warm water slowly clears ich, but only for fish whose comfort range reaches that heat. */
export function heatTolerantSick(tank: Tank, species: readonly SpeciesSummary[]): string[] {
  const ids = new Set(sickFish(tank, 'ich').map((f) => f.species));
  return species
    .filter((s) => ids.has(s.id) && s.chemistry.temperatureC[1] >= ICH_HEAT_C)
    .map((s) => s.commonName);
}

export function medicineLine(medicine: Medicine, nowMs: number): string {
  const hours = Math.max(0, Math.round((Date.parse(medicine.until) - nowMs) / 3_600_000));
  const left = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
  const label = DISEASE_LABEL[medicine.kind].toLowerCase();
  if (medicine.doses === 0) return `A trace of ${label} medicine is left, about ${left} more.`;
  const strength =
    medicine.doses > 1 ? `${medicine.doses} doses, an overdose` : 'one dose, the right amount';
  return `${DISEASE_LABEL[medicine.kind]} medicine is in the water (${strength}), about ${left} left.`;
}
