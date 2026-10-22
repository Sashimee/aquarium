import { z } from 'zod';
import { idSchema, slugSchema, timestampSchema } from './common.js';
import { foodTypeSchema } from './events.js';
import { idempotencyKeySchema } from './economy.js';
import { causeOfDeathSchema, tankSchema } from './tank.js';
import { handleSchema } from './wordFilter.js';

const HOUR_MS = 3_600_000;

export const COMMUNITY_FEED_PORTION_MIN = 0.1;
export const COMMUNITY_FEED_PORTION_MAX = 1;

// Per signed-in user, over a rolling window.
export const COMMUNITY_USER_FEED_QUOTA = { portions: 2, windowMs: 24 * HOUR_MS } as const;

// Across everyone, so a crowd cannot overfeed the shared fish. Sized under the tank's uneaten-food ceiling.
export const COMMUNITY_TANK_FEED_CAP = { portions: 3, windowMs: 3 * HOUR_MS } as const;

// Upkeep the server does for the shared tank, since no one owns it: dead fish are cleared after a
// while, the water is changed on a schedule, and a collapsed population is restocked from the
// starting species.
export const COMMUNITY_UPKEEP = {
  deadFishKeepMs: 6 * HOUR_MS,
  waterChangeEveryMs: 7 * 24 * HOUR_MS,
  restockBelowAlive: 6,
} as const;

export const COMMUNITY_STARTER_STOCK = [
  { species: 'neon-tetra', count: 6, label: 'Neon' },
  { species: 'harlequin-rasbora', count: 4, label: 'Rasbora' },
  { species: 'bronze-corydoras', count: 3, label: 'Cory' },
] as const;

export const COMMUNITY_MAX_STREAMS_PER_USER = 3;
export const COMMUNITY_MAX_STREAMS_PER_IP = 8;
export const COMMUNITY_MAX_STREAMS_TOTAL = 500;
export const COMMUNITY_HEARTBEAT_MS = 15_000;

export const COMMUNITY_STREAM_PATH = '/api/community/stream';

export const communityQuotaSchema = z.object({
  limit: z.number().positive().describe('portions a user may feed per window'),
  used: z.number().nonnegative(),
  remaining: z.number().nonnegative(),
  windowMs: z.int().positive(),
  resetsAt: timestampSchema
    .nullable()
    .describe('when the oldest counted feed leaves the window and frees quota; null if none used'),
});
export type CommunityQuota = z.infer<typeof communityQuotaSchema>;

// What every viewer sees and the stream pushes; nothing in it depends on who is looking.
export const communityStreamStateSchema = z.object({
  tank: tankSchema,
  viewers: z.int().nonnegative().describe('open streams on this server'),
  tankFeedRemaining: z
    .number()
    .nonnegative()
    .describe('portions the whole tank still accepts right now, from everyone together'),
  at: timestampSchema,
});
export type CommunityStreamState = z.infer<typeof communityStreamStateSchema>;

export const communityStateSchema = communityStreamStateSchema.extend({
  quota: communityQuotaSchema
    .nullable()
    .describe('null for an anonymous viewer or an unverified account, who cannot feed'),
});
export type CommunityState = z.infer<typeof communityStateSchema>;

export const communityFeedRequestSchema = z.strictObject({
  food: foodTypeSchema,
  portion: z.number().min(COMMUNITY_FEED_PORTION_MIN).max(COMMUNITY_FEED_PORTION_MAX),
  idempotencyKey: idempotencyKeySchema,
});
export type CommunityFeedRequest = z.infer<typeof communityFeedRequestSchema>;

export const communityFeedResponseSchema = z.object({
  state: communityStateSchema,
  replayed: z.boolean().describe('the idempotency key was seen before, nothing was fed again'),
});
export type CommunityFeedResponse = z.infer<typeof communityFeedResponseSchema>;

export const communityEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('feed'),
    at: timestampSchema,
    food: foodTypeSchema,
    portion: z.number().positive(),
    by: handleSchema.nullable().describe('public handle of the feeder; null when none is set'),
  }),
  z.strictObject({
    type: z.literal('death'),
    at: timestampSchema,
    fishId: idSchema,
    name: z.string(),
    species: slugSchema,
    cause: causeOfDeathSchema,
  }),
  z.strictObject({
    type: z.literal('born'),
    at: timestampSchema,
    fishId: idSchema,
    parentId: idSchema,
    name: z.string(),
    species: slugSchema,
  }),
]);
export type CommunityEvent = z.infer<typeof communityEventSchema>;

// Server-sent event names. `state` carries a CommunityStreamState and is the first frame of every
// stream and again after anything changes; `feed`, `death` and `born` carry the CommunityEvent of
// that type; `viewers` is `{ viewers: number }` and doubles as the heartbeat, sent every
// COMMUNITY_HEARTBEAT_MS, so a client that hears nothing for twice that should reconnect.
export const communityStreamEventNameSchema = z.enum(['state', 'viewers', 'feed', 'death', 'born']);
export type CommunityStreamEventName = z.infer<typeof communityStreamEventNameSchema>;

export const communityViewersSchema = z.strictObject({ viewers: z.int().nonnegative() });
export type CommunityViewers = z.infer<typeof communityViewersSchema>;
