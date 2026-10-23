import { z } from 'zod';
import { idSchema, slugSchema, timestampSchema } from './common.js';
import { idempotencyKeySchema } from './economy.js';
import { diseaseKindSchema, fishStageSchema } from './fishState.js';
import { fishSexSchema, tankSchema } from './tank.js';
import { handleFormatSchema, handleSchema } from './wordFilter.js';

export const GIFT_OFFER_TTL_HOURS = 72;
export const GIFT_MAX_OPEN_SENT = 5;
export const GIFT_MAX_OPEN_RECEIVED = 10;
export const GIFT_SETTLED_VISIBLE_DAYS = 7;

export const giftStatusSchema = z
  .enum(['open', 'countered', 'accepted', 'declined', 'cancelled', 'expired'])
  .describe(
    'open: waiting for the recipient. countered: a trade where the recipient pledged a fish and the sender must confirm. accepted, declined, cancelled and expired are final.',
  );
export type GiftStatus = z.infer<typeof giftStatusSchema>;

export const giftRoleSchema = z.enum(['sender', 'recipient']);
export type GiftRole = z.infer<typeof giftRoleSchema>;

export const giftFishSchema = z.strictObject({
  id: idSchema,
  species: slugSchema,
  name: z.string().describe('the owner name, or the species name when it fails the word filter'),
  sex: fishSexSchema,
  stage: fishStageSchema,
  size: z.number().positive().describe('body length in metres'),
  health: z.number().min(0).max(1),
  disease: diseaseKindSchema.nullable().describe('the kind of the disease it carries, if any'),
});
export type GiftFish = z.infer<typeof giftFishSchema>;

export const giftOfferSchema = z.strictObject({
  id: idSchema,
  status: giftStatusSchema,
  role: giftRoleSchema.describe('what the caller is in this offer'),
  counterpart: handleFormatSchema
    .nullable()
    .describe('the other player by handle; null once their account is gone'),
  fish: giftFishSchema.describe('the sender fish, held in escrow while the offer is open'),
  wantsReturn: z.boolean().describe('true for a trade: the recipient must pledge a fish back'),
  pledged: giftFishSchema
    .nullable()
    .describe(
      'the fish the recipient pledged (status countered); null when none, or when it is no longer available. It stays in the recipient tank until the sender confirms.',
    ),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  settledAt: timestampSchema.nullable(),
});
export type GiftOffer = z.infer<typeof giftOfferSchema>;

// Opt-in: gifts are private by default. A tank receives gifted or traded fish only while its
// acceptsGifts flag is on (PATCH /api/tanks/:id { acceptsGifts }, default false). Receiving is
// gated; sending is not, because it only moves the sender's own fish. Hence: creating an offer is
// 409 gifts_closed unless the recipient has at least one opted-in tank, accept is 409 gifts_closed
// when toTankId is not opted in, and confirm is 409 gifts_closed when the sender's toTankId is not
// opted in. The flag is checked again at accept and confirm time, so switching it off takes effect
// for offers already waiting.
//
// A gift or trade offer. The sender's fish leaves their tank and is held in escrow until the offer
// settles. Addressing is by public handle only; an unknown handle is a 404, and no address is ever
// returned. The offer expires GIFT_OFFER_TTL_HOURS after it is made.
//
// POST /api/gifts: 201 { offer, tank } where tank is the sender tank without the fish. The fish
// must be in fromTankId (404 otherwise). Refusals: 400 for the caller's own handle, 409 fish_dead,
// 429 rate_limited, 409 too_many_offers (GIFT_MAX_OPEN_SENT open offers made, or
// GIFT_MAX_OPEN_RECEIVED waiting for that recipient), 409 key_reused. A retry with the same
// idempotencyKey replays the first answer (200) before any rate limit is charged.
export const createGiftRequestSchema = z.strictObject({
  fromTankId: idSchema,
  fishId: idSchema,
  toHandle: handleSchema,
  wantsReturn: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateGiftRequest = z.input<typeof createGiftRequestSchema>;

export const createGiftResponseSchema = z.strictObject({
  offer: giftOfferSchema,
  tank: tankSchema,
});
export type CreateGiftResponse = z.infer<typeof createGiftResponseSchema>;

export const giftListResponseSchema = z
  .strictObject({
    incoming: z.array(giftOfferSchema),
    outgoing: z.array(giftOfferSchema),
  })
  .describe(
    'GET /api/gifts: the caller offers, newest first; open and countered ones plus final ones settled within GIFT_SETTLED_VISIBLE_DAYS. Offers past their expiry are settled first, so the fish is back with its sender.',
  );
export type GiftListResponse = z.infer<typeof giftListResponseSchema>;

export const giftArrivalSchema = z
  .strictObject({
    fishId: idSchema,
    tankId: idSchema,
    stress: z
      .number()
      .min(0)
      .describe('0 comfortable, 1 full stress, from the tank chemistry model'),
  })
  .describe(
    'a fish arriving by gift or trade: introducedAt restarts, so the new-fish disease window applies, and the client shows the acclimation bag while it releases the fish. The fish keeps no age credit or debt: age is wall-clock and keeps running while it is in escrow.',
  );
export type GiftArrival = z.infer<typeof giftArrivalSchema>;

// POST /api/gifts/:id/accept: the recipient takes the offer. toTankId is the recipient tank that
// receives the fish: it must match the species biome (409 wrong_biome) and have room (409
// tank_full). For a gift (wantsReturn false) the fish arrives now, status accepted, and
// returnFishId is a 400. For a trade returnFishId is required: one of the recipient living fish,
// status becomes countered and nothing moves until the sender confirms. A retry with the same
// idempotencyKey replays (200). Another key on a settled offer is 409 offer_closed; past expiry it
// is 409 offer_expired and the fish goes back to the sender. Anyone but the recipient: 404.
export const acceptGiftRequestSchema = z.strictObject({
  toTankId: idSchema,
  returnFishId: idSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type AcceptGiftRequest = z.infer<typeof acceptGiftRequestSchema>;

export const acceptGiftResponseSchema = z.strictObject({
  offer: giftOfferSchema,
  tank: tankSchema.describe('the recipient tank that holds or will hold the gifted fish'),
  arrival: giftArrivalSchema.nullable().describe('null while a trade waits for the sender'),
});
export type AcceptGiftResponse = z.infer<typeof acceptGiftResponseSchema>;

// POST /api/gifts/:id/confirm: the sender completes a countered trade. toTankId is the sender
// tank that receives the pledged fish (same biome and capacity checks, both directions). Both fish
// swap in one step. 409 offer_closed unless the offer is countered, 409 fish_unavailable if the
// pledged fish died or left the recipient. Only the sender; anyone else is 404.
export const confirmGiftRequestSchema = z.strictObject({
  toTankId: idSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ConfirmGiftRequest = z.infer<typeof confirmGiftRequestSchema>;

export const confirmGiftResponseSchema = z.strictObject({
  offer: giftOfferSchema,
  tank: tankSchema.describe('the sender tank that received the pledged fish'),
  arrival: giftArrivalSchema,
});
export type ConfirmGiftResponse = z.infer<typeof confirmGiftResponseSchema>;

// POST /api/gifts/:id/decline (recipient) and POST /api/gifts/:id/cancel (sender): settle the
// offer as declined or cancelled and put the escrowed fish back in its sender tank. Repeating the
// same call on the offer it already settled that way replays (200); on an offer settled any other
// way it is 409 offer_closed. A third party gets 404. Cancel also answers with the sender tank.
export const declineGiftResponseSchema = z.strictObject({ offer: giftOfferSchema });
export type DeclineGiftResponse = z.infer<typeof declineGiftResponseSchema>;

export const cancelGiftResponseSchema = z.strictObject({
  offer: giftOfferSchema,
  tank: tankSchema,
});
export type CancelGiftResponse = z.infer<typeof cancelGiftResponseSchema>;
