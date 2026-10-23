import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORIGIN, createHarness, type Harness } from './test-harness.ts';

const SIGN_UP_MAX = 12;
const PER_HARNESS = 8;
const json = { 'content-type': 'application/json', origin: APP_ORIGIN };
const generous = { window: 60, max: 10_000 };
let counter = 0;

describe('per-harness auth rate-limit store (#1472)', () => {
  let first: Harness;
  let second: Harness;
  beforeAll(async () => {
    const authLimits = {
      signIn: generous,
      signUp: { window: 60, max: SIGN_UP_MAX },
      sendVerification: generous,
      passwordReset: generous,
    };
    [first, second] = await Promise.all([
      createHarness({ authLimits }),
      createHarness({ authLimits }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([first?.close(), second?.close()]);
  });

  const signUp = (h: Harness) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: json,
      payload: {
        email: `t1478-${Date.now()}-${counter++}@bas.lu`,
        password: 'correct horse battery',
        name: 'Tester',
        callbackURL: '/verify-email',
      },
    });

  it('counts sign-ups per harness, so two together past the limit are never refused', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PER_HARNESS; i++) {
      statuses.push((await signUp(first)).statusCode, (await signUp(second)).statusCode);
    }
    expect(statuses).toHaveLength(2 * PER_HARNESS);
    expect(2 * PER_HARNESS).toBeGreaterThan(SIGN_UP_MAX);
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  it('still refuses a single harness once it passes the limit', async () => {
    const remaining = SIGN_UP_MAX - PER_HARNESS;
    const responses = [];
    for (let i = 0; i <= remaining; i++) responses.push(await signUp(first));
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.slice(0, remaining)).not.toContain(429);
    expect(statuses[remaining]).toBe(429);
    expect(Number(responses[remaining]?.headers['x-retry-after'])).toBeGreaterThan(0);
  });
});
