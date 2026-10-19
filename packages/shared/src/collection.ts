import { z } from 'zod';
import { biomeSchema, slugSchema, timestampSchema } from './common.js';

export const collectionEntrySchema = z.strictObject({
  species: slugSchema,
  keptAt: timestampSchema,
  bredAt: timestampSchema.nullable(),
  raisedAt: timestampSchema.nullable(),
});
export type CollectionEntry = z.infer<typeof collectionEntrySchema>;

export const collectionSpeciesSchema = z.strictObject({
  species: slugSchema,
  commonName: z.string().min(1),
  biome: biomeSchema,
  entry: collectionEntrySchema.nullable(),
});

export const collectionSchema = z.strictObject({
  species: z.array(collectionSpeciesSchema),
  kept: z.number().int().min(0),
  bred: z.number().int().min(0),
  raised: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type Collection = z.infer<typeof collectionSchema>;

export interface CollectionFacts {
  kept: number;
  bred: number;
  raised: number;
  byBiome: ReadonlyMap<string, { kept: number; total: number }>;
}

export interface AchievementDefinition {
  id: string;
  title: string;
  description: string;
  target: number;
  measure: (facts: CollectionFacts) => number;
}

const biomeComplete = (biome: string) => (facts: CollectionFacts) => {
  const tally = facts.byBiome.get(biome);
  return tally && tally.total > 0 && tally.kept >= tally.total ? 1 : 0;
};

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    id: 'first-fish',
    title: 'First fish',
    description: 'Keep your first fish.',
    target: 1,
    measure: (f) => f.kept,
  },
  {
    id: 'kept-5',
    title: 'Hobbyist',
    description: 'Keep 5 different species.',
    target: 5,
    measure: (f) => f.kept,
  },
  {
    id: 'kept-10',
    title: 'Collector',
    description: 'Keep 10 different species.',
    target: 10,
    measure: (f) => f.kept,
  },
  {
    id: 'first-fry',
    title: 'New parents',
    description: 'Breed a species for the first time.',
    target: 1,
    measure: (f) => f.bred,
  },
  {
    id: 'bred-3',
    title: 'Breeder',
    description: 'Breed 3 different species.',
    target: 3,
    measure: (f) => f.bred,
  },
  {
    id: 'first-adult',
    title: 'All grown up',
    description: 'Raise a fish from fry or juvenile to adult.',
    target: 1,
    measure: (f) => f.raised,
  },
  {
    id: 'raised-3',
    title: 'Fish farmer',
    description: 'Raise 3 different species to adult.',
    target: 3,
    measure: (f) => f.raised,
  },
  {
    id: 'complete-freshwater',
    title: 'Freshwater complete',
    description: 'Keep every freshwater species.',
    target: 1,
    measure: biomeComplete('freshwater'),
  },
  {
    id: 'complete-reef',
    title: 'Reef complete',
    description: 'Keep every reef species.',
    target: 1,
    measure: biomeComplete('reef'),
  },
];

export const achievementSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  earnedAt: timestampSchema.nullable(),
  progress: z.number().int().min(0),
  target: z.number().int().min(1),
});
export type Achievement = z.infer<typeof achievementSchema>;

export const achievementListSchema = z.strictObject({
  achievements: z.array(achievementSchema),
});
export type AchievementList = z.infer<typeof achievementListSchema>;

export function collectionFacts(
  entries: readonly CollectionEntry[],
  catalog: readonly { id: string; biome: string }[],
): CollectionFacts {
  const byId = new Map(entries.map((e) => [e.species, e]));
  const byBiome = new Map<string, { kept: number; total: number }>();
  let kept = 0;
  let bred = 0;
  let raised = 0;
  for (const { id, biome } of catalog) {
    const entry = byId.get(id);
    const tally = byBiome.get(biome) ?? { kept: 0, total: 0 };
    tally.total += 1;
    if (entry) {
      tally.kept += 1;
      kept += 1;
      if (entry.bredAt) bred += 1;
      if (entry.raisedAt) raised += 1;
    }
    byBiome.set(biome, tally);
  }
  return { kept, bred, raised, byBiome };
}
