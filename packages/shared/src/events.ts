import { z } from 'zod';
import { idSchema, slugSchema, timestampSchema } from './common.js';
import { idempotencyKeySchema } from './economy.js';
import { foodTypeSchema, type FoodType } from './food.js';
import { causeOfDeathSchema } from './tank.js';

export { foodTypeSchema, type FoodType };

export const feedEventSchema = z.strictObject({
  type: z.literal('feed'),
  food: foodTypeSchema,
  portion: z.number().positive().max(10),
});

export const waterChangeEventSchema = z.strictObject({ type: z.literal('water_change') });
export const gravelVacuumEventSchema = z.strictObject({ type: z.literal('gravel_vacuum') });
export const algaeScrapeEventSchema = z.strictObject({ type: z.literal('algae_scrape') });

export const bottledBacteriaEventSchema = z.strictObject({
  type: z.literal('bottled_bacteria'),
  idempotencyKey: idempotencyKeySchema.describe('bottled bacteria cost Pearls'),
});
export const saltDoseEventSchema = z.strictObject({ type: z.literal('salt_dose') });
export const bufferDoseEventSchema = z.strictObject({
  type: z.literal('buffer_dose'),
  idempotencyKey: idempotencyKeySchema.describe('a buffer dose costs Pearls'),
});
export const addBotanicalsEventSchema = z.strictObject({
  type: z.literal('add_botanicals'),
  idempotencyKey: idempotencyKeySchema.describe('botanicals cost Pearls'),
});
export const filterRinseEventSchema = z.strictObject({ type: z.literal('filter_rinse') });

export const careActionSchema = z.discriminatedUnion('type', [
  feedEventSchema,
  waterChangeEventSchema,
  gravelVacuumEventSchema,
  algaeScrapeEventSchema,
  bottledBacteriaEventSchema,
  filterRinseEventSchema,
  saltDoseEventSchema,
  bufferDoseEventSchema,
  addBotanicalsEventSchema,
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
  'salt_dose',
  'buffer_dose',
  'add_botanicals',
  'ate',
  'death',
  'born',
  'sick',
  'water_alert',
  'fish_moved',
]);

export const waterAlertMetricSchema = z.enum(['ammonia', 'nitrite', 'algae']);
export type WaterAlertMetric = z.infer<typeof waterAlertMetricSchema>;

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
  z.strictObject({ ...eventBase, kind: z.literal('salt_dose'), payload: emptyPayload }),
  z.strictObject({ ...eventBase, kind: z.literal('buffer_dose'), payload: emptyPayload }),
  z.strictObject({ ...eventBase, kind: z.literal('add_botanicals'), payload: emptyPayload }),
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
  z.strictObject({
    ...eventBase,
    kind: z.literal('sick'),
    payload: z.strictObject({ fishId: idSchema }),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('water_alert'),
    payload: z.strictObject({ metric: waterAlertMetricSchema, state: z.enum(['high', 'normal']) }),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('fish_moved'),
    payload: z.strictObject({
      fishId: idSchema,
      direction: z.enum(['in', 'out']),
      otherTankId: idSchema,
      key: idempotencyKeySchema.optional(),
    }),
  }),
]);
export type CareEvent = z.infer<typeof careEventSchema>;

export const REPLAY_DEFAULT_LIMIT = 200;
export const REPLAY_MAX_LIMIT = 500;

export const replayCursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/)
  .describe('opaque; pass back the nextCursor of the previous page unchanged');

export const replayQuerySchema = z.strictObject({
  since: timestampSchema.describe(
    'exclusive lower bound; use away.fromAt from the tank read, which must happen before the replay call because the read is what runs the catch-up and stores the events',
  ),
  until: timestampSchema.optional().describe('inclusive upper bound, default now'),
  cursor: replayCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(REPLAY_MAX_LIMIT).default(REPLAY_DEFAULT_LIMIT),
});
export type ReplayQuery = z.infer<typeof replayQuerySchema>;

export const replayResponseSchema = z.strictObject({
  events: z.array(careEventSchema).describe('ordered by time, then id'),
  nextCursor: replayCursorSchema.nullable().describe('null on the last page'),
});
export type ReplayResponse = z.infer<typeof replayResponseSchema>;
