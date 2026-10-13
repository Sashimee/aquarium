import { randomInt } from 'node:crypto';
import { test as base } from '@playwright/test';

// The API meters sign-ups and mail per client address and trusts X-Forwarded-For from loopback,
// as it does behind the production proxy. Each test presents its own address, so the suite
// exercises the real limits without one test spending another's budget.
export const test = base.extend({
  context: async ({ context }, use) => {
    const address = `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': address });
    await use(context);
  },
});
