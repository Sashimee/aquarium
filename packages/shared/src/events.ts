import { z } from 'zod';
import { idSchema, slugSchema, timestampSchema } from './common.js';
import { causeOfDeathSchema } from './tank.js';

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

export const bottledBacteriaEventSchema = z.strictObject({ type: z.literal('bottled_bacteria') });
export const filterRinseEventSchema = z.strictObject({ type: z.literal('filter_rinse') });

export const careActionSchema = z.discriminatedUnion('type', [
  feedEventSchema,
  waterChangeEventSchema,
  gravelVacuumEventSchema,
  algaeScrapeEventSchema,
  bottledBacteriaEventSchema,
  filterRinseEventSchema,
]);
export type CareAction = z.infer<typeof careActionSchema>;

export const MIN_ATE_PORTION = 0.01;

export const ateReportSchema = z.strictObject({
  fishId: idSchema,
  portion: z.number().min(MIN_ATE_PORTION).max(10),
  at: timestampSchema,
});
export type AteReport = z.infer<typeof ateReportSchema>;

export const ateBatchRequestSchema = z.strictObject({
  // Optional so clients cached from before this field existed keep working during a deploy.
  batchId: idSchema.optional(),
  reports: z.array(ateReportSchema).min(1).max(200),
});
export type AteBatchRequest = z.infer<typeof ateBatchRequestSchema>;

export const careEventKindSchema = z.enum([
  'feed',
  'water_change',
  'gravel_vacuum',
  'algae_scrape',
  'bottled_bacteria',
  'filter_rinse',
  'ate',
  'death',
  'born',
]);

const eventBase = {
  id: idSchema,
  tankId: idSchema,
  at: timestampSchema,
};

const emptyPayload = z.strictObject({});

export const careEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...eventBase,
    kind: z.literal('feed'),
    payload: z.strictObject({ food: foodTypeSchema, portion: z.number().positive().max(10) }),
  }),
  z.strictObject({ ...eventBase, kind: z.literal('water_change'), payload: emptyPayload }),
  z.strictObject({ ...eventBase, kind: z.literal('gravel_vacuum'), payload: emptyPayload }),
  z.strictObject({ ...eventBase, kind: z.literal('algae_scrape'), payload: emptyPayload }),
  z.strictObject({ ...eventBase, kind: z.literal('bottled_bacteria'), payload: emptyPayload }),
  z.strictObject({ ...eventBase, kind: z.literal('filter_rinse'), payload: emptyPayload }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('ate'),
    payload: z.strictObject({ fishId: idSchema, portion: z.number().positive().max(10) }),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('death'),
    payload: z.strictObject({ fishId: idSchema, cause: causeOfDeathSchema }),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('born'),
    payload: z.strictObject({ fishId: idSchema, parentId: idSchema, species: slugSchema }),
  }),
]);
export type CareEvent = z.infer<typeof careEventSchema>;
