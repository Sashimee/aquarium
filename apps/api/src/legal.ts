import {
  PRIVACY_POLICY,
  containsBlockedWord,
  dataExportSchema,
  deleteAccountRequestSchema,
  type Credits,
} from '@aquarium/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from './auth.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import { storedFishSchema } from './gifts.ts';
import { createReauthenticator } from './reauth.ts';
import { publicName } from './public.ts';
import { lockHandles } from './handle.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';
import { describeProviderError, type PaymentProvider } from './payments/provider.ts';

export interface LegalLimits {
  export: Limit;
  deleteAttempt: Limit;
}

export const DEFAULT_LEGAL_LIMITS: LegalLimits = {
  export: { max: 5, windowMs: 60 * 60_000 },
  deleteAttempt: { max: 5, windowMs: 15 * 60_000 },
};

interface CurrentSession {
  user: { id: string; email: string };
  session: { id: string; createdAt: Date };
}

export interface LegalDeps {
  app: FastifyInstance;
  database: Database;
  auth: Auth;
  credits: Credits;
  limiter: RateLimiter;
  limits: LegalLimits;
  currentSession: (req: FastifyRequest) => Promise<CurrentSession | null>;
  payments?: PaymentProvider | null;
}

export function registerLegalRoutes(deps: LegalDeps): void {
  const { app, database, auth, credits, limiter, limits } = deps;
  const { db } = database;
  const reauthenticate = createReauthenticator(database, auth);

  const unauthenticated = (reply: FastifyReply) =>
    reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
  const tooMany = (reply: FastifyReply, retryAfter: number) =>
    reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send(apiError('rate_limited', 'Too many requests. Try again later.'));

  app.get('/api/privacy', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return PRIVACY_POLICY;
  });

  app.get('/api/credits', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return credits;
  });

  app.post('/api/me/export', async (req, reply) => {
    const current = await deps.currentSession(req);
    if (!current) return unauthenticated(reply);
    const userId = current.user.id;
    const wait = limiter.consume(`export:${userId}`, limits.export);
    if (wait > 0) return tooMany(reply, wait);

    const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
    if (!user) return unauthenticated(reply);

    const [
      sessions,
      accounts,
      passkeys,
      tanks,
      [prefs],
      subscriptions,
      reactions,
      votes,
      auditRows,
      collectionRows,
      awardRows,
      communityFeedRows,
      [walletRow],
      ledgerRows,
    ] = await Promise.all([
      db
        .select({
          id: schema.session.id,
          createdAt: schema.session.createdAt,
          expiresAt: schema.session.expiresAt,
          ipAddress: schema.session.ipAddress,
          userAgent: schema.session.userAgent,
        })
        .from(schema.session)
        .where(eq(schema.session.userId, userId))
        .orderBy(asc(schema.session.createdAt)),
      db
        .select({
          id: schema.account.id,
          providerId: schema.account.providerId,
          hasPassword: schema.account.password,
          createdAt: schema.account.createdAt,
        })
        .from(schema.account)
        .where(eq(schema.account.userId, userId))
        .orderBy(asc(schema.account.createdAt)),
      db
        .select({
          id: schema.passkey.id,
          name: schema.passkey.name,
          deviceType: schema.passkey.deviceType,
          backedUp: schema.passkey.backedUp,
          transports: schema.passkey.transports,
          createdAt: schema.passkey.createdAt,
        })
        .from(schema.passkey)
        .where(eq(schema.passkey.userId, userId))
        .orderBy(asc(schema.passkey.createdAt)),
      db
        .select()
        .from(schema.tanks)
        .where(eq(schema.tanks.ownerId, userId))
        .orderBy(asc(schema.tanks.createdAt)),
      db.select().from(schema.reminderPrefs).where(eq(schema.reminderPrefs.userId, userId)),
      db
        .select({
          id: schema.pushSubscriptions.id,
          endpoint: schema.pushSubscriptions.endpoint,
          createdAt: schema.pushSubscriptions.createdAt,
          lastUsedAt: schema.pushSubscriptions.lastUsedAt,
        })
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.userId, userId))
        .orderBy(asc(schema.pushSubscriptions.createdAt)),
      db
        .select({
          tankName: schema.tanks.name,
          shared: sql<boolean>`${schema.tanks.shareTokenHash} is not null`,
          kind: schema.tankReactions.kind,
          createdAt: schema.tankReactions.createdAt,
        })
        .from(schema.tankReactions)
        .innerJoin(schema.tanks, eq(schema.tanks.id, schema.tankReactions.tankId))
        .where(eq(schema.tankReactions.userId, userId))
        .orderBy(asc(schema.tankReactions.createdAt)),
      db
        .select({
          weekStart: schema.tankVotes.weekStart,
          createdAt: schema.tankVotes.createdAt,
          tankName: schema.tanks.name,
          shared: sql<boolean>`${schema.tanks.shareTokenHash} is not null`,
        })
        .from(schema.tankVotes)
        .innerJoin(schema.tanks, eq(schema.tanks.id, schema.tankVotes.tankId))
        .where(eq(schema.tankVotes.userId, userId))
        .orderBy(asc(schema.tankVotes.weekStart)),
      db
        .select({
          at: schema.auditLog.at,
          action: schema.auditLog.action,
          detail: schema.auditLog.detail,
          tankName: schema.tanks.name,
          visible: sql<boolean>`(${schema.tanks.ownerId} = ${userId} or ${schema.tanks.shareTokenHash} is not null)`,
        })
        .from(schema.auditLog)
        .leftJoin(schema.tanks, eq(schema.tanks.id, schema.auditLog.tankId))
        .where(eq(schema.auditLog.actorId, userId))
        .orderBy(asc(schema.auditLog.at)),
      db
        .select({
          species: schema.collectionEntries.species,
          keptAt: schema.collectionEntries.keptAt,
          bredAt: schema.collectionEntries.bredAt,
          raisedAt: schema.collectionEntries.raisedAt,
        })
        .from(schema.collectionEntries)
        .where(eq(schema.collectionEntries.userId, userId))
        .orderBy(asc(schema.collectionEntries.keptAt)),
      db
        .select({
          achievementId: schema.achievementAwards.achievementId,
          earnedAt: schema.achievementAwards.earnedAt,
        })
        .from(schema.achievementAwards)
        .where(eq(schema.achievementAwards.userId, userId))
        .orderBy(asc(schema.achievementAwards.earnedAt)),
      db
        .select({
          fedAt: schema.communityFeeds.fedAt,
          food: schema.communityFeeds.food,
          portion: schema.communityFeeds.portion,
        })
        .from(schema.communityFeeds)
        .where(eq(schema.communityFeeds.userId, userId))
        .orderBy(asc(schema.communityFeeds.fedAt)),
      db.select().from(schema.wallet).where(eq(schema.wallet.userId, userId)),
      db
        .select()
        .from(schema.ledger)
        .where(eq(schema.ledger.userId, userId))
        .orderBy(asc(schema.ledger.createdAt), asc(schema.ledger.id)),
    ]);

    // One snapshot for all payment tables, so a refund landing mid-export cannot show up without
    // its charge.
    const { adultRow, chargeRows, refundRows, disputeRows, clubRows } = await db.transaction(
      async (tx) => {
        const [adultRow] = await tx
          .select({ confirmedAt: schema.adultConfirmations.confirmedAt })
          .from(schema.adultConfirmations)
          .where(
            and(
              eq(schema.adultConfirmations.userId, userId),
              isNull(schema.adultConfirmations.withdrawnAt),
            ),
          );
        const chargeRows = await tx
          .select({
            id: schema.paymentCharges.id,
            kind: schema.paymentCharges.kind,
            amountCents: schema.paymentCharges.amountCents,
            packId: schema.paymentCharges.packId,
            packPearls: schema.paymentCharges.packPearls,
            subscriptionId: schema.paymentCharges.subscriptionId,
            periodStart: schema.paymentCharges.periodStart,
            periodEnd: schema.paymentCharges.periodEnd,
            consentAt: schema.paymentCharges.consentAt,
            createdAt: schema.paymentCharges.createdAt,
          })
          .from(schema.paymentCharges)
          .where(eq(schema.paymentCharges.userId, userId))
          .orderBy(asc(schema.paymentCharges.createdAt), asc(schema.paymentCharges.id));
        const chargeIds = chargeRows.map((c) => c.id);
        const refundRows =
          chargeIds.length === 0
            ? []
            : await tx
                .select()
                .from(schema.paymentRefunds)
                .where(inArray(schema.paymentRefunds.chargeId, chargeIds))
                .orderBy(asc(schema.paymentRefunds.createdAt), asc(schema.paymentRefunds.refundId));
        const disputeRows =
          chargeIds.length === 0
            ? []
            : await tx
                .select()
                .from(schema.paymentDisputes)
                .where(inArray(schema.paymentDisputes.chargeId, chargeIds))
                .orderBy(
                  asc(schema.paymentDisputes.updatedAt),
                  asc(schema.paymentDisputes.disputeId),
                );
        const clubRows = await tx
          .select()
          .from(schema.clubSubscriptions)
          .where(eq(schema.clubSubscriptions.userId, userId))
          .orderBy(asc(schema.clubSubscriptions.createdAt), asc(schema.clubSubscriptions.id));
        return { adultRow, chargeRows, refundRows, disputeRows, clubRows };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const perTank = await Promise.all(
      tanks.map(async (tank) => {
        const [fish, events, memorials, visits] = await Promise.all([
          db
            .select()
            .from(schema.fish)
            .where(eq(schema.fish.tankId, tank.id))
            .orderBy(asc(schema.fish.bornAt)),
          db
            .select()
            .from(schema.events)
            .where(eq(schema.events.tankId, tank.id))
            .orderBy(asc(schema.events.at)),
          db
            .select()
            .from(schema.memorials)
            .where(eq(schema.memorials.tankId, tank.id))
            .orderBy(asc(schema.memorials.diedAt)),
          db
            .select({ day: schema.tankVisits.day })
            .from(schema.tankVisits)
            .where(eq(schema.tankVisits.tankId, tank.id))
            .orderBy(asc(schema.tankVisits.day)),
        ]);
        const { shareTokenHash, ...rest } = tank;
        return {
          tank: { ...rest, shared: shareTokenHash !== null },
          fish,
          events,
          memorials,
          visits,
        };
      }),
    );

    const offerRows = await db
      .select()
      .from(schema.giftOffers)
      .where(or(eq(schema.giftOffers.fromUserId, userId), eq(schema.giftOffers.toUserId, userId)))
      .orderBy(asc(schema.giftOffers.createdAt), asc(schema.giftOffers.id));
    const counterpartIds = offerRows.flatMap((o) => {
      const other = o.fromUserId === userId ? o.toUserId : o.fromUserId;
      return other === null ? [] : [other];
    });
    const handles = new Map<string, string | null>();
    if (counterpartIds.length > 0) {
      for (const u of await db
        .select({ id: schema.user.id, handle: schema.user.handle })
        .from(schema.user)
        .where(inArray(schema.user.id, counterpartIds))) {
        handles.set(u.id, u.handle);
      }
    }
    const giftOffers = offerRows.flatMap((o) => {
      const sent = o.fromUserId === userId;
      const other = sent ? o.toUserId : o.fromUserId;
      const parsed = storedFishSchema.safeParse(o.fish);
      if (!parsed.success) {
        app.log.error(
          { offerId: o.id },
          'gift offer left out of an export, its fish is unreadable',
        );
        return [];
      }
      const stored = parsed.data;
      return [
        {
          id: o.id,
          status: o.status,
          wantsReturn: o.wantsReturn,
          pledgedFishId: o.pledgedFishId,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          settledAt: o.settledAt,
          role: sent ? 'sender' : 'recipient',
          counterpart: other === null ? null : (handles.get(other) ?? null),
          fish: sent
            ? stored
            : {
                id: stored.id,
                species: stored.species,
                name: containsBlockedWord(stored.name) ? stored.species : stored.name,
                sex: stored.sex,
                stage: stored.stage,
                size: stored.size,
              },
        },
      ];
    });

    const body = dataExportSchema.parse(
      JSON.parse(
        JSON.stringify({
          exportedAt: new Date(),
          format: 'aquarium-export-v1',
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            handle: user.handle,
            emailVerified: user.emailVerified,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
          sessions,
          signInMethods: accounts.map(({ hasPassword, ...rest }) => ({
            ...rest,
            hasPassword: hasPassword !== null,
          })),
          passkeys,
          reminders: {
            mail: prefs?.mailEnabled ?? false,
            push: prefs?.pushEnabled ?? false,
            lastSentAt: prefs?.lastSentAt ?? null,
            pushSubscriptions: subscriptions,
          },
          reactions: reactions.map(({ tankName, shared, ...rest }) => ({
            ...rest,
            tank: shared ? publicName(tankName) : null,
          })),
          galleryVotes: votes.map(({ tankName, shared, ...rest }) => ({
            ...rest,
            tank: shared ? publicName(tankName) : null,
          })),
          auditLog: auditRows.map(({ tankName, visible, ...rest }) => ({
            ...rest,
            tank: tankName === null || !visible ? null : publicName(tankName),
          })),
          communityFeeds: communityFeedRows,
          collection: { entries: collectionRows, achievements: awardRows },
          wallet: { balance: walletRow?.balance ?? 0, ledger: ledgerRows },
          payments: {
            adultConfirmedAt: adultRow?.confirmedAt ?? null,
            charges: chargeRows,
            refunds: refundRows,
            disputes: disputeRows,
            clubSubscriptions: clubRows,
          },
          tanks: perTank,
          giftOffers,
        }),
      ),
    );

    return reply
      .header('cache-control', 'no-store')
      .header('content-disposition', 'attachment; filename="aquarium-data.json"')
      .send(body);
  });

  app.post('/api/me/delete', async (req, reply) => {
    const current = await deps.currentSession(req);
    if (!current) return unauthenticated(reply);
    const { password } = deleteAccountRequestSchema.parse(req.body);
    const userId = current.user.id;

    const wait = limiter.consume(`reauth:${userId}`, limits.deleteAttempt);
    if (wait > 0) return tooMany(reply, wait);

    const proof = await reauthenticate(current, password);
    if (proof === 'wrong_password') {
      return reply
        .code(403)
        .send(apiError('forbidden', 'Password confirmation is required and must be correct.'));
    }
    if (proof === 'stale_session') {
      return reply
        .code(403)
        .send(
          apiError('forbidden', 'Sign in again with your passkey, then retry within 5 minutes.'),
        );
    }

    // A subscription left running would keep billing an account that no longer exists, so a failed
    // cancel, or payments being switched off while one still runs, stops the deletion.
    const candidates = await db
      .select({
        id: schema.clubSubscriptions.id,
        status: schema.clubSubscriptions.status,
        createdAt: schema.clubSubscriptions.createdAt,
      })
      .from(schema.clubSubscriptions)
      .where(
        and(
          eq(schema.clubSubscriptions.userId, userId),
          inArray(schema.clubSubscriptions.status, [
            'active',
            'past_due',
            'unpaid',
            'trialing',
            'incomplete',
          ]),
        ),
      );
    // Stripe expires an unpaid checkout subscription after 24 h, but with payments off the webhook
    // that would record it never arrives, so an old incomplete row must not block deletion forever.
    const running = candidates.filter(
      (row) =>
        Boolean(deps.payments) ||
        row.status !== 'incomplete' ||
        Date.now() - row.createdAt.getTime() < 24 * 3_600_000,
    );
    if (running.length > 0) {
      if (!deps.payments) {
        app.log.error('account deletion refused: a subscription runs but payments are off');
        return reply
          .code(503)
          .send(
            apiError(
              'payments_disabled',
              'Your subscription cannot be cancelled while payments are unavailable, so nothing was deleted. Try again later.',
            ),
          );
      }
      try {
        for (const { id } of running) await deps.payments.cancelSubscriptionNow(id);
      } catch (error) {
        app.log.error(
          describeProviderError(error),
          'subscription could not be cancelled for account deletion',
        );
        return reply
          .code(502)
          .send(
            apiError(
              'internal',
              'Your subscription could not be cancelled with the payment provider, so nothing was deleted. Try again in a minute.',
            ),
          );
      }
    }

    const orphaned = await db.transaction(async (tx) => {
      await tx
        .delete(schema.verification)
        .where(
          or(
            sql`${schema.verification.value} like ${`%"userData":{"id":"${userId}"%`}`,
            eq(schema.verification.value, userId),
          ),
        );
      // Wallet and ledger inserts take FOR KEY SHARE on this user row through their foreign key, so
      // locking it before the ledger delete makes a concurrent spend finish first (and get deleted
      // below) or fail once the user is gone. Locking after the delete would let a play row outlive
      // the account.
      const [leaving] = await tx
        .select({ handle: schema.user.handle })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
        .for('update');
      if (leaving?.handle) {
        await lockHandles(tx, [leaving.handle]);
        await tx
          .insert(schema.releasedHandles)
          .values({ handle: leaving.handle })
          .onConflictDoUpdate({
            target: schema.releasedHandles.handle,
            set: { releasedAt: sql`now()` },
          });
      }
      await tx
        .delete(schema.ledger)
        .where(and(eq(schema.ledger.userId, userId), eq(schema.ledger.source, 'game')));
      const received = await tx
        .select({ id: schema.giftOffers.id })
        .from(schema.giftOffers)
        .where(
          and(
            eq(schema.giftOffers.toUserId, userId),
            inArray(schema.giftOffers.status, ['open', 'countered']),
          ),
        );
      await tx.delete(schema.user).where(eq(schema.user.id, userId));
      return received.map((o) => o.id);
    });

    // The deleted user's open gift offers lost their recipient; settle them now as declined so the
    // fish are back with their senders. The sweeper retries anything this misses.
    try {
      await app.settleGiftOffers(orphaned);
    } catch (error) {
      app.log.error({ err: error }, 'gift offers of a deleted account were not settled');
    }

    const { authCookies } = await auth.$context;
    const expired = (name: string, attributes: Record<string, unknown>) => {
      const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
      if (attributes['httpOnly']) parts.push('HttpOnly');
      if (attributes['secure']) parts.push('Secure');
      parts.push('SameSite=Lax');
      return parts.join('; ');
    };
    return reply
      .header('set-cookie', [
        expired(authCookies.sessionToken.name, authCookies.sessionToken.attributes),
        expired(authCookies.dontRememberToken.name, authCookies.dontRememberToken.attributes),
      ])
      .header('cache-control', 'no-store')
      .code(204)
      .send();
  });
}
