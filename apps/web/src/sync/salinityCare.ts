import type { Biome, SpeciesSummary, Tank } from '@aquarium/shared';
import { BUNDLED_CHEMISTRY } from './bundledEconomy';

export type SalinitySeverity = 'caution' | 'danger';

export interface SalinityNotice {
  direction: 'low' | 'high';
  severity: SalinitySeverity;
  speciesIds: string[];
  text: string;
}

export const SALT_BIOMES: ReadonlySet<Biome> = new Set<Biome>(['reef', 'mangrove']);

export const FULL_STRESS_PPT = BUNDLED_CHEMISTRY.stress.fullStressDeviation.salinity;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function salinityNotice(
  tank: Tank,
  species: readonly SpeciesSummary[],
): SalinityNotice | null {
  if (!SALT_BIOMES.has(tank.biome)) return null;
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
  const severity = worst[1].gap >= FULL_STRESS_PPT ? 'danger' : 'caution';
  const lead = severity === 'danger' ? 'Dangerously' : 'Somewhat';
  const text =
    direction === 'low'
      ? `${lead} too fresh for ${joinNames(names)}. Test the water and watch their health.`
      : `${lead} too salty for ${joinNames(names)}. Test the water and watch their health.`;
  return {
    direction,
    severity,
    speciesIds: entries
      .filter(([, o]) => o.low === worst[1].low)
      .map(([id]) => id)
      .sort(),
    text,
  };
}
