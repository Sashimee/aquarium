import { z } from 'zod';
import { backgroundIdSchema } from './backgrounds.js';
import { roomIdSchema } from './rooms.js';
import { biomeSchema, decorLayoutResponseSchema, timestampSchema } from './common.js';
import { chemistrySchema } from './chemistry.js';
import { equipmentSchema } from './equipment.js';
import { fishSchema, waterSchema } from './tank.js';
import { tankSizeSchema } from './tankSize.js';

export const REACTION_KINDS = ['heart', 'star', 'wow'] as const;
export const reactionKindSchema = z.enum(REACTION_KINDS);
export type ReactionKind = z.infer<typeof reactionKindSchema>;

export const reactionCountsSchema = z.object({
  heart: z.int().nonnegative(),
  star: z.int().nonnegative(),
  wow: z.int().nonnegative(),
});
export type ReactionCounts = z.infer<typeof reactionCountsSchema>;

export const setReactionRequestSchema = z.strictObject({ kind: reactionKindSchema });
export type SetReactionRequest = z.infer<typeof setReactionRequestSchema>;

export const reactionStateSchema = z.object({
  reactions: reactionCountsSchema,
  myReaction: reactionKindSchema.nullable().describe('null when signed out or not reacted'),
});
export type ReactionState = z.infer<typeof reactionStateSchema>;

export const PUBLIC_NAME_FALLBACK = 'Untitled tank';

// No ids, no owner, no email, no handle: a visitor sees a tank, not an account.
export const publicFishSchema = fishSchema
  .omit({ id: true, tankId: true })
  .extend({ seed: z.int().min(0).max(0xffffffff).describe('stable per-fish sim seed') });
export type PublicFish = z.infer<typeof publicFishSchema>;

export const publicTankSchema = reactionStateSchema.extend({
  name: z.string().min(1).max(60).describe(`word-filtered, ${PUBLIC_NAME_FALLBACK} when blocked`),
  biome: biomeSchema,
  size: tankSizeSchema,
  seed: z.int().min(0).max(0xffffffff).describe('stable tank sim seed'),
  backgroundId: backgroundIdSchema,
  roomId: roomIdSchema
    .nullable()
    .describe('the owner room, shown read-only; viewing it grants nothing'),
  decorLayout: decorLayoutResponseSchema,
  decorEdited: z.boolean().describe('false while the owner never edited the decor'),
  water: waterSchema,
  chemistry: chemistrySchema,
  equipment: equipmentSchema,
  fish: z.array(publicFishSchema),
  snapshotAt: timestampSchema.describe('the last time the owner tank was stepped'),
});
export type PublicTank = z.infer<typeof publicTankSchema>;
