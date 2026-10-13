import { speciesSchema } from '@aquarium/shared';
import type { SpeciesInput } from '@aquarium/sim';

// Content files get their render block with the fish models; the sim needs everything else.
const contentSchema = speciesSchema.partial({ render: true });

const files = import.meta.glob<unknown>('../../../../content/species/*.json', {
  eager: true,
  import: 'default',
});

const SPECIES = new Map<string, SpeciesInput>();
for (const raw of Object.values(files)) {
  const { id, behaviour, locomotion, lifecycle } = contentSchema.parse(raw);
  SPECIES.set(id, { id, behaviour, locomotion, lifecycle: { diet: lifecycle.diet } });
}

/** The sim's view of a content species, or undefined when this build has no content for it. */
export function speciesInput(id: string): SpeciesInput | undefined {
  return SPECIES.get(id);
}
