import {
  HANDLE_COOLDOWN_DAYS,
  handleResponseSchema,
  setHandleRequestSchema,
} from '@aquarium/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';
import type { SessionUser } from './tanks.ts';

export const DEFAULT_HANDLE_LIMIT: Limit = { max: 10, windowMs: 60 * 60_000 };

export interface HandleRouteDeps {
  app: FastifyInstance;
  database: Database;
  limiter: RateLimiter;
  limit: Limit;
  currentUser: (req: FastifyRequest) => Promise<SessionUser | null>;
}

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export async function lockHandles(tx: Tx, handles: string[]): Promise<void> {
  for (const key of [...new Set(handles)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`handle:${key}`}, 0))`);
  }
}

class HandleCoolingDown extends Error {}
class AccountGone extends Error {}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error ? err.cause : undefined;
  for (const candidate of [err, cause]) {
    if (typeof candidate === 'object' && candidate !== null && 'code' in candidate) {
      if (candidate.code === UNIQUE_VIOLATION) return true;
    }
  }
  return false;
}

export function registerHandleRoutes({
  app,
  database,
  limiter,
  limit,
  currentUser,
}: HandleRouteDeps): void {
  app.get('/api/me/handle', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
    const [row] = await database.db
      .select({ handle: schema.user.handle })
      .from(schema.user)
      .where(eq(schema.user.id, user.id));
    return handleResponseSchema.parse({ handle: row?.handle ?? null });
  });

  app.put('/api/me/handle', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
    if (!user.emailVerified) {
      return reply
        .code(403)
        .send(
          apiError('email_not_verified', 'Verify your email address before choosing a handle.'),
        );
    }
    const { handle } = setHandleRequestSchema.parse(req.body);
    const wait = limiter.consume(`handle:${user.id}`, limit);
    if (wait > 0) {
      return reply
        .code(429)
        .send(apiError('rate_limited', `Too many requests. Try again in ${wait} s.`));
    }
    try {
      await database.db.transaction(async (tx) => {
        const [held] = await tx
          .select({ handle: schema.user.handle })
          .from(schema.user)
          .where(eq(schema.user.id, user.id))
          .for('update');
        if (!held) throw new AccountGone();
        if (held.handle === handle) return;
        await lockHandles(tx, [handle, ...(held.handle ? [held.handle] : [])]);
        const [cooling] = await tx
          .select({ handle: schema.releasedHandles.handle })
          .from(schema.releasedHandles)
          .where(
            and(
              eq(schema.releasedHandles.handle, handle),
              gt(
                schema.releasedHandles.releasedAt,
                sql`now() - make_interval(days => ${HANDLE_COOLDOWN_DAYS})`,
              ),
            ),
          );
        if (cooling) throw new HandleCoolingDown();
        await tx
          .update(schema.user)
          .set({ handle, updatedAt: new Date() })
          .where(eq(schema.user.id, user.id));
        if (held.handle) {
          await tx
            .insert(schema.releasedHandles)
            .values({ handle: held.handle })
            .onConflictDoUpdate({
              target: schema.releasedHandles.handle,
              set: { releasedAt: sql`now()` },
            });
        }
      });
    } catch (err) {
      if (err instanceof AccountGone) {
        return reply
          .code(409)
          .send(apiError('conflict', 'This account is being deleted, so the handle was not saved.'));
      }
      if (err instanceof HandleCoolingDown) {
        return reply
          .code(409)
          .send(
            apiError(
              'conflict',
              `That handle was released recently, possibly by you. A released handle, including your own previous one, can be claimed again after ${HANDLE_COOLDOWN_DAYS} days.`,
            ),
          );
      }
      if (isUniqueViolation(err)) {
        return reply.code(409).send(apiError('conflict', 'That handle is taken. Pick another.'));
      }
      throw err;
    }
    return handleResponseSchema.parse({ handle });
  });
}
