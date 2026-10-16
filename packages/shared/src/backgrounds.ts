import { z } from 'zod';
import { biomeSchema, slugSchema, type Biome } from './common.js';

// content/backgrounds/<biome>.json lists the same ids; backgrounds.test.ts keeps both in step.
// Ids name slots and stay fixed even when the picture in a slot changes.
// Adding a biome means adding its list here and its file there.
export const BACKGROUND_IDS = {
  freshwater: [
    'bg-fw-planted-stream',
    'bg-fw-root-tangle',
    'bg-fw-rocky-riverbed',
    'bg-fw-misty-lake',
    'bg-fw-plant-wall',
  ],
  reef: [
    'bg-reef-coral-wall',
    'bg-reef-light-rays',
    'bg-reef-fish-slope',
    'bg-reef-soft-coral',
    'bg-reef-deep-blue',
  ],
} as const satisfies Record<Biome, readonly [string, ...string[]]>;

export const backgroundIdSchema = z.enum([...BACKGROUND_IDS.freshwater, ...BACKGROUND_IDS.reef]);
export type BackgroundId = z.infer<typeof backgroundIdSchema>;

export const DEFAULT_BACKGROUND_ID: Record<Biome, BackgroundId> = {
  freshwater: BACKGROUND_IDS.freshwater[0],
  reef: BACKGROUND_IDS.reef[0],
};

export function isBackgroundForBiome(biome: Biome, id: string): id is BackgroundId {
  return (BACKGROUND_IDS[biome] as readonly string[]).includes(id);
}

// file is null until the picture is sourced; once present, credit and licence are required.
export const backgroundEntrySchema = z
  .strictObject({
    id: slugSchema,
    biome: biomeSchema,
    title: z.string().trim().min(1).max(60),
    file: z.string().min(1).nullable(),
    credit: z.string().min(1).nullable(),
    licence: z.string().min(1).nullable(),
  })
  .refine((b) => b.file === null || (b.credit !== null && b.licence !== null), {
    message: 'a background with a file needs a credit and a licence',
    path: ['credit'],
  });
export type BackgroundEntry = z.infer<typeof backgroundEntrySchema>;

export const backgroundFileSchema = z.array(backgroundEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((e, index) => {
    if (seen.has(e.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate id "${e.id}"`, path: [index, 'id'] });
    }
    seen.add(e.id);
  });
});
