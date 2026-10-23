import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import Stripe from 'stripe';
import { expect } from 'vitest';
import { schema } from '../db/index.ts';
import { loadEconomy } from '../economy.ts';
import { APP_ORIGIN, type Harness } from '../test-harness.ts';
import {
  createStripeProvider,
  type PaymentProvider,
  type ProviderCheckoutSession,
  type ProviderSubscription,
} from './provider.ts';

export const PASSWORD = 'correct horse battery';
export const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
export const DAY_MS = 86_400_000;
export const economy = loadEconomy();

const mockUrl = new URL(process.env['STRIPE_MOCK_URL'] ?? 'http://localhost:12111');

export interface Account {
  cookie: string;
  userId: string;
  email: string;
}

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

let counter = 0;

export async function account(h: Harness): Promise<Account> {
  const email = `t72-${Date.now()}-${counter++}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(
    await h.app.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { cookie: cookieOf(signedUp) },
    }),
  );
  if (!cookie) throw new Error('verification did not sign in');
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  return { cookie, userId: user.id, email };
}

export const call = (
  h: Harness,
  who: Account,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie: who.cookie },
    ...(payload ? { payload } : {}),
  });

export interface PaymentsKit {
  provider: PaymentProvider;
  real: PaymentProvider;
  webhookSecret: string;
  // What Stripe would answer for a subscription right now; stripe-mock is stateless.
  subscriptions: Map<string, ProviderSubscription>;
  sessions: Map<string, ProviderCheckoutSession>;
  // Provider-side effects the app asked for, as `cancel:<id>` and `refund:<invoice>`.
  effects: string[];
  failEffects: boolean;
  failRetrieval: boolean;
}

// The SDK talks to the real stripe-mock container, so request shapes are validated against
// Stripe's OpenAPI spec; the webhook secret is made per run and never leaves the process.
export function paymentsKit(wrap?: (real: PaymentProvider) => PaymentProvider): PaymentsKit {
  const webhookSecret = `whsec_${randomBytes(16).toString('hex')}`;
  const stripe = createStripeProvider({
    secretKey: `sk_test_${randomBytes(12).toString('hex')}`,
    webhookSecret,
    endpoint: {
      host: mockUrl.hostname,
      port: Number(mockUrl.port || 80),
      protocol: mockUrl.protocol === 'https:' ? 'https' : 'http',
    },
  });
  const kit = {
    real: stripe,
    webhookSecret,
    subscriptions: new Map<string, ProviderSubscription>(),
    sessions: new Map<string, ProviderCheckoutSession>(),
    effects: [] as string[],
    failEffects: false,
    failRetrieval: false,
  };
  const base: PaymentProvider = {
    ...stripe,
    retrieveSubscription: async (id) =>
      kit.subscriptions.get(id) ?? { status: 'active', cancelAtPeriodEnd: false },
    retrieveCheckoutSession: async (id) => {
      if (kit.failRetrieval) throw new Error('provider down');
      return kit.sessions.get(id) ?? null;
    },
    cancelSubscriptionNow: async (id) => {
      kit.effects.push(`cancel:${id}`);
      if (kit.failEffects) throw new Error('provider down');
    },
    refundInvoice: async (id) => {
      kit.effects.push(`refund:${id}`);
      if (kit.failEffects) throw new Error('provider down');
    },
  };
  return Object.assign(kit, { provider: wrap ? wrap(base) : base });
}

const signer = new Stripe(`sk_test_${randomBytes(12).toString('hex')}`);

export const CONSENT = {
  consent_immediate_delivery: 'true',
  consent_withdrawal_waiver: 'true',
};

export interface EventOptions {
  created?: number;
}

export function buildEvent(h: Harness, type: string, object: object, options: EventOptions = {}) {
  return {
    id: `evt_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    created: options.created ?? Math.floor(h.clock.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

export function sign(kit: PaymentsKit, payload: string): string {
  return signer.webhooks.generateTestHeaderString({ payload, secret: kit.webhookSecret });
}

export async function deliver(
  h: Harness,
  kit: PaymentsKit,
  event: object,
): Promise<LightMyRequestResponse> {
  const payload = JSON.stringify(event);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/payments/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(kit, payload) },
    payload,
  });
  await h.app.receiptsIdle();
  return res;
}

export async function deliverOk(h: Harness, kit: PaymentsKit, event: object): Promise<void> {
  const res = await deliver(h, kit, event);
  expect(res.statusCode, res.body).toBe(200);
}

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export function newIds() {
  return {
    session: id('cs_test'),
    paymentIntent: id('pi'),
    subscription: id('sub'),
    invoice: id('in'),
  };
}

export function sessionObject(
  who: Account,
  packId: string,
  ids: { session: string; paymentIntent: string },
  overrides: {
    paid?: boolean;
    amount?: number;
    at?: Date;
    promisedCents?: number;
    promisedPearls?: number;
  } = {},
) {
  const pack = economy.packs.find((p) => p.id === packId);
  if (!pack) throw new Error(`no pack ${packId}`);
  return {
    id: ids.session,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: overrides.paid === false ? 'unpaid' : 'paid',
    amount_total: overrides.amount ?? pack.priceCents,
    currency: 'eur',
    payment_intent: ids.paymentIntent,
    metadata: {
      user_id: who.userId,
      pack_id: packId,
      price_cents: String(overrides.promisedCents ?? pack.priceCents),
      pearls: String(overrides.promisedPearls ?? pack.pearls),
      consent_at: (overrides.at ?? new Date()).toISOString(),
      ...CONSENT,
    },
  };
}

export function invoiceObject(
  who: Account,
  ids: { invoice: string; subscription: string },
  period: { start: number; end: number },
  overrides: { amount?: number; reason?: string } = {},
) {
  return {
    id: ids.invoice,
    object: 'invoice',
    amount_paid: overrides.amount ?? economy.subscription.priceCents,
    billing_reason: overrides.reason ?? 'subscription_create',
    period_start: period.start,
    period_end: period.end,
    lines: { object: 'list', data: [{ period }] },
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: ids.subscription,
        metadata: {
          user_id: who.userId,
          offer_id: economy.subscription.id,
          consent_at: new Date().toISOString(),
          ...CONSENT,
        },
      },
    },
  };
}

export function subscriptionObject(
  who: Account,
  subscription: string,
  status: string,
  cancelAtPeriodEnd = false,
) {
  return {
    id: subscription,
    object: 'subscription',
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata: { user_id: who.userId, offer_id: economy.subscription.id, ...CONSENT },
  };
}

export const refundObject = (
  paymentIntent: string,
  amount: number,
  refund = id('re'),
  status = 'succeeded',
) => ({ id: refund, object: 'refund', amount, status, payment_intent: paymentIntent });

export const disputeObject = (
  paymentIntent: string,
  amount: number,
  status: string,
  dispute = id('dp'),
) => ({ id: dispute, object: 'dispute', amount, status, payment_intent: paymentIntent });

export const seconds = (ms: number) => Math.floor(ms / 1000);
