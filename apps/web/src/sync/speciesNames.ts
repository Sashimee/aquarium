import type { SpeciesSummary } from '@aquarium/shared';

export type SpeciesNames = ReadonlyMap<string, string>;

export function speciesNameMap(species: readonly SpeciesSummary[]): SpeciesNames {
  return new Map(species.map((s) => [s.id, s.commonName]));
}
