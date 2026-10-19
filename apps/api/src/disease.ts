import {
  diseaseStateSchema,
  medicineSchema,
  type DiseaseState,
  type Medicine,
} from '@aquarium/shared';
import type { ActiveMedicine, FishDisease } from '@aquarium/sim/lifecycle';

export function simDisease(stored: unknown): FishDisease | null {
  if (stored === null) return null;
  const d = diseaseStateSchema.parse(stored);
  return {
    kind: d.kind,
    sinceMs: Date.parse(d.since),
    severity: d.severity,
    treatedUntilMs: d.treatedUntil === null ? null : Date.parse(d.treatedUntil),
  };
}

export function wireDisease(d: FishDisease | null): DiseaseState | null {
  if (d === null) return null;
  return {
    kind: d.kind,
    since: new Date(d.sinceMs).toISOString(),
    severity: d.severity,
    treatedUntil: d.treatedUntilMs === null ? null : new Date(d.treatedUntilMs).toISOString(),
  };
}

export function simMedicine(stored: unknown): ActiveMedicine | null {
  if (stored === null) return null;
  const m = medicineSchema.parse(stored);
  return { kind: m.kind, potency: m.potency, doses: m.doses, untilMs: Date.parse(m.until) };
}

export function wireMedicine(m: ActiveMedicine | null): Medicine | null {
  if (m === null) return null;
  return {
    kind: m.kind,
    potency: m.potency,
    doses: m.doses,
    until: new Date(m.untilMs).toISOString(),
  };
}
