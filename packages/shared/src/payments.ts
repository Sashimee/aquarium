import { z } from 'zod';
import { timestampSchema } from './common.js';
import { packSchema, subscriptionOfferSchema } from './economy.js';

// Web payments go through Stripe Checkout (PLAN 9.1, 9.2). Credit happens only from the signed
// webhook, never from the browser returning from Checkout. Without STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET the server reports payments: disabled, every route under /api/payments
// that needs Stripe answers 503 payments_disabled, and the rest of the app is unaffected.

export const paymentsStatusSchema = z.enum(['enabled', 'disabled']);
export type PaymentsStatus = z.infer<typeof paymentsStatusSchema>;

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'unavailable']),
  payments: paymentsStatusSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const checkoutConsentSchema = z
  .strictObject({
    immediateDelivery: z
      .literal(true)
      .describe('the buyer asks for the Pearls to be delivered now'),
    withdrawalWaiver: z
      .literal(true)
      .describe('the buyer acknowledges that this ends the 14-day right of withdrawal'),
  })
  .describe('both must be true; the receipt mail confirms them');
export type CheckoutConsent = z.infer<typeof checkoutConsentSchema>;

export const packCheckoutRequestSchema = z.strictObject({
  packId: packSchema.shape.id.max(64),
  consent: checkoutConsentSchema,
});
export type PackCheckoutRequest = z.infer<typeof packCheckoutRequestSchema>;

export const subscriptionCheckoutRequestSchema = z.strictObject({
  consent: checkoutConsentSchema,
});
export type SubscriptionCheckoutRequest = z.infer<typeof subscriptionCheckoutRequestSchema>;

export const checkoutResponseSchema = z.strictObject({
  url: z
    .url({ protocol: /^https$/ })
    .describe('Stripe-hosted Checkout page to send the browser to'),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

export const packsResponseSchema = z.strictObject({
  packs: z.array(packSchema),
  subscription: subscriptionOfferSchema,
});
export type PacksResponse = z.infer<typeof packsResponseSchema>;

export const adultConfirmationRequestSchema = z.discriminatedUnion('confirmed', [
  z.strictObject({
    confirmed: z.literal(true),
    password: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'the current password, as for account deletion; accounts without one (passkey only) instead need a sign-in within the last 5 minutes',
      ),
  }),
  z.strictObject({ confirmed: z.literal(false) }),
]);
export type AdultConfirmationRequest = z.infer<typeof adultConfirmationRequestSchema>;

export const subscriptionStatusSchema = z.enum([
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
  'trialing',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const clubSubscriptionSchema = z.strictObject({
  status: subscriptionStatusSchema,
  paidUntil: timestampSchema
    .nullable()
    .describe('end of the latest paid period; daily Pearls stop after it'),
  cancelAtPeriodEnd: z.boolean(),
});
export type ClubSubscription = z.infer<typeof clubSubscriptionSchema>;

export const paymentsStateSchema = z.strictObject({
  payments: paymentsStatusSchema,
  adultConfirmed: z.boolean(),
  subscription: clubSubscriptionSchema.nullable(),
});
export type PaymentsState = z.infer<typeof paymentsStateSchema>;
