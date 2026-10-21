import { createHash } from 'node:crypto';
import {
  chemistrySchema,
  containsBlockedWord,
  decorLayoutSchema,
  equipmentSchema,
  legacyTintSeed,
  personalitySchema,
  diseaseStateSchema,
  PUBLIC_NAME_FALLBACK,
  publicTankSchema,
  reactionStateSchema,
  setReactionRequestSchema,
  shareTokenSchema,
  waterSchema,
  type PublicTank,
  type ReactionCounts,
} from '@aquarium/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from './audit.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';
import { hashShareToken } from './shareToken.ts';
import { storedBackground } from './tanks.ts';
import { normalizedPathname } from './url.ts';
import type { SessionUser } from './tanks.ts';

export interface PublicLimits {
  view: Limit;
  react: Limit;
  reactIp: Limit;
}

export const DEFAULT_PUBLIC_LIMITS: PublicLimits = {
  view: { max: 120, windowMs: 60_000 },
  react: { max: 30, windowMs: 10 * 60_000 },
  reactIp: { max: 60, windowMs: 10 * 60_000 },
};

export interface PublicRouteDeps {
  app: FastifyInstance;
  database: Database;
  limiter: RateLimiter;
  limits: PublicLimits;
  currentUser: (req: FastifyRequest) => Promise<SessionUser | null>;
}

const paramsSchema = z.object({ token: z.string().max(200) });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send(apiError('not_found', 'This tank is not shared.'));

function seedOf(label: string, id: string): number {
  return createHash('sha256').update(`${label}:${id}`).digest().readUInt32BE(0);
}

const HOUR_MS = 3_600_000;

const hourOf = (at: Date) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();

export function publicName(name: string): string {
  return containsBlockedWord(name) ? PUBLIC_NAME_FALLBACK : name;
}

export interface PublicRoutes {
  snapshot: (
    tank: typeof schema.tanks.$inferSelect,
    viewerId: string | null,
  ) => Promise<PublicTank>;
}

export function registerPublicRoutes({
  app,
  database,
  limiter,
  limits,
  currentUser,
}: PublicRouteDeps): PublicRoutes {
  const { db } = database;

  // Set in onSend so validation errors and unknown sub-paths carry them too. indexable hosts
  // would otherwise leave a share link crawlable.
  app.addHook('onSend', async (req, reply) => {
    if (!normalizedPathname(req.url).toLowerCase().startsWith('/api/public/')) return;
    reply
      .header('x-robots-tag', 'noindex, nofollow')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer');
  });

  async function countsFor(tankId: string): Promise<ReactionCounts> {
    const rows = await db
      .select({ kind: schema.tankReactions.kind, n: sql<number>`count(*)::int` })
      .from(schema.tankReactions)
      .where(eq(schema.tankReactions.tankId, tankId))
      .groupBy(schema.tankReactions.kind);
    const counts: ReactionCounts = { heart: 0, star: 0, wow: 0 };
    for (const row of rows) counts[row.kind] = row.n;
    return counts;
  }

  async function reactionState(tankId: string, userId: string | null) {
    const mine =
      userId === null
        ? undefined
        : (
            await db
              .select({ kind: schema.tankReactions.kind })
              .from(schema.tankReactions)
              .where(
                and(
                  eq(schema.tankReactions.tankId, tankId),
                  eq(schema.tankReactions.userId, userId),
                ),
              )
          )[0];
    return reactionStateSchema.parse({
      reactions: await countsFor(tankId),
      myReaction: mine?.kind ?? null,
    });
  }

  async function tankByToken(
    raw: string,
    executor: Pick<Database['db'], 'select'> = db,
    lock = false,
  ) {
    const token = shareTokenSchema.safeParse(raw);
    if (!token.success) return undefined;
    const query = executor
      .select()
      .from(schema.tanks)
      .where(eq(schema.tanks.shareTokenHash, hashShareToken(token.data)));
    // FOR SHARE makes a concurrent revoke wait for this transaction, so a revoked link never gains a reaction.
    const [tank] = await (lock ? query.for('share') : query);
    return tank;
  }

  const throttled = (reply: FastifyReply, wait: number) =>
    reply
      .code(429)
      .header('retry-after', String(wait))
      .send(apiError('rate_limited', `Too many requests. Try again in ${wait} s.`));

  app.get('/api/public/:token', async (req, reply) => {
    const wait = limiter.consume(`public-view:${req.ip}`, limits.view);
    if (wait > 0) return throttled(reply, wait);
    const { token } = paramsSchema.parse(req.params);
    const tank = await tankByToken(token);
    if (!tank) return notFound(reply);
    return snapshot(tank, (await currentUser(req))?.id ?? null);
  });

  async function snapshot(tank: typeof schema.tanks.$inferSelect, viewerId: string | null) {
    const fish = await db.select().from(schema.fish).where(eq(schema.fish.tankId, tank.id));
    const state = await reactionState(tank.id, viewerId);
    return publicTankSchema.parse({
      name: publicName(tank.name),
      biome: tank.biome,
      size: tank.size,
      seed: seedOf('tank', tank.id),
      backgroundId: storedBackground(tank),
      decorLayout: (tank.decorLayout === null ? [] : decorLayoutSchema.parse(tank.decorLayout)).map(
        (item) => ({ ...item, tintSeed: item.tintSeed ?? legacyTintSeed(item) }),
      ),
      decorEdited: tank.decorLayout !== null,
      water: waterSchema.parse(tank.water),
      chemistry: chemistrySchema.parse(tank.chemistry),
      equipment: equipmentSchema.parse(tank.equipment),
      fish: fish
        .toSorted((a, b) => a.bornAt.getTime() - b.bornAt.getTime() || a.id.localeCompare(b.id))
        .map((f) => ({
          species: f.species,
          name: containsBlockedWord(f.name) ? f.species : f.name,
          sex: f.sex,
          stage: f.stage,
          personality: personalitySchema.parse(f.personality),
          disease: f.disease === null ? null : diseaseStateSchema.parse(f.disease),
          bornAt: f.bornAt.toISOString(),
          size: f.size,
          hunger: f.hunger,
          health: f.health,
          status: f.status,
          diedAt: f.diedAt?.toISOString() ?? null,
          cause: f.cause,
          seed: seedOf('fish', f.id),
        })),
      snapshotAt: hourOf(tank.lastTickAt),
      ...state,
    });
  }
  async function reactor(req: FastifyRequest, reply: FastifyReply) {
    const user = await currentUser(req);
    if (!user) {
      reply.code(401).send(apiError('unauthenticated', 'Sign in to react.'));
      return null;
    }
    if (!user.emailVerified) {
      reply
        .code(403)
        .send(apiError('email_not_verified', 'Verify your email address before reacting.'));
      return null;
    }
    const wait = Math.max(
      limiter.consume(`public-react:${user.id}`, limits.react),
      limiter.consume(`public-react-ip:${req.ip}`, limits.reactIp),
    );
    if (wait > 0) {
      throttled(reply, wait);
      return null;
    }
    return user;
  }

  app.put('/api/public/:token/reaction', async (req, reply) => {
    const user = await reactor(req, reply);
    if (!user) return reply;
    const { token } = paramsSchema.parse(req.params);
    const { kind } = setReactionRequestSchema.parse(req.body);
    const outcome = await db.transaction(async (tx) => {
      const tank = await tankByToken(token, tx, true);
      if (!tank) return 'not_found' as const;
      if (tank.ownerId === user.id) return 'own' as const;
      await tx
        .insert(schema.tankReactions)
        .values({ tankId: tank.id, userId: user.id, kind })
        .onConflictDoUpdate({
          target: [schema.tankReactions.tankId, schema.tankReactions.userId],
          set: { kind, createdAt: sql`now()` },
        });
      await audit(tx, {
        action: 'reaction_set',
        actorId: user.id,
        tankId: tank.id,
        detail: { kind },
      });
      return tank.id;
    });
    if (outcome === 'not_found') return notFound(reply);
    if (outcome === 'own') {
      return reply.code(403).send(apiError('own_tank', 'You cannot react to your own tank.'));
    }
    return reactionState(outcome, user.id);
  });

  app.delete('/api/public/:token/reaction', async (req, reply) => {
    const user = await reactor(req, reply);
    if (!user) return reply;
    const { token } = paramsSchema.parse(req.params);
    const tank = await tankByToken(token);
    if (!tank) return notFound(reply);
    await db.transaction(async (tx) => {
      const removed = await tx
        .delete(schema.tankReactions)
        .where(
          and(eq(schema.tankReactions.tankId, tank.id), eq(schema.tankReactions.userId, user.id)),
        )
        .returning({ kind: schema.tankReactions.kind });
      if (removed.length > 0) {
        await audit(tx, { action: 'reaction_removed', actorId: user.id, tankId: tank.id });
      }
    });
    return reactionState(tank.id, user.id);
  });

  return { snapshot };
}
