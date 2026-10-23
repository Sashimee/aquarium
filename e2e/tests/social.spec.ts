import { expect, test, type Browser, type Page } from '@playwright/test';
import { APP_URL, registerVerifiedUser } from '../support/app.ts';
import {
  addFish,
  createTank,
  errorOf,
  getTank,
  key,
  patchTank,
  sameOrigin,
  type ApiTank,
} from '../support/api.ts';

async function freshPlayer(browser: Browser, label: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' });
  const page = await context.newPage();
  await registerVerifiedUser(page, label);
  return page;
}

async function anonymousVisitor(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: APP_URL, serviceWorkers: 'block' });
  return context.newPage();
}

const uniqueHandle = (prefix: string): string =>
  `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

async function setHandle(page: Page, handle: string) {
  return page.request.put('/api/me/handle', { ...sameOrigin, data: { handle } });
}

const currentHandle = async (page: Page): Promise<string | null> =>
  ((await (await page.request.get('/api/me/handle')).json()) as { handle: string | null }).handle;

test.describe('handles', () => {
  test('a handle is claimed once, shown back, and refused when taken, reserved or not allowed', async ({
    page,
    browser,
  }) => {
    await registerVerifiedUser(page, 'handles');
    expect(await currentHandle(page)).toBeNull();

    const handle = uniqueHandle('fan');
    const claimed = await setHandle(page, handle);
    expect(claimed.status()).toBe(200);
    expect(await claimed.json()).toEqual({ handle });
    expect(await currentHandle(page)).toBe(handle);
    expect((await setHandle(page, handle)).status(), 'saving the same handle again is fine').toBe(
      200,
    );

    const rival = await freshPlayer(browser, 'rival');
    const taken = await setHandle(rival, handle);
    expect(taken.status()).toBe(409);
    expect((await errorOf(taken)).message).toContain('taken');

    for (const bad of [
      'admin',
      'fuck_you',
      'ab',
      'Has_Capitals',
      'has space',
      'x'.repeat(21),
      '9starts_with_digit',
    ]) {
      const refused = await setHandle(rival, bad);
      expect(refused.status(), `"${bad}" is refused`).toBe(400);
    }
    expect(await currentHandle(rival)).toBeNull();

    const anonymous = await anonymousVisitor(browser);
    const noSession = await setHandle(anonymous, uniqueHandle('anon'));
    expect(noSession.status()).toBe(401);
    await rival.context().close();
    await anonymous.context().close();
  });

  test('a released handle stays reserved for its old owner for a while', async ({
    page,
    browser,
  }) => {
    await registerVerifiedUser(page, 'release');
    const first = uniqueHandle('old');
    const second = uniqueHandle('new');
    expect((await setHandle(page, first)).status()).toBe(200);
    expect((await setHandle(page, second)).status()).toBe(200);
    expect(await currentHandle(page)).toBe(second);

    const other = await freshPlayer(browser, 'latecomer');
    const cooling = await setHandle(other, first);
    expect(cooling.status()).toBe(409);
    expect((await errorOf(cooling)).message).toContain('released recently');
    await other.context().close();
  });
});

test.describe('gifts and trades', () => {
  async function setup(browser: Browser, page: Page) {
    const sender = page;
    const senderTank = await createTank(sender, { name: 'Giver' });
    const withFish = await addFish(sender, senderTank.id, 'neon-tetra', { name: 'Sparky' });
    const fishId = withFish.fish[0]?.id;
    if (!fishId) throw new Error('the sender fish was not created');

    const recipient = await freshPlayer(browser, 'receiver');
    const handle = uniqueHandle('rcv');
    expect((await setHandle(recipient, handle)).status()).toBe(200);
    const recipientTank = await createTank(recipient, { name: 'Taker' });
    return { sender, senderTank, fishId, recipient, recipientTank, handle };
  }

  const offer = (
    page: Page,
    data: {
      fromTankId: string;
      fishId: string;
      toHandle: string;
      wantsReturn?: boolean;
      idempotencyKey?: string;
    },
  ) =>
    page.request.post('/api/gifts', {
      ...sameOrigin,
      data: { wantsReturn: false, idempotencyKey: key(), ...data },
    });

  const livingNames = async (page: Page, tank: ApiTank): Promise<string[]> =>
    (await getTank(page, tank.id)).fish.filter((f) => f.status === 'alive').map((f) => f.id);

  test('a gift needs a tank that takes gifts, holds the fish in escrow, and moves it on accept', async ({
    page,
    browser,
  }) => {
    await registerVerifiedUser(page, 'giver');
    const { sender, senderTank, fishId, recipient, recipientTank, handle } = await setup(
      browser,
      page,
    );
    const request = { fromTankId: senderTank.id, fishId, toHandle: handle };

    const closed = await offer(sender, request);
    expect(closed.status()).toBe(409);
    expect((await errorOf(closed)).reason).toBe('gifts_closed');
    expect(await livingNames(sender, senderTank), 'a refused offer keeps the fish').toEqual([
      fishId,
    ]);

    expect((await patchTank(recipient, recipientTank.id, { acceptsGifts: true })).status()).toBe(
      200,
    );

    const ownHandle = uniqueHandle('own');
    expect((await setHandle(sender, ownHandle)).status()).toBe(200);
    const self = await offer(sender, { ...request, toHandle: ownHandle });
    expect(self.status()).toBe(400);
    expect((await offer(sender, { ...request, toHandle: 'nobody_has_this_handle' })).status()).toBe(
      404,
    );

    const idempotencyKey = key();
    const sent = await offer(sender, { ...request, idempotencyKey });
    expect(sent.status()).toBe(201);
    const { offer: created } = (await sent.json()) as {
      offer: { id: string; status: string; role: string };
    };
    expect(created).toMatchObject({ status: 'open', role: 'sender' });
    expect(await livingNames(sender, senderTank), 'the fish waits in escrow').toEqual([]);

    const replay = await offer(sender, { ...request, idempotencyKey });
    expect(replay.status()).toBe(200);
    expect(((await replay.json()) as { offer: { id: string } }).offer.id).toBe(created.id);

    const incoming = (await (await recipient.request.get('/api/gifts')).json()) as {
      incoming: { id: string; status: string; counterpart: string | null }[];
    };
    expect(incoming.incoming.map((o) => o.id)).toContain(created.id);
    const outgoing = (await (await sender.request.get('/api/gifts')).json()) as {
      outgoing: { id: string }[];
    };
    expect(outgoing.outgoing.map((o) => o.id)).toContain(created.id);

    const stranger = await freshPlayer(browser, 'bystander');
    const meddling = await stranger.request.post(`/api/gifts/${created.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: recipientTank.id, idempotencyKey: key() },
    });
    expect(meddling.status(), 'only the recipient can accept').toBe(404);
    await stranger.context().close();

    const accept = await recipient.request.post(`/api/gifts/${created.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: recipientTank.id, idempotencyKey: key() },
    });
    expect(accept.status()).toBe(200);
    const accepted = (await accept.json()) as {
      offer: { status: string };
      arrival: { fishId: string; tankId: string } | null;
    };
    expect(accepted.offer.status).toBe('accepted');
    expect(accepted.arrival).toMatchObject({ fishId, tankId: recipientTank.id });
    expect(await livingNames(recipient, recipientTank)).toEqual([fishId]);
    expect(await livingNames(sender, senderTank)).toEqual([]);

    const again = await recipient.request.post(`/api/gifts/${created.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: recipientTank.id, idempotencyKey: key() },
    });
    expect(again.status()).toBe(409);
    expect((await errorOf(again)).reason).toBe('offer_closed');
    await recipient.context().close();
  });

  test('declining or cancelling an offer sends the fish back to its tank', async ({
    page,
    browser,
  }) => {
    await registerVerifiedUser(page, 'giver2');
    const { sender, senderTank, fishId, recipient, recipientTank, handle } = await setup(
      browser,
      page,
    );
    expect((await patchTank(recipient, recipientTank.id, { acceptsGifts: true })).status()).toBe(
      200,
    );
    const request = { fromTankId: senderTank.id, fishId, toHandle: handle };

    const first = (await (await offer(sender, request)).json()) as { offer: { id: string } };
    expect(await livingNames(sender, senderTank)).toEqual([]);
    const declined = await recipient.request.post(
      `/api/gifts/${first.offer.id}/decline`,
      sameOrigin,
    );
    expect(declined.status()).toBe(200);
    expect(await declined.json()).toMatchObject({ offer: { status: 'declined' } });
    expect(await livingNames(sender, senderTank)).toEqual([fishId]);
    expect(
      (await recipient.request.post(`/api/gifts/${first.offer.id}/decline`, sameOrigin)).status(),
      'a repeat replays',
    ).toBe(200);

    const second = (await (await offer(sender, request)).json()) as { offer: { id: string } };
    const cancelled = await sender.request.post(`/api/gifts/${second.offer.id}/cancel`, sameOrigin);
    expect(cancelled.status()).toBe(200);
    expect(await cancelled.json()).toMatchObject({ offer: { status: 'cancelled' } });
    expect(await livingNames(sender, senderTank)).toEqual([fishId]);

    const lateAccept = await recipient.request.post(`/api/gifts/${second.offer.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: recipientTank.id, idempotencyKey: key() },
    });
    expect(lateAccept.status()).toBe(409);
    expect(await livingNames(recipient, recipientTank)).toEqual([]);
    await recipient.context().close();
  });

  test('a fish goes only to a tank of its own biome', async ({ page, browser }) => {
    await registerVerifiedUser(page, 'giver3');
    const { sender, senderTank, fishId, recipient, handle } = await setup(browser, page);
    const reef = await createTank(recipient, { name: 'Reef', biome: 'reef' });
    expect((await patchTank(recipient, reef.id, { acceptsGifts: true })).status()).toBe(200);

    const sent = (await (
      await offer(sender, { fromTankId: senderTank.id, fishId, toHandle: handle })
    ).json()) as {
      offer: { id: string };
    };
    const wrong = await recipient.request.post(`/api/gifts/${sent.offer.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: reef.id, idempotencyKey: key() },
    });
    expect(wrong.status()).toBe(409);
    expect((await errorOf(wrong)).reason).toBe('wrong_biome');
    expect(await livingNames(recipient, reef)).toEqual([]);
    await recipient.context().close();
  });

  test('a trade needs a fish back, and the sender confirms the swap', async ({ page, browser }) => {
    await registerVerifiedUser(page, 'trader');
    const { sender, senderTank, fishId, recipient, recipientTank, handle } = await setup(
      browser,
      page,
    );
    expect((await patchTank(recipient, recipientTank.id, { acceptsGifts: true })).status()).toBe(
      200,
    );
    expect((await patchTank(sender, senderTank.id, { acceptsGifts: true })).status()).toBe(200);
    const theirs = await addFish(recipient, recipientTank.id, 'neon-tetra', { name: 'Zippy' });
    const theirFish = theirs.fish[0]?.id;
    if (!theirFish) throw new Error('the recipient fish was not created');

    const sent = (await (
      await offer(sender, {
        fromTankId: senderTank.id,
        fishId,
        toHandle: handle,
        wantsReturn: true,
      })
    ).json()) as { offer: { id: string } };

    const noReturn = await recipient.request.post(`/api/gifts/${sent.offer.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: recipientTank.id, idempotencyKey: key() },
    });
    expect(noReturn.status()).toBe(400);

    const pledged = await recipient.request.post(`/api/gifts/${sent.offer.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: recipientTank.id, returnFishId: theirFish, idempotencyKey: key() },
    });
    expect(pledged.status()).toBe(200);
    expect(await pledged.json()).toMatchObject({ offer: { status: 'countered' }, arrival: null });
    expect(
      await livingNames(recipient, recipientTank),
      'nothing moves before the sender agrees',
    ).toEqual([theirFish]);

    const confirmed = await sender.request.post(`/api/gifts/${sent.offer.id}/confirm`, {
      ...sameOrigin,
      data: { toTankId: senderTank.id, idempotencyKey: key() },
    });
    expect(confirmed.status()).toBe(200);
    expect(await confirmed.json()).toMatchObject({ offer: { status: 'accepted' } });
    expect(await livingNames(sender, senderTank)).toEqual([theirFish]);
    expect(await livingNames(recipient, recipientTank)).toEqual([fishId]);
    await recipient.context().close();
  });
});

test.describe('gallery', () => {
  test('a listed tank can be voted for, once a week, never by its owner', async ({
    page,
    browser,
  }) => {
    await registerVerifiedUser(page, 'gallery');
    const mine = await createTank(page, { name: `Gallery ${crypto.randomUUID().slice(0, 8)}` });
    await addFish(page, mine.id, 'neon-tetra');

    const noLink = await page.request.put(`/api/tanks/${mine.id}/gallery`, {
      ...sameOrigin,
      data: { listed: true },
    });
    expect(noLink.status(), 'a private tank cannot be listed').toBe(409);

    expect((await page.request.post(`/api/tanks/${mine.id}/share`, sameOrigin)).ok()).toBe(true);
    expect(
      (
        await page.request.put(`/api/tanks/${mine.id}/gallery`, {
          ...sameOrigin,
          data: { listed: true },
        })
      ).ok(),
    ).toBe(true);

    const other = await createTank(page, { name: `Other ${crypto.randomUUID().slice(0, 8)}` });
    const quarantine = await page.request.put(`/api/tanks/${other.id}/gallery`, {
      ...sameOrigin,
      data: { listed: true },
    });
    expect(quarantine.status(), 'a tank with no public link is not listed').toBe(409);

    const ownVote = await page.request.put('/api/gallery/vote', {
      ...sameOrigin,
      data: { tankId: mine.id },
    });
    expect(ownVote.status()).toBe(403);

    const voter = await freshPlayer(browser, 'voter');
    const before = (await (await voter.request.get('/api/gallery')).json()) as {
      entries: { id: string; votes: number; voted: boolean; mine: boolean }[];
      myVote: string | null;
    };
    expect(before.entries.find((e) => e.id === mine.id)).toMatchObject({
      votes: 0,
      voted: false,
      mine: false,
    });

    const cast = await voter.request.put('/api/gallery/vote', {
      ...sameOrigin,
      data: { tankId: mine.id },
    });
    expect(cast.status()).toBe(200);
    expect(await cast.json()).toMatchObject({ myVote: mine.id });
    expect(
      (
        await voter.request.put('/api/gallery/vote', { ...sameOrigin, data: { tankId: mine.id } })
      ).status(),
      'voting twice is one vote',
    ).toBe(200);

    const after = (await (await voter.request.get('/api/gallery')).json()) as typeof before;
    expect(after.entries.find((e) => e.id === mine.id)).toMatchObject({ votes: 1, voted: true });
    expect(after.myVote).toBe(mine.id);
    const owner = (await (await page.request.get('/api/gallery')).json()) as typeof before;
    expect(owner.entries.find((e) => e.id === mine.id)).toMatchObject({ votes: 1, mine: true });

    const missing = await voter.request.put('/api/gallery/vote', {
      ...sameOrigin,
      data: { tankId: other.id },
    });
    expect(missing.status(), 'an unlisted tank takes no votes').toBe(404);

    const taken = await voter.request.delete('/api/gallery/vote', sameOrigin);
    expect(taken.status()).toBe(200);
    expect(await taken.json()).toMatchObject({ myVote: null });

    const anonymous = await anonymousVisitor(browser);
    const noSession = await anonymous.request.put('/api/gallery/vote', {
      ...sameOrigin,
      data: { tankId: mine.id },
    });
    expect(noSession.status()).toBe(401);

    expect(
      (
        await page.request.put(`/api/tanks/${mine.id}/gallery`, {
          ...sameOrigin,
          data: { listed: false },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (await anonymous.request.get(`/api/gallery/${mine.id}`)).status(),
      'unlisting hides it',
    ).toBe(404);
    await voter.context().close();
    await anonymous.context().close();
  });

  test('the gallery page lists a tank and the vote button toggles', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await registerVerifiedUser(page, 'galleryowner');
    const name = `Showpiece ${crypto.randomUUID().slice(0, 8)}`;
    const tank = await createTank(page, { name });
    expect((await page.request.post(`/api/tanks/${tank.id}/share`, sameOrigin)).ok()).toBe(true);
    expect(
      (
        await page.request.put(`/api/tanks/${tank.id}/gallery`, {
          ...sameOrigin,
          data: { listed: true },
        })
      ).ok(),
    ).toBe(true);

    const voter = await freshPlayer(browser, 'galleryvoter');
    await voter.route('**/assets/**', (route) => {
      const { pathname } = new URL(route.request().url());
      return /\.(js|css)$/.test(pathname) ? route.continue() : route.abort();
    });
    await voter.goto('/gallery?backend=webgl&tier=low');
    await expect(voter.getByRole('heading', { name: "This week's tanks" })).toBeVisible();
    const vote = voter.getByRole('button', { name: new RegExp(`^Vote for ${name}, `) });
    await vote.click();
    const taken = voter.getByRole('button', {
      name: new RegExp(`^Take back your vote for ${name}, `),
    });
    await expect(taken).toHaveAttribute('aria-pressed', 'true');
    await taken.click();
    await expect(
      voter.getByRole('button', { name: new RegExp(`^Vote for ${name}, `) }),
    ).toBeVisible();
    await voter.context().close();
  });
});

test.describe('community tank', () => {
  test('anyone can look, a signed-in player feeds a limited share, and the whole tank has a cap', async ({
    page,
    browser,
  }) => {
    const anonymous = await anonymousVisitor(browser);
    const seen = await anonymous.request.get('/api/community');
    expect(seen.status()).toBe(200);
    expect(await seen.json()).toMatchObject({ quota: null });
    const feed = await anonymous.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 0.5, idempotencyKey: key() },
    });
    expect(feed.status()).toBe(401);

    await registerVerifiedUser(page, 'feeder');
    const fresh = (await (await page.request.get('/api/community')).json()) as {
      quota: { limit: number; used: number; remaining: number };
    };
    expect(fresh.quota).toMatchObject({ limit: 2, used: 0, remaining: 2 });

    const idempotencyKey = key();
    const first = await page.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 0.5, idempotencyKey },
    });
    expect(first.status()).toBe(201);
    expect(await first.json()).toMatchObject({
      replayed: false,
      state: { quota: { used: 0.5, remaining: 1.5 } },
    });

    const replay = await page.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 0.5, idempotencyKey },
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, state: { quota: { used: 0.5 } } });

    const different = await page.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'pellets', portion: 0.5, idempotencyKey },
    });
    expect(different.status()).toBe(409);

    const tooMuch = await page.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 1, idempotencyKey: key() },
    });
    expect(tooMuch.status()).toBe(201);
    const over = await page.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 1, idempotencyKey: key() },
    });
    expect(over.status()).toBe(429);
    expect((await errorOf(over)).code).toBe('quota_exceeded');
    expect(over.headers()['retry-after']).toBeDefined();

    const huge = await page.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 5, idempotencyKey: key() },
    });
    expect(huge.status(), 'a portion above the maximum is refused').toBe(400);
    await anonymous.context().close();
  });

  test('the tank-wide cap stops a crowd from overfeeding', async ({ browser }) => {
    const feeders: Page[] = [];
    let refused = 0;
    for (let n = 0; n < 4; n += 1) feeders.push(await freshPlayer(browser, `crowd${n}`));
    for (const feeder of feeders) {
      const res = await feeder.request.post('/api/community/feed', {
        ...sameOrigin,
        data: { food: 'flakes', portion: 1, idempotencyKey: key() },
      });
      if (res.status() === 429) refused += 1;
      else expect(res.status()).toBe(201);
    }
    expect(
      refused,
      'four whole portions exceed what the tank takes in three hours',
    ).toBeGreaterThanOrEqual(1);
    for (const feeder of feeders) await feeder.context().close();
  });
});
