import { ACHIEVEMENTS, type Economy } from '@aquarium/shared';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { schema, type Database } from './db/index.ts';
import { credit, earnedToday, hasKey, lockWallet, utcDay, DAY_MS } from './wallet.ts';

type Tx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

export const CARE_EARN_KINDS = ['feed', 'water_change', 'gravel_vacuum', 'algae_scrape'] as const;
const MAINTENANCE_KINDS = ['water_change', 'gravel_vacuum', 'algae_scrape'] as const;

export const HEALTHY_MIN_HEALTH = 0.8;

const PREFIX = {
  dailyCare: 'earn:daily-care',
  streak: 'earn:streak:',
  achievement: 'earn:achievement:',
  fry: 'earn:fry:',
} as const;

const room = async (tx: Tx, userId: string, prefix: string, cap: number, nowMs: number) =>
  Math.max(0, cap - (await earnedToday(tx, userId, prefix, nowMs)));

export interface HealthSnapshot {
  alive: boolean;
  health: number;
}

export function isHealthyTank(fish: readonly HealthSnapshot[]): boolean {
  return fish.some((f) => f.alive) && fish.every((f) => f.alive && f.health >= HEALTHY_MIN_HEALTH);
}

// The first care of the UTC day pays the base reward. Feeding and one upkeep job on the same day
// (across all tanks) top it up to the maximum. Basic care itself is never charged or blocked.
export async function awardDailyCare(
  tx: Tx,
  economy: Economy,
  userId: string,
  nowMs: number,
): Promise<void> {
  const { reward, dailyCap } = economy.earn.dailyCare;
  const { startMs, date } = utcDay(nowMs);
  await lockWallet(tx, economy, userId, nowMs);

  const base = await room(tx, userId, PREFIX.dailyCare, dailyCap, nowMs);
  if (base > 0) {
    await credit(tx, userId, {
      amount: Math.min(reward.min, base),
      reason: 'earn',
      itemRef: `${PREFIX.dailyCare}:base`,
      key: `daily-care-${date}`,
      nowMs,
    });
  }

  const fullKey = `daily-care-full-${date}`;
  if (reward.max <= reward.min || (await hasKey(tx, userId, fullKey))) return;
  const today = await tx
    .selectDistinct({ kind: schema.events.kind })
    .from(schema.events)
    .innerJoin(schema.tanks, eq(schema.tanks.id, schema.events.tankId))
    .where(
      and(
        eq(schema.tanks.ownerId, userId),
        gte(schema.events.at, new Date(startMs)),
        inArray(schema.events.kind, [...CARE_EARN_KINDS]),
      ),
    );
  const kinds = new Set(today.map((r) => r.kind));
  if (!kinds.has('feed') || !MAINTENANCE_KINDS.some((k) => kinds.has(k))) return;
  const left = await room(tx, userId, PREFIX.dailyCare, dailyCap, nowMs);
  if (left <= 0) return;
  await credit(tx, userId, {
    amount: Math.min(reward.max - reward.min, left),
    reason: 'earn',
    itemRef: `${PREFIX.dailyCare}:full`,
    key: fullKey,
    nowMs,
  });
}

// A healthy tank that was also looked after on the previous UTC day. The cap is per account, so a
// second tank on the same day only gets what is left.
export async function awardHealthyStreak(
  tx: Tx,
  economy: Economy,
  userId: string,
  tankId: string,
  fish: readonly HealthSnapshot[],
  nowMs: number,
): Promise<void> {
  if (!isHealthyTank(fish)) return;
  const { perDay, dailyCap } = economy.earn.healthyTankStreak;
  const { startMs, date } = utcDay(nowMs);
  const key = `streak-${tankId}-${date}`;
  await lockWallet(tx, economy, userId, nowMs);
  if (await hasKey(tx, userId, key)) return;
  const yesterday = await tx
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.tankId, tankId),
        gte(schema.events.at, new Date(startMs - DAY_MS)),
        lt(schema.events.at, new Date(startMs)),
        inArray(schema.events.kind, [...CARE_EARN_KINDS]),
      ),
    )
    .limit(1);
  if (yesterday.length === 0) return;
  const left = await room(tx, userId, PREFIX.streak, dailyCap, nowMs);
  if (left <= 0) return;
  await credit(tx, userId, {
    amount: Math.min(perDay, left),
    reason: 'earn',
    itemRef: `${PREFIX.streak}${tankId}`,
    key,
    nowMs,
  });
}

// The achievement list runs from easy to hard, so the reward rises with its position from the
// economy's minimum to its maximum, in steps of 5.
export function achievementReward(economy: Economy, achievementId: string): number {
  const { min, max } = economy.earn.achievement.reward;
  const index = ACHIEVEMENTS.findIndex((a) => a.id === achievementId);
  if (index < 0) throw new Error(`unknown achievement "${achievementId}"`);
  const last = Math.max(1, ACHIEVEMENTS.length - 1);
  return Math.min(max, min + Math.round(((max - min) * index) / last / 5) * 5);
}

// Awards are stored by the collection code; this pays the ones not yet paid, oldest first, while
// the day's cap has room. An award that doesn't fit waits for tomorrow instead of being lost.
export async function claimAchievementRewards(
  tx: Tx,
  economy: Economy,
  userId: string,
  nowMs: number,
): Promise<void> {
  await lockWallet(tx, economy, userId, nowMs);
  const awards = await tx
    .select({ id: schema.achievementAwards.achievementId })
    .from(schema.achievementAwards)
    .where(eq(schema.achievementAwards.userId, userId))
    .orderBy(asc(schema.achievementAwards.earnedAt), asc(schema.achievementAwards.achievementId));
  let left = await room(tx, userId, PREFIX.achievement, economy.earn.achievement.dailyCap, nowMs);
  for (const award of awards) {
    const key = `achievement-${award.id}`;
    if (await hasKey(tx, userId, key)) continue;
    const reward = achievementReward(economy, award.id);
    if (reward > left) break;
    const paid = await credit(tx, userId, {
      amount: reward,
      reason: 'earn',
      itemRef: `${PREFIX.achievement}${award.id}`,
      key,
      nowMs,
    });
    if (paid) left -= reward;
  }
}

export async function fryRoom(
  tx: Tx,
  economy: Economy,
  userId: string,
  nowMs: number,
): Promise<number> {
  return room(tx, userId, PREFIX.fry, economy.earn.frySale.dailyCap, nowMs);
}

export const fryItemRef = (fishId: string) => `${PREFIX.fry}${fishId}`;
