import type { PadId, StripResult } from '../sync/waterTest';

export interface Dip {
  at: number;
  strip: StripResult;
  temperatureC: number;
  guesses: Partial<Record<PadId, number>>;
  revealed: boolean;
}

const MAX_REMEMBERED_DIPS = 20;
const dips = new Map<string, Dip>();
const listeners = new Set<() => void>();

export function getDip(tankId: string): Dip | null {
  return dips.get(tankId) ?? null;
}

export function putDip(tankId: string, dip: Dip): void {
  dips.delete(tankId);
  dips.set(tankId, dip);
  const oldest = dips.keys().next().value;
  if (dips.size > MAX_REMEMBERED_DIPS && oldest !== undefined) dips.delete(oldest);
  for (const listener of listeners) listener();
}

export function subscribeDips(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
