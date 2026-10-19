import { z } from 'zod';
import { backgroundIdSchema } from './backgrounds.js';
import {
  biomeSchema,
  playableBiomeSchema,
  decorLayoutResponseSchema,
  decorLayoutSchema,
  idSchema,
  slugSchema,
  timestampSchema,
  unitSchema,
} from './common.js';
import { chemistrySchema } from './chemistry.js';
import { equipmentSchema } from './equipment.js';
import { QUARANTINE_TANK_SIZE, tankSizeSchema } from './tankSize.js';
import { diseaseStateSchema, fishStageSchema, personalitySchema } from './fishState.js';

// Response objects are non-strict so a tab on an older bundle ignores fields added later.
export const waterSchema = z.object({
  ammonia: z.number().nonnegative(),
  nitrate: z.number().nonnegative(),
  algae: unitSchema,
  uneatenFood: z.number().nonnegative().describe('portions of food on the substrate or drifting'),
});
export type Water = z.infer<typeof waterSchema>;

export const waterParametersSchema = z.strictObject({
  filterRemovalPerHour: z.number().nonnegative(),
  foodDecayMinutes: z.number().positive(),
  nitratePerHour: z.number().nonnegative(),
  ammoniaPerPortion: z.number().nonnegative(),
  algaePerHour: z.number().nonnegative(),
});
export type WaterParameters = z.infer<typeof waterParametersSchema>;

export const fishSexSchema = z.enum(['male', 'female']);
export type FishSex = z.infer<typeof fishSexSchema>;

export const fishStatusSchema = z.enum(['alive', 'dead']);
export const causeOfDeathSchema = z.enum([
  'starvation',
  'ammonia',
  'nitrite',
  'disease',
  'old_age',
  'unknown',
]);
export type CauseOfDeath = z.infer<typeof causeOfDeathSchema>;

export const fishSchema = z.object({
  id: idSchema,
  tankId: idSchema,
  species: slugSchema,
  name: z.string().trim().min(1).max(40),
  sex: fishSexSchema,
  stage: fishStageSchema,
  personality: personalitySchema,
  disease: diseaseStateSchema.nullable(),
  bornAt: timestampSchema,
  size: z.number().positive().describe('body length in metres'),
  hunger: unitSchema,
  health: unitSchema,
  status: fishStatusSchema,
  diedAt: timestampSchema.nullable(),
  cause: causeOfDeathSchema.nullable(),
});
export type Fish = z.infer<typeof fishSchema>;

export const memorialSchema = z.object({
  id: idSchema,
  tankId: idSchema,
  fishName: z.string(),
  species: slugSchema,
  bornAt: timestampSchema,
  diedAt: timestampSchema,
  cause: causeOfDeathSchema,
});
export type Memorial = z.infer<typeof memorialSchema>;

export const awaySummarySchema = z.object({
  elapsedMinutes: z.int().nonnegative(),
  capped: z.boolean(),
  deaths: z.array(
    z.object({
      fishId: idSchema,
      name: z.string(),
      species: slugSchema,
      cause: causeOfDeathSchema,
      diedAt: timestampSchema,
    }),
  ),
  births: z
    .array(
      z.object({
        fishId: idSchema,
        parentId: idSchema,
        name: z.string(),
        species: slugSchema,
        bornAt: timestampSchema,
      }),
    )
    .optional(),
});
export type AwaySummary = z.infer<typeof awaySummarySchema>;

export const shareTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe('256 random bits, base64url');

export const tankSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(60),
  biome: biomeSchema,
  size: tankSizeSchema,
  quarantine: z.boolean().describe('the one nano tank kept apart for new fish and treatment'),
  shareToken: shareTokenSchema.nullable().describe('null while the tank is private'),
  decorLayout: decorLayoutResponseSchema,
  // false: the player never saved a layout, so decorLayout is [] and the client shows the biome preset.
  // true: decorLayout is what the player saved, and [] means they emptied the tank.
  decorEdited: z.boolean(),
  backgroundId: backgroundIdSchema,
  water: waterSchema,
  lastTickAt: timestampSchema,
  chemistry: chemistrySchema,
  equipment: equipmentSchema,
  fish: z.array(fishSchema),
  memorials: z.array(memorialSchema),
  away: awaySummarySchema.optional(),
});
export type Tank = z.infer<typeof tankSchema>;

export const createTankRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    biome: playableBiomeSchema,
    size: tankSizeSchema.default('standard'),
    quarantine: z.boolean().default(false),
  })
  .refine((v) => !v.quarantine || v.size === QUARANTINE_TANK_SIZE, {
    message: 'a quarantine tank is always nano30',
    path: ['size'],
  });
export type CreateTankRequest = z.input<typeof createTankRequestSchema>;

export const updateTankRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60).optional(),
    decorLayout: decorLayoutSchema.optional(),
    backgroundId: backgroundIdSchema.nullable().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.decorLayout !== undefined || v.backgroundId !== undefined,
    'nothing to update',
  );
export type UpdateTankRequest = z.infer<typeof updateTankRequestSchema>;

export const addFishRequestSchema = z.strictObject({
  species: slugSchema,
  name: z.string().trim().min(1).max(40),
});
export type AddFishRequest = z.infer<typeof addFishRequestSchema>;

export const tankListSchema = z.array(tankSchema);
