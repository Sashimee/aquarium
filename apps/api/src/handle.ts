import { handleResponseSchema, setHandleRequestSchema } from '@aquarium/shared';
import { eq } from 'drizzle-orm';
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
      await database.db
        .update(schema.user)
        .set({ handle, updatedAt: new Date() })
        .where(eq(schema.user.id, user.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send(apiError('conflict', 'That handle is taken. Pick another.'));
      }
      throw err;
    }
    return handleResponseSchema.parse({ handle });
  });
}
