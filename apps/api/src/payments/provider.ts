import Stripe from 'stripe';

export type PaymentEvent = Stripe.Event;

export interface CheckoutConsentRecord {
  at: Date;
}

export interface PackCheckoutInput {
  userId: string;
  email: string;
  packId: string;
  pearls: number;
  priceCents: number;
  consent: CheckoutConsentRecord;
  successUrl: string;
  cancelUrl: string;
}

export interface SubscriptionCheckoutInput {
  userId: string;
  email: string;
  subscriptionId: string;
  priceCents: number;
  pearlsPerDay: number;
  consent: CheckoutConsentRecord;
  successUrl: string;
  cancelUrl: string;
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('webhook signature did not verify');
  }
}

export class ProviderError extends Error {}

export interface ProviderSubscription {
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd: boolean;
}

// Stripe's message for a rejected parameter can echo the customer's email, so logs carry only the
// error's classification and request id.
export function describeProviderError(err: unknown): Record<string, string> {
  if (err instanceof Stripe.errors.StripeError) {
    return {
      type: err.type,
      ...(err.code ? { code: err.code } : {}),
      ...(err.requestId ? { requestId: err.requestId } : {}),
    };
  }
  return { type: err instanceof Error ? err.name : 'unknown' };
}

// The only place the app talks to Stripe. Everything else in apps/api sees this interface, so a
// second provider (StoreKit) or a test double needs no change elsewhere.
export interface PaymentProvider {
  createPackCheckout(input: PackCheckoutInput): Promise<{ url: string }>;
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<{ url: string }>;
  cancelSubscriptionAtPeriodEnd(providerSubscriptionId: string): Promise<void>;
  cancelSubscriptionNow(providerSubscriptionId: string): Promise<void>;
  retrieveSubscription(providerSubscriptionId: string): Promise<ProviderSubscription>;
  refundInvoice(providerInvoiceId: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): PaymentEvent;
}

export interface StripeProviderOptions {
  secretKey: string;
  webhookSecret: string;
  // Points the SDK at stripe-mock in tests; production leaves it unset.
  endpoint?: { host: string; port: number; protocol: 'http' | 'https' };
}

const REQUEST_TIMEOUT_MS = 10_000;

export function createStripeProvider(options: StripeProviderOptions): PaymentProvider {
  const stripe = new Stripe(options.secretKey, {
    timeout: REQUEST_TIMEOUT_MS,
    maxNetworkRetries: 1,
    telemetry: false,
    ...(options.endpoint ?? {}),
  });

  const metadata = (userId: string, consent: CheckoutConsentRecord) => ({
    user_id: userId,
    consent_at: consent.at.toISOString(),
    consent_immediate_delivery: 'true',
    consent_withdrawal_waiver: 'true',
  });

  const WAIVER_TEXT =
    'By paying you ask for immediate delivery and acknowledge that you lose your 14-day right of withdrawal.';

  const requireUrl = (url: string | null): { url: string } => {
    if (!url) throw new ProviderError('Stripe returned a Checkout Session without a URL');
    return { url };
  };

  return {
    async createPackCheckout(input) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: input.userId,
        customer_email: input.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: input.priceCents,
              product_data: { name: `${input.pearls} Pearls` },
            },
          },
        ],
        metadata: {
          ...metadata(input.userId, input.consent),
          pack_id: input.packId,
          price_cents: String(input.priceCents),
          pearls: String(input.pearls),
        },
        custom_text: { submit: { message: WAIVER_TEXT } },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });
      return requireUrl(session.url);
    },

    async createSubscriptionCheckout(input) {
      const meta = {
        ...metadata(input.userId, input.consent),
        offer_id: input.subscriptionId,
      };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: input.userId,
        customer_email: input.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: input.priceCents,
              recurring: { interval: 'month' },
              product_data: { name: `Aquarist Club, ${input.pearlsPerDay} Pearls a day` },
            },
          },
        ],
        metadata: meta,
        subscription_data: { metadata: meta },
        custom_text: { submit: { message: WAIVER_TEXT } },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });
      return requireUrl(session.url);
    },

    async cancelSubscriptionAtPeriodEnd(id) {
      await stripe.subscriptions.update(id, { cancel_at_period_end: true });
    },

    async cancelSubscriptionNow(id) {
      try {
        await stripe.subscriptions.cancel(id);
      } catch (err) {
        if (
          err instanceof Stripe.errors.StripeInvalidRequestError &&
          err.code === 'resource_missing'
        ) {
          return;
        }
        throw err;
      }
    },

    async retrieveSubscription(id) {
      const subscription = await stripe.subscriptions.retrieve(id);
      return {
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      };
    },

    async refundInvoice(invoiceId) {
      const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid' });
      for (const payment of payments.data) {
        const paymentIntent = payment.payment.payment_intent;
        if (payment.payment.type !== 'payment_intent' || !paymentIntent) continue;
        const id = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id;
        await stripe.refunds.create(
          { payment_intent: id },
          { idempotencyKey: `unclaimed-subscription:${invoiceId}:${id}` },
        );
      }
    },

    verifyWebhook(rawBody, signatureHeader) {
      if (!signatureHeader) throw new WebhookSignatureError();
      try {
        return stripe.webhooks.constructEvent(rawBody, signatureHeader, options.webhookSecret);
      } catch (err) {
        if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
          throw new WebhookSignatureError();
        }
        throw err;
      }
    },
  };
}
