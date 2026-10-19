import {
  PRIVACY_POLICY,
  dataExportSchema,
  deleteAccountRequestSchema,
  type Credits,
} from '@aquarium/shared';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from './auth.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import { lockHandles } from './handle.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';

export interface LegalLimits {
  export: Limit;
  deleteAttempt: Limit;
}

export const DEFAULT_LEGAL_LIMITS: LegalLimits = {
  export: { max: 5, windowMs: 60 * 60_000 },
  deleteAttempt: { max: 5, windowMs: 15 * 60_000 },
};

export const FRESH_SESSION_MS = 5 * 60_000;

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
}

export function registerLegalRoutes(deps: LegalDeps): void {
  const { app, database, auth, credits, limiter, limits } = deps;
  const { db } = database;

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

    const [sessions, accounts, passkeys, tanks] = await Promise.all([
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
    ]);

    const perTank = await Promise.all(
      tanks.map(async (tank) => {
        const [fish, events, memorials] = await Promise.all([
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
        ]);
        return { tank, fish, events, memorials };
      }),
    );

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
          tanks: perTank,
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

    const wait = limiter.consume(`delete:${userId}`, limits.deleteAttempt);
    if (wait > 0) return tooMany(reply, wait);

    const [credential] = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential')));

    if (credential?.password) {
      const ctx = await auth.$context;
      const valid =
        password !== undefined &&
        (await ctx.password.verify({ hash: credential.password, password }));
      if (!valid) {
        return reply
          .code(403)
          .send(apiError('forbidden', 'Password confirmation is required and must be correct.'));
      }
    } else if (Date.now() - current.session.createdAt.getTime() > FRESH_SESSION_MS) {
      return reply
        .code(403)
        .send(
          apiError('forbidden', 'Sign in again with your passkey, then retry within 5 minutes.'),
        );
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.verification)
        .where(
          or(
            sql`${schema.verification.value} like ${`%"userData":{"id":"${userId}"%`}`,
            eq(schema.verification.value, userId),
          ),
        );
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
      await tx.delete(schema.user).where(eq(schema.user.id, userId));
    });

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
