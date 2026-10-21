import { z } from 'zod';
import { backgroundIdSchema } from './backgrounds.js';
import { biomeSchema, timestampSchema } from './common.js';
import { tankSizeSchema } from './tankSize.js';

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
// 1970-01-01 was a Thursday, so the first Monday 00:00 UTC is day 4.
const FIRST_MONDAY_MS = 4 * DAY_MS;

// Weeks run Monday 00:00 UTC (inclusive) to the next Monday 00:00 UTC (exclusive).
export function galleryWeekStart(atMs: number): string {
  const weeks = Math.floor((atMs - FIRST_MONDAY_MS) / WEEK_MS);
  return new Date(FIRST_MONDAY_MS + weeks * WEEK_MS).toISOString();
}

export function galleryWeekEnd(weekStart: string): string {
  return new Date(Date.parse(weekStart) + WEEK_MS).toISOString();
}

export const GALLERY_PAGE_SIZE = 24;
export const GALLERY_MAX_PAGE_SIZE = 50;
export const GALLERY_WINNER_HISTORY = 12;

export const galleryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(GALLERY_MAX_PAGE_SIZE).default(GALLERY_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type GalleryQuery = z.infer<typeof galleryQuerySchema>;

// `id` is the tank id: it opens GET /api/gallery/:id only while the tank is shared and names the
// tank in the vote routes. It never identifies an owner.
export const galleryTankSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(60).describe('word-filtered'),
  biome: biomeSchema,
  size: tankSizeSchema,
  backgroundId: backgroundIdSchema,
  fishCount: z.int().nonnegative().describe('living animals'),
});
export type GalleryTank = z.infer<typeof galleryTankSchema>;

export const galleryEntrySchema = galleryTankSchema.extend({
  votes: z.int().nonnegative().describe('votes this week'),
  mine: z.boolean().describe('the viewer owns this tank, so cannot vote for it'),
  voted: z.boolean().describe('the viewer voted for this tank this week'),
});
export type GalleryEntry = z.infer<typeof galleryEntrySchema>;

export const galleryResponseSchema = z.object({
  weekStart: timestampSchema,
  weekEnd: timestampSchema,
  total: z.int().nonnegative(),
  entries: z.array(galleryEntrySchema),
  myVote: z.uuid().nullable().describe('tank the viewer voted for this week; null if none'),
});
export type GalleryResponse = z.infer<typeof galleryResponseSchema>;

export const voteRequestSchema = z.strictObject({ tankId: z.uuid() });
export type VoteRequest = z.infer<typeof voteRequestSchema>;

export const voteStateSchema = z.object({
  weekStart: timestampSchema,
  weekEnd: timestampSchema,
  myVote: z.uuid().nullable(),
});
export type VoteState = z.infer<typeof voteStateSchema>;

export const galleryWinnerSchema = galleryTankSchema.extend({
  weekStart: timestampSchema,
  weekEnd: timestampSchema,
  votes: z.int().positive(),
});
export type GalleryWinner = z.infer<typeof galleryWinnerSchema>;

export const galleryWinnersResponseSchema = z.object({
  winners: z
    .array(galleryWinnerSchema)
    .describe('newest week first; tanks no longer shared are left out'),
});
export type GalleryWinnersResponse = z.infer<typeof galleryWinnersResponseSchema>;
