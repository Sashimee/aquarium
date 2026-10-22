import type { SpeciesSummary, Tank } from '@aquarium/shared';
import { padsFor } from './waterTest';

export type SalinitySeverity = 'caution' | 'danger';

export interface SalinityNotice {
  direction: 'low' | 'high';
  severity: SalinitySeverity;
  ppt: number;
  speciesIds: string[];
  text: string;
}

/** Mirrors stress.fullStressDeviation.salinity in content/chemistry.json: the gap at which stress is total. */
export const FULL_STRESS_PPT = 5;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function salinityNotice(
  tank: Tank,
  species: readonly SpeciesSummary[],
): SalinityNotice | null {
  if (!padsFor(tank.biome).includes('salinity')) return null;
  const ppt = tank.chemistry.salinity;
  const byId = new Map(species.map((s) => [s.id, s]));
  const off = new Map<string, { gap: number; name: string; low: boolean }>();
  for (const fish of tank.fish.filter((f) => f.status === 'alive')) {
    const kind = byId.get(fish.species);
    if (!kind) continue;
    const [lo, hi] = kind.chemistry.salinityPpt;
    if (ppt < lo) off.set(kind.id, { gap: lo - ppt, name: kind.commonName, low: true });
    else if (ppt > hi) off.set(kind.id, { gap: ppt - hi, name: kind.commonName, low: false });
  }
  if (off.size === 0) return null;
  const entries = [...off.entries()];
  const worst = entries.reduce((a, b) => (b[1].gap > a[1].gap ? b : a));
  const direction = worst[1].low ? 'low' : 'high';
  const names = entries
    .filter(([, o]) => o.low === worst[1].low)
    .map(([, o]) => o.name.toLowerCase())
    .sort();
  const reading = `${ppt.toFixed(1)} ppt`;
  const text =
    direction === 'low'
      ? `The water is too fresh for ${joinNames(names)} at ${reading}. Test the water and watch their health.`
      : `The water is too salty for ${joinNames(names)} at ${reading}. Test the water and watch their health.`;
  return {
    direction,
    severity: worst[1].gap >= FULL_STRESS_PPT ? 'danger' : 'caution',
    ppt,
    speciesIds: entries.map(([id]) => id).sort(),
    text,
  };
}
