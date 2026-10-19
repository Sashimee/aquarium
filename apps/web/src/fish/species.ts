import { speciesSchema } from '@aquarium/shared';
import type { SpeciesInput } from '@aquarium/sim';
import type { SpeciesGrowth } from './maturity';

// Content files get their render block with the fish models; the sim needs everything else.
const contentSchema = speciesSchema.partial({ render: true });

const files = import.meta.glob<unknown>('../../../../content/species/*.json', {
  eager: true,
  import: 'default',
});

const SPECIES = new Map<string, SpeciesInput>();
const GROWTH = new Map<string, SpeciesGrowth>();
for (const raw of Object.values(files)) {
  const { id, behaviour, locomotion, lifecycle, breeding } = contentSchema.parse(raw);
  SPECIES.set(id, { id, behaviour, locomotion, lifecycle: { diet: lifecycle.diet } });
  GROWTH.set(id, { birthSizeM: lifecycle.birthSizeM, fryGrowth: breeding.fryGrowth });
}

/** The sim's view of a content species, or undefined when this build has no content for it. */
export function speciesInput(id: string): SpeciesInput | undefined {
  return SPECIES.get(id);
}

/** How a content species' young grow, or undefined when this build has no content for it. */
export function speciesGrowth(id: string): SpeciesGrowth | undefined {
  return GROWTH.get(id);
}

const ALL_SPECIES: readonly SpeciesInput[] = [...SPECIES.values()];

/** Every content species, so a running sim world can take in a fish of any of them. */
export function allSpeciesInputs(): readonly SpeciesInput[] {
  return ALL_SPECIES;
}
