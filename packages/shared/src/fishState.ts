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

export const VISIT_WINDOW_DAYS = 14;
