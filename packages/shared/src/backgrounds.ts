import { z } from 'zod';
import { playableBiomeSchema, slugSchema, type Biome, type PlayableBiome } from './common.js';

// content/backgrounds/<biome>.json lists the same ids; backgrounds.test.ts keeps both in step.
// Ids name slots and stay fixed even when the picture in a slot changes. Removing an id needs a
// migration that sets tanks.background_id to NULL on the rows that chose it, or every read of
// those tanks fails.
// A biome becomes playable by adding its list here, its file there and its name to PlayableBiome.
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
  cichlid: [
    'bg-cichlid-malawi-rock-pile',
    'bg-cichlid-rock-wall',
    'bg-cichlid-tanganyika-shell-bed',
    'bg-cichlid-rock-cave',
    'bg-cichlid-open-blue',
  ],
} as const satisfies Record<PlayableBiome, readonly [string, ...string[]]>;

export const backgroundIdSchema = z.enum([
  ...BACKGROUND_IDS.freshwater,
  ...BACKGROUND_IDS.reef,
  ...BACKGROUND_IDS.cichlid,
]);
export type BackgroundId = z.infer<typeof backgroundIdSchema>;

export const DEFAULT_BACKGROUND_ID: Record<PlayableBiome, BackgroundId> = {
  freshwater: BACKGROUND_IDS.freshwater[0],
  reef: BACKGROUND_IDS.reef[0],
  cichlid: BACKGROUND_IDS.cichlid[0],
};

export function isBackgroundForBiome(biome: Biome, id: string): id is BackgroundId {
  const ids: readonly string[] | undefined = (
    BACKGROUND_IDS as Readonly<Partial<Record<Biome, readonly string[]>>>
  )[biome];
  return ids?.includes(id) ?? false;
}

// PLAN 9.2: KTX2, one size per tier, at most 600 KB for the largest. Keys are the renderer's
// quality tiers (apps/web/src/engine/quality/tiers.ts); high and ultra share the largest size.
export const BACKGROUND_TIERS = {
  ultra: [2048, 1024],
  high: [2048, 1024],
  medium: [1024, 512],
  low: [512, 256],
} as const;
export type BackgroundTier = keyof typeof BACKGROUND_TIERS;
export const BACKGROUND_MAX_BYTES = 600 * 1000;

// Licence and credit live in assets/manifest.json; `asset` names the manifest entry.
export const backgroundEntrySchema = z
  .strictObject({
    id: slugSchema,
    biome: playableBiomeSchema,
    title: z.string().trim().min(1).max(60),
    file: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.ktx2$/, 'must be a relative .ktx2 path')
      .refine((f) => !f.includes('..'), 'must not climb out of its directory')
      .nullable(),
    asset: slugSchema.nullable(),
  })
  .superRefine((b, ctx) => {
    if (b.file !== null && b.asset === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a background with a file needs its manifest asset id',
        path: ['asset'],
      });
    }
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
