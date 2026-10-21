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
import { equipmentSchema, lightScheduleSchema } from './equipment.js';
import { QUARANTINE_TANK_SIZE, tankSizeSchema } from './tankSize.js';
import {
  idempotencyKeySchema,
  ledgerEntrySchema,
  purchasableStageSchema,
  walletSchema,
} from './economy.js';
import {
  diseaseStateSchema,
  medicineSchema,
  fishStageSchema,
  personalitySchema,
  VISIT_WINDOW_DAYS,
} from './fishState.js';

// Response objects are non-strict so a tab on an older bundle ignores fields added later.
export const waterSchema = z.object({
  ammonia: z.number().nonnegative(),
  nitrate: z.number().nonnegative(),
  algae: unitSchema,
  uneatenFood: z.number().nonnegative().describe('portions of food on the substrate or drifting'),
});
export type Water = z.infer<typeof waterSchema>;

export const waterParametersSchema = z.strictObject({
  foodDecayMinutes: z.number().positive(),
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
  'water_quality',
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
  fromAt: timestampSchema
    .optional()
    .describe(
      'where the offline catch-up started: pass it as `since` to the replay route. Read the tank first: the read runs the catch-up and writes the events, so a replay called before it sees nothing of the absence',
    ),
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
  shared: z.boolean().describe('whether a public link is active'),
  inGallery: z.boolean().describe('listed in the tank of the week gallery; needs an active link'),
  shareToken: shareTokenSchema
    .nullable()
    .describe('only in the response that enabled or rotated the link, null on every other read'),
  decorLayout: decorLayoutResponseSchema,
  // false: the player never saved a layout, so decorLayout is [] and the client shows the biome preset.
  // true: decorLayout is what the player saved, and [] means they emptied the tank.
  decorEdited: z.boolean(),
  backgroundId: backgroundIdSchema,
  water: waterSchema,
  lastTickAt: timestampSchema,
  chemistry: chemistrySchema,
  equipment: equipmentSchema,
  recentVisitDays: z
    .number()
    .int()
    .min(0)
    .max(VISIT_WINDOW_DAYS)
    .describe(
      'distinct UTC days in the last VISIT_WINDOW_DAYS on which the owner opened this tank',
    ),
  medicine: medicineSchema
    .nullable()
    .optional()
    .describe('the medicine running in this tank, null or absent when there is none'),
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
    idempotencyKey: idempotencyKeySchema
      .optional()
      .describe(
        'required when the tank costs Pearls: every display tank after the first, any size but standard',
      ),
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
    light: lightScheduleSchema.optional().describe('free: the lamp schedule and intensity'),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.decorLayout !== undefined ||
      v.backgroundId !== undefined ||
      v.light !== undefined,
    'nothing to update',
  );
export type UpdateTankRequest = z.infer<typeof updateTankRequestSchema>;

export const addFishRequestSchema = z.strictObject({
  species: slugSchema,
  name: z.string().trim().min(1).max(40),
  stage: purchasableStageSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type AddFishRequest = z.infer<typeof addFishRequestSchema>;

export const sellFryResponseSchema = z.strictObject({
  tank: tankSchema,
  wallet: walletSchema,
  entry: ledgerEntrySchema,
});
export type SellFryResponse = z.infer<typeof sellFryResponseSchema>;

export const tankListSchema = z.array(tankSchema);
