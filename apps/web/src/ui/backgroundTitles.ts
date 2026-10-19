import {
  BACKGROUND_IDS,
  backgroundFileSchema,
  type BackgroundId,
  type Biome,
} from '@aquarium/shared';

const files = import.meta.glob<unknown>('../../../../content/backgrounds/*.json', {
  eager: true,
  import: 'default',
});

const TITLES = new Map<string, string>();
for (const raw of Object.values(files)) {
  for (const { id, title } of backgroundFileSchema.parse(raw)) TITLES.set(id, title);
}

export interface BackgroundOption {
  id: BackgroundId;
  title: string;
}

/** The biome's backgrounds in the contract's order; a biome without any gives an empty list. */
export function backgroundOptions(biome: Biome): BackgroundOption[] {
  const ids: readonly BackgroundId[] =
    (BACKGROUND_IDS as Readonly<Partial<Record<Biome, readonly BackgroundId[]>>>)[biome] ?? [];
  return ids.map((id) => {
    const title = TITLES.get(id);
    if (title === undefined) {
      throw new Error(
        `Background "${id}" has no entry in content/backgrounds; add its title there`,
      );
    }
    return { id, title };
  });
}
