import { randomUUID } from 'node:crypto';
import { tankSchema } from '@aquarium/shared';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CARE_LIMITS } from './tanks.ts';
import { APP_ORIGIN, createHarness, fishPayload, topUp, type Harness } from './test-harness.ts';

const PASSWORD = 'correct horse battery';
const jsonHeaders = { 'content-type': 'application/json', origin: APP_ORIGIN };
let counter = 0;

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function signedIn(h: Harness): Promise<string> {
  const email = `replay-${Date.now()}-${counter++}@bas.lu`;
  const signedUp = await h.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: jsonHeaders,
    payload: { email, password: PASSWORD, name: 'Tester', callbackURL: '/verify-email' },
  });
  const mail = h.outbox.findLast((m) => m.to === email);
  const link = /https?:\/\/\S+verify-email\?\S+/.exec(mail?.text ?? '')?.[0];
  if (!link) throw new Error('no verification link');
  const url = new URL(link);
  const cookie = cookieOf(
    await h.app.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { cookie: cookieOf(signedUp) },
    }),
  );
  if (!cookie) throw new Error('verification did not sign in');
  return cookie;
}

const call = (h: Harness, cookie: string, url: string, payload: object) =>
  h.app.inject({ method: 'POST', url, headers: { ...jsonHeaders, cookie }, payload });

async function createTank(h: Harness, cookie: string): Promise<string> {
  await topUp(h);
  const res = await call(h, cookie, '/api/tanks', {
    name: 'Home',
    biome: 'freshwater',
    idempotencyKey: randomUUID(),
  });
  expect(res.statusCode).toBe(201);
  return tankSchema.parse(res.json()).id;
}

describe('idempotent replay before the rate limit', () => {
  it('replays a purchased fish instead of answering 429', async () => {
    const h = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, addFish: { max: 1, windowMs: 60_000 } },
    });
    try {
      const cookie = await signedIn(h);
      const tankId = await createTank(h, cookie);
      const url = `/api/tanks/${tankId}/fish`;
      const body = fishPayload('neon-tetra', 'Blip');
      expect((await call(h, cookie, url, body)).statusCode).toBe(201);
      const retry = await call(h, cookie, url, body);
      expect(retry.statusCode).toBe(200);
      expect(tankSchema.parse(retry.json()).fish).toHaveLength(1);
      const fresh = await call(h, cookie, url, fishPayload('neon-tetra', 'Other'));
      expect(fresh.statusCode).toBe(429);
    } finally {
      await h.close();
    }
  });

  it('replays bottled bacteria instead of answering 429', async () => {
    const h = await createHarness({
      careLimits: { ...DEFAULT_CARE_LIMITS, care: { max: 1, windowMs: 60_000 } },
    });
    try {
      const cookie = await signedIn(h);
      const tankId = await createTank(h, cookie);
      const care = (idempotencyKey: string) =>
        call(h, cookie, `/api/tanks/${tankId}/care`, { type: 'bottled_bacteria', idempotencyKey });
      const key = randomUUID();
      expect((await care(key)).statusCode).toBe(200);
      expect((await care(key)).statusCode).toBe(200);
      expect((await care(randomUUID())).statusCode).toBe(429);
    } finally {
      await h.close();
    }
  });
});
