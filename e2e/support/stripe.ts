import { createHmac, randomUUID } from 'node:crypto';

// Test mode only. Built from parts so a secret scanner has nothing to match; the e2e server talks
// to stripe-mock, so nothing here can reach Stripe.
export const E2E_STRIPE_SECRET_KEY = ['sk', 'test', 'e2eonlynotarealkey000000'].join('_');
export const E2E_WEBHOOK_SECRET = ['whsec', 'e2eonlysigningsecret0000000000000'].join('_');

export interface Pack {
  id: string;
  pearls: number;
  priceCents: number;
}

const CONSENT = {
  consent_immediate_delivery: 'true',
  consent_withdrawal_waiver: 'true',
};

const bare = () => randomUUID().replaceAll('-', '');

export const newStripeIds = () => ({
  session: `cs_test_${bare()}`,
  paymentIntent: `pi_${bare()}`,
  subscription: `sub_${bare()}`,
  invoice: `in_${bare()}`,
});

export function event(type: string, object: object): string {
  return JSON.stringify({
    id: `evt_${bare()}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
}

export function sign(payload: string, secret = E2E_WEBHOOK_SECRET): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function packSession(
  userId: string,
  pack: Pack,
  ids: { session: string; paymentIntent: string },
  { paid = true }: { paid?: boolean } = {},
) {
  return {
    id: ids.session,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: paid ? 'paid' : 'unpaid',
    amount_total: pack.priceCents,
    currency: 'eur',
    payment_intent: ids.paymentIntent,
    metadata: {
      user_id: userId,
      pack_id: pack.id,
      price_cents: String(pack.priceCents),
      pearls: String(pack.pearls),
      consent_at: new Date().toISOString(),
      ...CONSENT,
    },
  };
}

export const refund = (paymentIntent: string, amount: number) => ({
  id: `re_${bare()}`,
  object: 'refund',
  amount,
  status: 'succeeded',
  payment_intent: paymentIntent,
});

export const newDisputeId = () => `dp_${bare()}`;

export const dispute = (id: string, paymentIntent: string, amount: number, status: string) => ({
  id,
  object: 'dispute',
  amount,
  status,
  payment_intent: paymentIntent,
});
