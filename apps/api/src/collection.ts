import {
  ACHIEVEMENTS,
  achievementListSchema,
  collectionFacts,
  collectionSchema,
  type CollectionEntry,
  type Economy,
} from '@aquarium/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schema, type Database } from './db/index.ts';
import { claimAchievementRewards } from './earn.ts';
import { apiError } from './errors.ts';
import type { Limit, RateLimiter } from './rate-limit.ts';
import type { SpeciesCatalog } from './species.ts';
import type { SessionUser } from './tanks.ts';

export const DEFAULT_COLLECTION_LIMIT: Limit = { max: 60, windowMs: 10 * 60_000 };

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
type Executor = Pick<Database['db'], 'select' | 'insert'>;

export interface CollectionObservation {
  species: string;
  kind: 'kept' | 'bred' | 'raised';
  atMs: number;
}

function toEntry(row: typeof schema.collectionEntries.$inferSelect): CollectionEntry {
  return {
    species: row.species,
    keptAt: row.keptAt.toISOString(),
    bredAt: row.bredAt?.toISOString() ?? null,
    raisedAt: row.raisedAt?.toISOString() ?? null,
  };
}

async function loadEntries(executor: Executor, userId: string): Promise<CollectionEntry[]> {
  const rows = await executor
    .select()
    .from(schema.collectionEntries)
    .where(eq(schema.collectionEntries.userId, userId));
  return rows.map(toEntry);
}

export async function awardAchievements(
  tx: Executor,
  userId: string,
  species: SpeciesCatalog,
  now: Date,
): Promise<void> {
  const facts = collectionFacts([...(await loadEntries(tx, userId))], [...species.values()]);
  const earned = ACHIEVEMENTS.filter((a) => a.measure(facts) >= a.target);
  if (earned.length === 0) return;
  await tx
    .insert(schema.achievementAwards)
    .values(earned.map((a) => ({ userId, achievementId: a.id, earnedAt: now })))
    .onConflictDoNothing();
}

// Every write is a first-wins upsert, so a replayed request or a catch-up that re-observes the same
// fish changes nothing.
export async function recordCollection(
  tx: Tx,
  userId: string,
  species: SpeciesCatalog,
  observations: readonly CollectionObservation[],
  now: Date,
): Promise<void> {
  if (observations.length === 0) return;
  const bySpecies = new Map<string, { kept: number; bred?: number; raised?: number }>();
  for (const { species: id, kind, atMs } of observations) {
    const slot = bySpecies.get(id) ?? { kept: atMs };
    slot.kept = Math.min(slot.kept, atMs);
    if (kind !== 'kept') slot[kind] = Math.min(slot[kind] ?? atMs, atMs);
    bySpecies.set(id, slot);
  }
  const col = schema.collectionEntries;
  // Fixed lock order: concurrent ticks for one user must not lock species rows in opposite orders.
  await tx
    .insert(col)
    .values(
      [...bySpecies]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, at]) => ({
          userId,
          species: id,
          keptAt: new Date(at.kept),
          bredAt: at.bred === undefined ? null : new Date(at.bred),
          raisedAt: at.raised === undefined ? null : new Date(at.raised),
        })),
    )
    .onConflictDoUpdate({
      target: [col.userId, col.species],
      set: {
        bredAt: sql`coalesce(${col.bredAt}, excluded.bred_at)`,
        raisedAt: sql`coalesce(${col.raisedAt}, excluded.raised_at)`,
      },
    });
  await awardAchievements(tx, userId, species, now);
}

export interface CollectionRouteDeps {
  app: FastifyInstance;
  database: Database;
  species: SpeciesCatalog;
  economy: Economy;
  limiter: RateLimiter;
  limit: Limit;
  now: () => number;
  currentUser: (req: FastifyRequest) => Promise<SessionUser | null>;
}

export function registerCollectionRoutes(deps: CollectionRouteDeps): void {
  const { app, database, species, limiter, limit } = deps;

  async function load(req: FastifyRequest) {
    const user = await deps.currentUser(req);
    if (!user) return { error: [401, apiError('unauthenticated', 'Sign in required.')] } as const;
    if (!user.emailVerified) {
      return {
        error: [
          403,
          apiError('email_not_verified', 'Verify your email address before using your tank.'),
        ],
      } as const;
    }
    const wait = limiter.consume(`collection:${user.id}`, limit);
    if (wait > 0) {
      return {
        error: [429, apiError('rate_limited', `Too many requests. Try again in ${wait} s.`)],
      } as const;
    }
    const entries = await database.db.transaction(async (tx) => {
      // Backfilled users hold entries from the migration but no awards yet.
      await awardAchievements(tx, user.id, species, new Date(deps.now()));
      await claimAchievementRewards(tx, deps.economy, user.id, deps.now());
      return loadEntries(tx, user.id);
    });
    const awards = await database.db
      .select()
      .from(schema.achievementAwards)
      .where(eq(schema.achievementAwards.userId, user.id));
    return { entries, awards } as const;
  }

  app.get('/api/collection', async (req, reply) => {
    const loaded = await load(req);
    if ('error' in loaded) return reply.code(loaded.error[0]).send(loaded.error[1]);
    const byId = new Map(loaded.entries.map((e) => [e.species, e]));
    const catalog = [...species.values()];
    const facts = collectionFacts(loaded.entries, catalog);
    const unlocked = catalog
      .filter((s) => byId.has(s.id))
      .toSorted((a, b) => a.commonName.localeCompare(b.commonName))
      .map((s) => ({
        species: s.id,
        commonName: s.commonName,
        biome: s.biome,
        entry: byId.get(s.id) ?? null,
      }));
    const locked = catalog
      .filter((s) => !byId.has(s.id))
      .toSorted((a, b) => a.biome.localeCompare(b.biome) || a.id.localeCompare(b.id))
      .map((s, index) => ({
        species: `locked-${index + 1}`,
        commonName: 'Undiscovered species',
        biome: s.biome,
        entry: null,
      }));
    return collectionSchema.parse({
      species: [...unlocked, ...locked],
      kept: facts.kept,
      bred: facts.bred,
      raised: facts.raised,
      total: catalog.length,
    });
  });

  app.get('/api/achievements', async (req, reply) => {
    const loaded = await load(req);
    if ('error' in loaded) return reply.code(loaded.error[0]).send(loaded.error[1]);
    const facts = collectionFacts(loaded.entries, [...species.values()]);
    const earnedAt = new Map(loaded.awards.map((a) => [a.achievementId, a.earnedAt]));
    return achievementListSchema.parse({
      achievements: ACHIEVEMENTS.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        earnedAt: earnedAt.get(a.id)?.toISOString() ?? null,
        progress: Math.min(a.measure(facts), a.target),
        target: a.target,
      })),
    });
  });
}
