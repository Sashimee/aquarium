import { z } from 'zod';
import { timestampSchema, unitSchema } from './common.js';

export const fishStageSchema = z.enum(['fry', 'juvenile', 'adult']);
export type FishStage = z.infer<typeof fishStageSchema>;

export const personalitySchema = z.strictObject({
  boldness: unitSchema,
  greed: unitSchema,
  sociability: unitSchema,
});
export type Personality = z.infer<typeof personalitySchema>;

export const NEUTRAL_PERSONALITY: Personality = { boldness: 0.5, greed: 0.5, sociability: 0.5 };

export const diseaseKindSchema = z.enum(['ich', 'fin-rot', 'velvet']);
export type DiseaseKind = z.infer<typeof diseaseKindSchema>;

export const diseaseStateSchema = z.strictObject({
  kind: diseaseKindSchema,
  since: timestampSchema,
  severity: unitSchema,
  treatedUntil: timestampSchema.nullable().describe('end of the running medicine dose, if any'),
});
export type DiseaseState = z.infer<typeof diseaseStateSchema>;

export const MAX_MEDICINE_DOSES = 3;

export const medicinePotencySchema = z.enum(['standard', 'premium']);
export type MedicinePotency = z.infer<typeof medicinePotencySchema>;

export const medicineSchema = z.strictObject({
  kind: diseaseKindSchema.describe('the disease this medicine acts on'),
  potency: medicinePotencySchema,
  doses: z
    .int()
    .min(0)
    .max(MAX_MEDICINE_DOSES)
    .describe(
      'doses in the water; more than one is an overdose and poisons every fish, 0 is the residue a water change leaves of a single dose',
    ),
  until: timestampSchema.describe('when the course ends and the medicine is gone'),
});
export type Medicine = z.infer<typeof medicineSchema>;

export const VISIT_WINDOW_DAYS = 14;
