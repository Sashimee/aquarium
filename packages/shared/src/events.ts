import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

export const foodTypeSchema = z.enum([
  'flakes',
  'pellets',
  'bloodworms',
  'brine-shrimp',
  'nori',
  'algae-wafer',
]);
export type FoodType = z.infer<typeof foodTypeSchema>;

export const feedEventSchema = z.strictObject({
  type: z.literal('feed'),
  food: foodTypeSchema,
  portion: z.number().positive().max(10),
});

export const waterChangeEventSchema = z.strictObject({ type: z.literal('water_change') });
export const gravelVacuumEventSchema = z.strictObject({ type: z.literal('gravel_vacuum') });
export const algaeScrapeEventSchema = z.strictObject({ type: z.literal('algae_scrape') });

export const careActionSchema = z.discriminatedUnion('type', [
  feedEventSchema,
  waterChangeEventSchema,
  gravelVacuumEventSchema,
  algaeScrapeEventSchema,
]);
export type CareAction = z.infer<typeof careActionSchema>;

export const ateReportSchema = z.strictObject({
  fishId: idSchema,
  portion: z.number().positive().max(10),
  at: timestampSchema,
});
export type AteReport = z.infer<typeof ateReportSchema>;

export const ateBatchRequestSchema = z.strictObject({
  reports: z.array(ateReportSchema).min(1).max(200),
});
export type AteBatchRequest = z.infer<typeof ateBatchRequestSchema>;

export const careEventKindSchema = z.enum([
  'feed',
  'water_change',
  'gravel_vacuum',
  'algae_scrape',
  'ate',
  'death',
]);

export const careEventSchema = z.strictObject({
  id: idSchema,
  tankId: idSchema,
  kind: careEventKindSchema,
  payload: z.record(z.string(), z.unknown()),
  at: timestampSchema,
});
export type CareEvent = z.infer<typeof careEventSchema>;
