import {
  achievementListSchema,
  collectionSchema,
  dataExportSchema,
  tankSchema,
  type AchievementList,
  type Collection,
} from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, fishPayload, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
const DAY = 24 * 60;
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function signedIn(h: Harness) {
  const email = `t51-${Date.now()}-${counter++}@bas.lu`;
  await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(
    h.outbox.findLast((m) => m.to === email)?.text ?? '',
  )?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(await h.app.inject(url.pathname + url.search));
  if (!cookie) throw new Error('verification did not sign in');
  const [user] = await h.database.db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!user) throw new Error('user missing');
  return { cookie, userId: user.id };
}

const call = (
  h: Harness,
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
) =>
  h.app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie },
    ...(payload ? { payload } : {}),
  });

const advance = (h: Harness, minutes: number) =>
  h.app.inject({
    method: 'POST',
    url: '/api/test/advance-time',
    headers: jsonHeaders,
    payload: { minutes },
  });

async function createTank(h: Harness, cookie: string) {
  const res = await call(h, cookie, 'POST', '/api/tanks', { name: 'Home', biome: 'freshwater' });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json());
}

async function addFish(h: Harness, cookie: string, tankId: string, species: string, name: string) {
  const res = await call(
    h,
    cookie,
    'POST',
    `/api/tanks/${tankId}/fish`,
    fishPayload(species, name),
  );
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json());
}

async function readCollection(h: Harness, cookie: string): Promise<Collection> {
  const res = await call(h, cookie, 'GET', '/api/collection');
  expect(res.statusCode).toBe(200);
  return collectionSchema.parse(res.json());
}

async function readAchievements(h: Harness, cookie: string): Promise<AchievementList> {
  const res = await call(h, cookie, 'GET', '/api/achievements');
  expect(res.statusCode).toBe(200);
  return achievementListSchema.parse(res.json());
}

const earned = (list: AchievementList) =>
  list.achievements.filter((a) => a.earnedAt !== null).map((a) => a.id);

describe('collection book and achievements', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('requires a signed-in session', async () => {
    expect((await h.app.inject('/api/collection')).statusCode).toBe(401);
    expect((await h.app.inject('/api/achievements')).statusCode).toBe(401);
  });

  it('gives a new user an empty book and no achievements', async () => {
    const { cookie } = await signedIn(h);
    const book = await readCollection(h, cookie);
    expect(book.kept).toBe(0);
    expect(book.total).toBe(book.species.length);
    expect(book.total).toBeGreaterThan(0);
    expect(book.species.every((s) => s.entry === null)).toBe(true);
    const list = await readAchievements(h, cookie);
    expect(earned(list)).toEqual([]);
    expect(list.achievements.every((a) => a.progress === 0)).toBe(true);
  });

  it('records a species once however often it is kept, and awards once', async () => {
    const { cookie } = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id, 'neon-tetra', 'A');
    const first = await readCollection(h, cookie);
    const entry = first.species.find((s) => s.species === 'neon-tetra')?.entry;
    expect(entry?.bredAt).toBeNull();
    expect(first.kept).toBe(1);
    const firstAwards = await readAchievements(h, cookie);
    expect(earned(firstAwards)).toEqual(['first-fish']);
    const stamp = firstAwards.achievements.find((a) => a.id === 'first-fish')?.earnedAt;

    await advance(h, DAY);
    await addFish(h, cookie, tank.id, 'neon-tetra', 'B');
    await addFish(h, cookie, tank.id, 'guppy', 'C');
    const again = await readCollection(h, cookie);
    expect(again.kept).toBe(2);
    expect(again.species.find((s) => s.species === 'neon-tetra')?.entry?.keptAt).toBe(
      entry?.keptAt,
    );
    const awards = await readAchievements(h, cookie);
    expect(earned(awards)).toEqual(['first-fish']);
    expect(awards.achievements.find((a) => a.id === 'first-fish')?.earnedAt).toBe(stamp);
    expect(awards.achievements.find((a) => a.id === 'kept-5')?.progress).toBe(2);
    const rows = await h.database.db
      .select()
      .from(schema.achievementAwards)
      .where(eq(schema.achievementAwards.achievementId, 'first-fish'));
    expect(rows.filter((r) => stamp && r.earnedAt.toISOString() === stamp)).toHaveLength(1);
  });

  it('records breeding and raising through a catch-up, once, and keeps them after deletions', async () => {
    const { cookie, userId } = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id, 'guppy', 'Mum');
    const both = await addFish(h, cookie, tank.id, 'guppy', 'Dad');
    const [mum, dad] = both.fish;
    const grownUp = new Date(h.clock.now() - 400 * DAY * 60_000);
    await h.database.db
      .update(schema.fish)
      .set({ sex: 'female', bornAt: grownUp })
      .where(eq(schema.fish.id, mum?.id ?? ''));
    await h.database.db
      .update(schema.fish)
      .set({ sex: 'male', bornAt: grownUp })
      .where(eq(schema.fish.id, dad?.id ?? ''));

    let bredAt: string | null = null;
    for (let i = 0; i < 40 && !bredAt; i++) {
      await h.database.db
        .update(schema.fish)
        .set({ hunger: 0 })
        .where(eq(schema.fish.tankId, tank.id));
      await advance(h, 6 * 60);
      await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
      bredAt =
        (await readCollection(h, cookie)).species.find((s) => s.species === 'guppy')?.entry
          ?.bredAt ?? null;
    }
    if (!bredAt) throw new Error('no brood within 10 simulated days');
    expect(earned(await readAchievements(h, cookie))).toEqual(
      expect.arrayContaining(['first-fish', 'first-fry']),
    );

    const [entry] = await h.database.db
      .select()
      .from(schema.collectionEntries)
      .where(eq(schema.collectionEntries.userId, userId));
    expect(entry?.bredAt?.toISOString()).toBe(bredAt);

    await h.database.db
      .update(schema.fish)
      .set({ bornAt: grownUp, hunger: 0 })
      .where(eq(schema.fish.stage, 'fry'));
    await advance(h, 30);
    await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    await advance(h, 30);
    await call(h, cookie, 'GET', `/api/tanks/${tank.id}`);
    const later = await readCollection(h, cookie);
    const guppy = later.species.find((s) => s.species === 'guppy')?.entry;
    expect(guppy?.bredAt).toBe(bredAt);
    expect(guppy?.raisedAt).not.toBeNull();
    const awards = await readAchievements(h, cookie);
    expect(earned(awards)).toContain('first-adult');
    const awardCount = await h.database.db
      .select()
      .from(schema.achievementAwards)
      .where(eq(schema.achievementAwards.userId, userId));
    expect(awardCount).toHaveLength(earned(awards).length);

    await h.database.db.delete(schema.fish).where(eq(schema.fish.tankId, tank.id));
    await h.database.db.delete(schema.tanks).where(eq(schema.tanks.id, tank.id));
    const afterDelete = await readCollection(h, cookie);
    expect(afterDelete.species.find((s) => s.species === 'guppy')?.entry).toEqual(guppy);
    expect(earned(await readAchievements(h, cookie))).toEqual(earned(awards));
  });

  it('keeps a species after its fish dies and is netted', async () => {
    const { cookie } = await signedIn(h);
    const tank = await createTank(h, cookie);
    const withFish = await addFish(h, cookie, tank.id, 'betta', 'Doomed');
    const fishId = withFish.fish[0]?.id ?? '';
    await h.database.db
      .update(schema.fish)
      .set({ status: 'dead', diedAt: new Date(h.clock.now()), cause: 'unknown' })
      .where(eq(schema.fish.id, fishId));
    expect(
      (await call(h, cookie, 'DELETE', `/api/tanks/${tank.id}/fish/${fishId}`)).statusCode,
    ).toBe(200);
    const book = await readCollection(h, cookie);
    expect(book.species.find((s) => s.species === 'betta')?.entry).not.toBeNull();
  });

  it('keeps each user book separate', async () => {
    const a = await signedIn(h);
    const b = await signedIn(h);
    const tank = await createTank(h, a.cookie);
    await addFish(h, a.cookie, tank.id, 'guppy', 'Mine');
    expect((await readCollection(h, a.cookie)).kept).toBe(1);
    expect((await readCollection(h, b.cookie)).kept).toBe(0);
  });

  it('includes the book in the export and removes it on account deletion', async () => {
    const { cookie, userId } = await signedIn(h);
    const tank = await createTank(h, cookie);
    await addFish(h, cookie, tank.id, 'guppy', 'Keep');
    await readAchievements(h, cookie);

    const exported = await call(h, cookie, 'POST', '/api/me/export', {});
    expect(exported.statusCode).toBe(200);
    const data = dataExportSchema.parse(exported.json());
    expect(data.collection.entries).toHaveLength(1);
    expect(data.collection.entries[0]).toMatchObject({ species: 'guppy' });
    expect(data.collection.achievements.map((r) => r['achievementId'])).toEqual(['first-fish']);

    const deleted = await call(h, cookie, 'POST', '/api/me/delete', { password: PASSWORD });
    expect(deleted.statusCode).toBe(204);
    expect(
      await h.database.db
        .select()
        .from(schema.collectionEntries)
        .where(eq(schema.collectionEntries.userId, userId)),
    ).toEqual([]);
    expect(
      await h.database.db
        .select()
        .from(schema.achievementAwards)
        .where(eq(schema.achievementAwards.userId, userId)),
    ).toEqual([]);
  });

  it('rate-limits reads', async () => {
    const limited = await createHarness({ collectionLimit: { max: 2, windowMs: 60_000 } });
    try {
      const { cookie } = await signedIn(limited);
      expect((await call(limited, cookie, 'GET', '/api/collection')).statusCode).toBe(200);
      expect((await call(limited, cookie, 'GET', '/api/achievements')).statusCode).toBe(200);
      expect((await call(limited, cookie, 'GET', '/api/collection')).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
