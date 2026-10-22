import { randomUUID } from 'node:crypto';
import { tankSchema } from '@aquarium/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from './db/index.ts';
import { APP_ORIGIN, createHarness, topUp, type Harness } from './test-harness.ts';

const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function signedIn(h: Harness): Promise<string> {
  const email = `doses-${randomUUID()}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: {
      email,
      password: 'correct horse battery',
      name: 'Tester',
      callbackURL: '/verify-email',
    },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const verified = await h.app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { cookie: cookieOf(signedUp) },
  });
  const cookie = cookieOf(verified);
  if (!cookie) throw new Error('verification did not sign in');
  return cookie;
}

describe('salt, buffer and botanicals care actions', () => {
  let h: Harness;
  let cookie: string;
  beforeAll(async () => {
    h = await createHarness();
    cookie = await signedIn(h);
    await topUp(h);
  });
  afterAll(() => h.close());

  async function newTank(biome: 'freshwater' | 'reef' | 'blackwater') {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/tanks',
      headers: { ...jsonHeaders, cookie },
      payload: { name: biome, biome, idempotencyKey: randomUUID() },
    });
    expect(res.statusCode).toBe(201);
    return tankSchema.parse(res.json());
  }

  const care = (tankId: string, payload: object) =>
    h.app.inject({
      method: 'POST',
      url: `/api/tanks/${tankId}/care`,
      headers: { ...jsonHeaders, cookie },
      payload,
    });

  const kinds = async (tankId: string) =>
    (
      await h.database.db
        .select({ kind: schema.events.kind })
        .from(schema.events)
        .where(eq(schema.events.tankId, tankId))
    ).map((e) => e.kind);

  it('doses salt in a reef tank, dilutes it on a water change, and logs both events', async () => {
    const tank = await newTank('reef');
    await h.database.db
      .update(schema.tanks)
      .set({ chemistry: { ...tank.chemistry, salinity: 20 } })
      .where(eq(schema.tanks.id, tank.id));
    const dosed = tankSchema.parse((await care(tank.id, { type: 'salt_dose' })).json());
    expect(dosed.chemistry.salinity).toBeGreaterThan(20);
    expect(dosed.chemistry.salinity).toBeLessThan(35);
    await h.database.db
      .update(schema.tanks)
      .set({ chemistry: { ...dosed.chemistry, salinity: 40 } })
      .where(eq(schema.tanks.id, tank.id));
    const diluted = tankSchema.parse((await care(tank.id, { type: 'water_change' })).json());
    expect(diluted.chemistry.salinity).toBeLessThan(40);
    expect(diluted.chemistry.salinity).toBeGreaterThan(35);
    expect(await kinds(tank.id)).toEqual(['salt_dose', 'water_change']);
  });

  it('refuses salt on a freshwater tank with 422 and logs nothing', async () => {
    const tank = await newTank('freshwater');
    expect((await care(tank.id, { type: 'salt_dose' })).statusCode).toBe(422);
    expect(await kinds(tank.id)).toEqual([]);
  });

  it('buffers a freshwater tank up to its ceiling, then refuses', async () => {
    const tank = await newTank('freshwater');
    const dose = () => care(tank.id, { type: 'buffer_dose', idempotencyKey: randomUUID() });
    const first = tankSchema.parse((await dose()).json());
    expect(first.chemistry.kh).toBeGreaterThan(tank.chemistry.kh);
    await h.database.db
      .update(schema.tanks)
      .set({ chemistry: { ...first.chemistry, kh: 10 } })
      .where(eq(schema.tanks.id, tank.id));
    expect((await dose()).statusCode).toBe(422);
    expect(await kinds(tank.id)).toEqual(['buffer_dose']);
  });

  it('adds tannin in a blackwater tank and a water change dilutes it', async () => {
    const tank = await newTank('blackwater');
    expect(tank.water.tannin).toBe(0);
    const dosed = tankSchema.parse(
      (await care(tank.id, { type: 'add_botanicals', idempotencyKey: randomUUID() })).json(),
    );
    expect(dosed.water.tannin).toBeGreaterThan(0);
    expect(dosed.chemistry.ph).toBeLessThan(tank.chemistry.ph);
    const changed = tankSchema.parse((await care(tank.id, { type: 'water_change' })).json());
    expect(changed.water.tannin).toBeLessThan(dosed.water.tannin);
    expect(await kinds(tank.id)).toEqual(['add_botanicals', 'water_change']);
  });
});
