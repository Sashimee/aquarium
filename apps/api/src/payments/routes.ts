import {
  adultConfirmationRequestSchema,
  packCheckoutRequestSchema,
  packsResponseSchema,
  paymentsStateSchema,
  subscriptionCheckoutRequestSchema,
  checkoutResponseSchema,
  orderParamsSchema,
  orderStatusResponseSchema,
  type OrderStatus,
  type Economy,
  type PaymentsState,
} from '@aquarium/shared';
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../clock.ts';
import { schema, type Database } from '../db/index.ts';
import { apiError, HttpError } from '../errors.ts';
import type { Mailer } from '../mail.ts';
import type { Reauthentication } from '../reauth.ts';
import type { Limit, RateLimiter } from '../rate-limit.ts';
import { describeProviderError, WebhookSignatureError, type PaymentProvider } from './provider.ts';
import { receiptOf, settleEvent, takenBack, type Receipt } from './settle.ts';

declare module 'fastify' {
  interface FastifyInstance {
    retryPendingReceipts: () => Promise<number>;
    receiptsIdle: () => Promise<void>;
  }
}

export interface PaymentsLimits {
  checkout: Limit;
  cancel: Limit;
  settings: Limit;
  adultConfirmation: Limit;
  orders: Limit;
}

export const DEFAULT_PAYMENTS_LIMITS: PaymentsLimits = {
  checkout: { max: 10, windowMs: 60 * 60_000 },
  cancel: { max: 10, windowMs: 60 * 60_000 },
  settings: { max: 30, windowMs: 60_000 },
  adultConfirmation: { max: 5, windowMs: 15 * 60_000 },
  orders: { max: 60, windowMs: 60_000 },
};

export interface PaymentUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface PaymentsDeps {
  app: FastifyInstance;
  database: Database;
  economy: Economy;
  clock: Clock;
  limiter: RateLimiter;
  limits: PaymentsLimits;
  mailer: Mailer;
  appOrigin: string;
  provider: PaymentProvider | null;
  currentUser: (req: FastifyRequest) => Promise<PaymentUser | null>;
  reauthenticate: (req: FastifyRequest, password: string | undefined) => Promise<Reauthentication>;
}

export const RECEIPT_LEASE_MS = 5 * 60_000;
const REVIVABLE = ['active', 'past_due', 'unpaid', 'trialing'];

export const paymentsDisabled = () =>
  new HttpError(
    503,
    apiError(
      'payments_disabled',
      'Buying Pearls is not available right now. Everything else works.',
    ),
  );

export function registerPaymentRoutes(deps: PaymentsDeps): void {
  const { app, database, economy, clock, limiter, limits, provider } = deps;
  const { db } = database;

  async function authorize(req: FastifyRequest, requireVerified: boolean): Promise<PaymentUser> {
    const user = await deps.currentUser(req);
    if (!user) throw new HttpError(401, apiError('unauthenticated', 'Sign in required.'));
    if (requireVerified && !user.emailVerified) {
      throw new HttpError(
        403,
        apiError('email_not_verified', 'Verify your email address before buying Pearls.'),
      );
    }
    return user;
  }

  function throttle(userId: string, bucket: keyof PaymentsLimits, key?: string): void {
    const wait = limiter.consume(key ?? `payments:${bucket}:${userId}`, limits[bucket]);
    if (wait > 0) {
      throw new HttpError(
        429,
        apiError('rate_limited', `Too many requests. Try again in ${wait} s.`),
        { 'retry-after': String(wait) },
      );
    }
  }

  const guarded =
    <T>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        if (err instanceof HttpError)
          return reply.code(err.status).headers(err.headers).send(err.body);
        throw err;
      }
    };

  function requireProvider(): PaymentProvider {
    if (!provider) throw paymentsDisabled();
    return provider;
  }

  async function isAdultConfirmed(userId: string): Promise<boolean> {
    const [row] = await db
      .select({ userId: schema.adultConfirmations.userId })
      .from(schema.adultConfirmations)
      .where(
        and(
          eq(schema.adultConfirmations.userId, userId),
          isNull(schema.adultConfirmations.withdrawnAt),
        ),
      );
    return row !== undefined;
  }

  async function requireAdult(userId: string): Promise<void> {
    if (await isAdultConfirmed(userId)) return;
    throw new HttpError(
      403,
      apiError(
        'adult_confirmation_required',
        'An adult has to confirm purchases in the account settings before Pearls can be bought.',
      ),
    );
  }

  async function currentSubscription(userId: string) {
    const [row] = await db
      .select()
      .from(schema.clubSubscriptions)
      .where(
        and(
          eq(schema.clubSubscriptions.userId, userId),
          inArray(schema.clubSubscriptions.status, [...REVIVABLE, 'canceled', 'paused']),
        ),
      )
      .orderBy(
        sql`${schema.clubSubscriptions.paidEnd} desc nulls last`,
        desc(schema.clubSubscriptions.createdAt),
      )
      .limit(1);
    return row;
  }

  async function state(userId: string): Promise<PaymentsState> {
    const row = await currentSubscription(userId);
    return paymentsStateSchema.parse({
      payments: provider ? 'enabled' : 'disabled',
      adultConfirmed: await isAdultConfirmed(userId),
      subscription: row
        ? {
            status: row.status,
            paidUntil: row.paidEnd && !row.paidRevoked ? row.paidEnd.toISOString() : null,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          }
        : null,
    });
  }

  const successUrl = `${deps.appOrigin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${deps.appOrigin}/?payment=cancelled`;

  app.get(
    '/api/payments/state',
    guarded(async (req) => {
      const user = await authorize(req, false);
      throttle(user.id, 'settings');
      return state(user.id);
    }),
  );

  const notFound = () => new HttpError(404, apiError('not_found', 'No such order.'));

  async function chargeStatus(chargeId: string, amountCents: number): Promise<OrderStatus> {
    const taken = await db.transaction((tx) => takenBack(tx, chargeId));
    return amountCents > 0 && taken.cents >= amountCents ? 'refunded' : 'paid';
  }

  app.get(
    '/api/payments/orders/:sessionId',
    guarded(async (req) => {
      const payments = requireProvider();
      const user = await authorize(req, false);
      throttle(user.id, 'orders');
      const parsed = orderParamsSchema.safeParse(req.params);
      if (!parsed.success) throw notFound();
      const { sessionId } = parsed.data;

      const [charge] = await db
        .select({
          userId: schema.paymentCharges.userId,
          amountCents: schema.paymentCharges.amountCents,
        })
        .from(schema.paymentCharges)
        .where(eq(schema.paymentCharges.id, sessionId));
      if (charge) {
        if (charge.userId !== user.id) throw notFound();
        return orderStatusResponseSchema.parse({
          status: await chargeStatus(sessionId, charge.amountCents),
        });
      }

      const session = await checkout(
        () => payments.retrieveCheckoutSession(sessionId),
        'The payment provider did not answer. Try again in a moment.',
      );
      if (!session || session.userId !== user.id) throw notFound();
      if (
        session.status === 'expired' ||
        (session.status === 'complete' && session.paymentStatus === 'unpaid')
      )
        return orderStatusResponseSchema.parse({ status: 'failed' });
      if (session.subscriptionId) {
        const [row] = await db
          .select({
            paidInvoiceId: schema.clubSubscriptions.paidInvoiceId,
            paidRevoked: schema.clubSubscriptions.paidRevoked,
          })
          .from(schema.clubSubscriptions)
          .where(
            and(
              eq(schema.clubSubscriptions.id, session.subscriptionId),
              eq(schema.clubSubscriptions.userId, user.id),
            ),
          );
        if (row?.paidInvoiceId) {
          return orderStatusResponseSchema.parse({ status: row.paidRevoked ? 'refunded' : 'paid' });
        }
      }
      return orderStatusResponseSchema.parse({ status: 'pending' });
    }),
  );

  app.put(
    '/api/payments/adult-confirmation',
    guarded(async (req) => {
      const user = await authorize(req, false);
      const body = adultConfirmationRequestSchema.parse(req.body);
      if (body.confirmed) throttle(user.id, 'adultConfirmation', `reauth:${user.id}`);
      else throttle(user.id, 'settings');
      if (body.confirmed) {
        const proof = await deps.reauthenticate(req, body.password);
        if (proof === 'wrong_password') {
          throw new HttpError(
            403,
            apiError('forbidden', 'Password confirmation is required and must be correct.'),
          );
        }
        if (proof === 'stale_session') {
          throw new HttpError(
            403,
            apiError('forbidden', 'Sign in again with your passkey, then retry within 5 minutes.'),
          );
        }
        await db
          .insert(schema.adultConfirmations)
          .values({ userId: user.id, confirmedAt: new Date(clock.now()) })
          .onConflictDoNothing();
      } else {
        await db
          .update(schema.adultConfirmations)
          .set({ withdrawnAt: new Date(clock.now()) })
          .where(
            and(
              eq(schema.adultConfirmations.userId, user.id),
              isNull(schema.adultConfirmations.withdrawnAt),
            ),
          );
      }
      return state(user.id);
    }),
  );

  app.get(
    '/api/payments/packs',
    guarded(async (req) => {
      requireProvider();
      const user = await authorize(req, false);
      throttle(user.id, 'settings');
      return packsResponseSchema.parse({
        packs: economy.packs.filter((p) => p.webAvailable),
        subscription: economy.subscription,
      });
    }),
  );

  app.post(
    '/api/payments/checkout/pack',
    guarded(async (req) => {
      const payments = requireProvider();
      const user = await authorize(req, true);
      const body = packCheckoutRequestSchema.parse(req.body);
      throttle(user.id, 'checkout');
      const pack = economy.packs.find((p) => p.id === body.packId);
      if (!pack || !pack.webAvailable) {
        throw new HttpError(
          400,
          apiError('validation_failed', 'That pack is not sold on the web.'),
        );
      }
      await requireAdult(user.id);
      return checkout(async () =>
        checkoutResponseSchema.parse(
          await payments.createPackCheckout({
            userId: user.id,
            email: user.email,
            packId: pack.id,
            pearls: pack.pearls,
            priceCents: pack.priceCents,
            consent: { at: new Date(clock.now()) },
            successUrl,
            cancelUrl,
          }),
        ),
      );
    }),
  );

  app.post(
    '/api/payments/checkout/subscription',
    guarded(async (req) => {
      const payments = requireProvider();
      const user = await authorize(req, true);
      subscriptionCheckoutRequestSchema.parse(req.body);
      throttle(user.id, 'checkout');
      await requireAdult(user.id);
      const existing = await currentSubscription(user.id);
      if (existing && REVIVABLE.includes(existing.status)) {
        throw new HttpError(
          409,
          apiError('conflict', 'You already have an Aquarist Club subscription.'),
        );
      }
      const offer = economy.subscription;
      return checkout(async () =>
        checkoutResponseSchema.parse(
          await payments.createSubscriptionCheckout({
            userId: user.id,
            email: user.email,
            subscriptionId: offer.id,
            priceCents: offer.priceCents,
            pearlsPerDay: offer.pearlsPerDay,
            consent: { at: new Date(clock.now()) },
            successUrl,
            cancelUrl,
          }),
        ),
      );
    }),
  );

  app.post(
    '/api/payments/subscription/cancel',
    guarded(async (req) => {
      const payments = requireProvider();
      const user = await authorize(req, false);
      throttle(user.id, 'cancel');
      const row = await currentSubscription(user.id);
      if (!row || !REVIVABLE.includes(row.status)) {
        throw new HttpError(409, apiError('conflict', 'You have no active subscription.'));
      }
      if (!row.cancelAtPeriodEnd) {
        await checkout(() => payments.cancelSubscriptionAtPeriodEnd(row.id));
        await db
          .update(schema.clubSubscriptions)
          .set({ cancelAtPeriodEnd: true })
          .where(eq(schema.clubSubscriptions.id, row.id));
      }
      return state(user.id);
    }),
  );

  async function checkout<T>(
    work: () => Promise<T>,
    message = 'The payment provider did not answer. Nothing was charged; try again.',
  ): Promise<T> {
    try {
      return await work();
    } catch (err) {
      app.log.error(describeProviderError(err), 'payment provider call failed');
      throw new HttpError(502, apiError('internal', message));
    }
  }

  const RETRY_BATCH = 20;
  const MAX_RECEIPT_ATTEMPTS = 8;
  const RECEIPT_BACKOFF_MS = 5 * 60_000;
  const RECEIPT_BACKOFF_MAX_MS = 6 * 3_600_000;

  type ChargeRow = typeof schema.paymentCharges.$inferSelect;

  // Taking the lease is the claim: a sibling webhook or the hourly job that looks while a send is
  // in flight finds the row leased and skips it, and a crash mid-send is retried once the lease ends.
  async function claimReceipt(chargeId: string): Promise<ChargeRow | null> {
    const now = clock.now();
    const [row] = await db
      .update(schema.paymentCharges)
      .set({ receiptNextTryAt: new Date(now + RECEIPT_LEASE_MS) })
      .where(
        and(
          eq(schema.paymentCharges.id, chargeId),
          eq(schema.paymentCharges.receiptPending, true),
          lt(schema.paymentCharges.receiptAttempts, MAX_RECEIPT_ATTEMPTS),
          or(
            isNull(schema.paymentCharges.receiptNextTryAt),
            lte(schema.paymentCharges.receiptNextTryAt, new Date(now)),
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  async function releaseReceipt(chargeId: string): Promise<void> {
    await db
      .update(schema.paymentCharges)
      .set({ receiptPending: false })
      .where(eq(schema.paymentCharges.id, chargeId));
  }

  async function deferReceipt(charge: ChargeRow): Promise<void> {
    const attempts = charge.receiptAttempts + 1;
    const backoff = Math.min(
      RECEIPT_BACKOFF_MAX_MS,
      RECEIPT_BACKOFF_MS * 2 ** charge.receiptAttempts,
    );
    await db
      .update(schema.paymentCharges)
      .set({ receiptAttempts: attempts, receiptNextTryAt: new Date(clock.now() + backoff) })
      .where(eq(schema.paymentCharges.id, charge.id));
    if (attempts >= MAX_RECEIPT_ATTEMPTS) {
      app.log.error({ chargeId: charge.id }, 'receipt mail abandoned after repeated failures');
    }
  }

  // The mail error text can carry the recipient's address (an SMTP "user@x: rejected" reply), so
  // only its classification is logged.
  function describeMailError(err: unknown): Record<string, string> {
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      return { errorName: err.name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
    }
    return { errorName: 'unknown' };
  }

  async function deliverReceipt(charge: ChargeRow, receipt: Receipt): Promise<boolean> {
    const [row] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, receipt.userId));
    if (!row) {
      await releaseReceipt(charge.id);
      return false;
    }
    try {
      await deps.mailer.sendReceipt(row.email, receipt);
    } catch (err) {
      app.log.warn(describeMailError(err), 'receipt mail not sent, it stays queued for a retry');
      await deferReceipt(charge);
      return false;
    }
    await releaseReceipt(charge.id);
    return true;
  }

  async function sendReceipt(receipt: Receipt): Promise<boolean> {
    const charge = await claimReceipt(receipt.chargeId);
    return charge ? deliverReceipt(charge, receipt) : false;
  }

  async function retryPendingReceipts(): Promise<number> {
    const now = new Date(clock.now());
    const pending = await db
      .select({ id: schema.paymentCharges.id })
      .from(schema.paymentCharges)
      .where(
        and(
          eq(schema.paymentCharges.receiptPending, true),
          lt(schema.paymentCharges.receiptAttempts, MAX_RECEIPT_ATTEMPTS),
          or(
            isNull(schema.paymentCharges.receiptNextTryAt),
            lte(schema.paymentCharges.receiptNextTryAt, now),
          ),
        ),
      )
      .orderBy(schema.paymentCharges.createdAt)
      .limit(RETRY_BATCH);
    let sent = 0;
    for (const { id } of pending) {
      const charge = await claimReceipt(id);
      if (!charge) continue;
      const receipt = receiptOf(economy, charge);
      if (!receipt) {
        await releaseReceipt(id);
        continue;
      }
      if (await deliverReceipt(charge, receipt)) sent += 1;
    }
    return sent;
  }
  app.decorate('retryPendingReceipts', retryPendingReceipts);

  // The webhook answers as soon as the event is settled; mail goes out behind it so a slow or
  // dead relay cannot make Stripe time out and redeliver.
  const background = new Set<Promise<unknown>>();
  function inBackground(work: () => Promise<unknown>, failure: string): void {
    const task: Promise<unknown> = work()
      .catch((err: unknown) => {
        app.log.warn(describeMailError(err), failure);
      })
      .finally(() => background.delete(task));
    background.add(task);
  }
  app.decorate('receiptsIdle', async () => {
    while (background.size > 0) await Promise.all([...background]);
  });
  app.addHook('onClose', async () => {
    await Promise.all([...background]);
  });

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/api/payments/webhook', async (req, reply) => {
      if (!provider) return reply.code(503).send(paymentsDisabled().body);
      const raw = req.body;
      const signature = req.headers['stripe-signature'];
      if (!Buffer.isBuffer(raw) || typeof signature !== 'string') {
        return reply.code(400).send(apiError('validation_failed', 'Not a signed webhook call.'));
      }
      let event;
      try {
        event = provider.verifyWebhook(raw, signature);
      } catch (err) {
        if (err instanceof WebhookSignatureError) {
          return reply.code(400).send(apiError('validation_failed', 'Signature did not verify.'));
        }
        throw err;
      }
      let receipt: Receipt | null;
      try {
        receipt = await settleEvent(
          {
            database,
            economy,
            provider,
            now: () => clock.now(),
            log: (message, context) => app.log.warn({ ...context }, message),
            logError: (message, context) => app.log.error({ ...context }, message),
          },
          event,
        );
      } catch (err) {
        app.log.error(
          {
            eventId: event.id,
            eventType: event.type,
            ...describeProviderError(err),
            err,
          },
          'payment event could not be settled',
        );
        throw err;
      }
      inBackground(async () => {
        if (receipt) await sendReceipt(receipt);
        await retryPendingReceipts();
      }, 'receipt mail could not be processed');
      return reply.code(200).send({ received: true });
    });
  });
}
