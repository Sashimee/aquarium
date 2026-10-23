import { expect, test, type Page } from '@playwright/test';
import {
  awaitLoaded,
  openDock,
  openTank,
  openTankPanel,
  registerVerifiedUser,
} from '../support/app.ts';
import {
  addFish,
  createTank,
  errorOf,
  getTank,
  key,
  patchTank,
  sameOrigin,
} from '../support/api.ts';
import { anonymousVisitor, freshPlayer, setHandle, uniqueHandle } from '../support/social.ts';

const NANO_CAP = 12;

const livingIds = async (page: Page, tankId: string): Promise<string[]> =>
  (await getTank(page, tankId)).fish.filter((f) => f.status === 'alive').map((f) => f.id);

test.describe('the gift and trade screens', () => {
  test('a gift is sent from the Care panel and accepted from the Offers list', async ({
    page,
    browser,
  }) => {
    test.setTimeout(480_000);
    await registerVerifiedUser(page, 'uigiver');
    const senderTank = await createTank(page, { name: 'Giver' });
    await addFish(page, senderTank.id, 'neon-tetra', { name: 'Sparky' });

    const recipient = await freshPlayer(browser, 'uitaker');
    const handle = uniqueHandle('ui');
    expect((await setHandle(recipient, handle)).status()).toBe(200);
    const recipientTank = await createTank(recipient, { name: 'Taker' });

    await openTank(recipient);
    const mine = await openTankPanel(recipient);
    await mine.getByRole('checkbox', { name: 'Accept gifts in Taker' }).click();
    await expect
      .poll(async () => {
        const read = (await getTank(recipient, recipientTank.id)) as { acceptsGifts?: boolean };
        return read.acceptsGifts;
      })
      .toBe(true);

    await recipient.goto('about:blank');
    await openTank(page);
    const care = await openDock(page, 'Care', 'Care');
    await care.getByRole('button', { name: 'Gift or trade Sparky' }).click();
    await care.getByLabel('Player handle').fill('no');
    await care.getByRole('button', { name: 'Send Sparky' }).click();
    await expect(care.getByRole('alert')).toBeVisible();
    expect(await livingIds(page, senderTank.id), 'a bad handle sends nothing').toHaveLength(1);

    await care.getByLabel('Player handle').fill(handle);
    await care.getByRole('button', { name: 'Send Sparky' }).click();
    await expect.poll(async () => (await livingIds(page, senderTank.id)).length).toBe(0);

    await openTank(recipient);
    const offers = await openTankPanel(recipient);
    await offers.getByRole('button', { name: 'Refresh offers' }).click();
    const incoming = offers.getByRole('region', { name: 'Incoming offers' });
    await expect(incoming).toContainText('Sparky');
    await incoming.getByRole('button', { name: 'Accept Sparky' }).click();

    await expect.poll(async () => (await livingIds(recipient, recipientTank.id)).length).toBe(1);
    expect((await getTank(recipient, recipientTank.id)).fish[0]?.species).toBe('neon-tetra');
    await recipient.context().close();
  });

  test('a declined offer goes back to the sender', async ({ page, browser }) => {
    test.setTimeout(480_000);
    await registerVerifiedUser(page, 'uidecline');
    const senderTank = await createTank(page, { name: 'Giver' });
    const sent = await addFish(page, senderTank.id, 'neon-tetra', { name: 'Boomerang' });
    const fishId = sent.fish[0]?.id ?? '';

    const recipient = await freshPlayer(browser, 'uirefuser');
    const handle = uniqueHandle('no');
    expect((await setHandle(recipient, handle)).status()).toBe(200);
    const recipientTank = await createTank(recipient, { name: 'Taker' });
    expect((await patchTank(recipient, recipientTank.id, { acceptsGifts: true })).status()).toBe(
      200,
    );
    const offer = await page.request.post('/api/gifts', {
      ...sameOrigin,
      data: {
        fromTankId: senderTank.id,
        fishId,
        toHandle: handle,
        wantsReturn: false,
        idempotencyKey: key(),
      },
    });
    expect(offer.status(), await offer.text()).toBe(201);

    await openTank(recipient);
    const offers = await openTankPanel(recipient);
    await offers.getByRole('button', { name: 'Refresh offers' }).click();
    await offers
      .getByRole('region', { name: 'Incoming offers' })
      .getByRole('button', { name: 'Decline' })
      .click();
    await expect.poll(async () => (await livingIds(page, senderTank.id)).length).toBe(1);
    expect(await livingIds(recipient, recipientTank.id)).toEqual([]);
    await recipient.context().close();
  });
});

test.describe('gifts at the fish cap', () => {
  test('a full tank refuses the gift, keeps what it has, and the offer stays open', async ({
    page,
    browser,
  }) => {
    test.setTimeout(480_000);
    await registerVerifiedUser(page, 'capgiver');
    const senderTank = await createTank(page, { name: 'Giver' });
    const sent = await addFish(page, senderTank.id, 'neon-tetra', { name: 'Latecomer' });
    const fishId = sent.fish[0]?.id ?? '';

    const recipient = await freshPlayer(browser, 'capowner');
    const handle = uniqueHandle('cap');
    expect((await setHandle(recipient, handle)).status()).toBe(200);
    const tiny = await createTank(recipient, { name: 'Tiny', size: 'nano30' });
    for (let n = 1; n <= NANO_CAP; n += 1)
      await addFish(recipient, tiny.id, 'neon-tetra', { name: `Resident ${n}` });
    expect(await livingIds(recipient, tiny.id)).toHaveLength(NANO_CAP);
    expect((await patchTank(recipient, tiny.id, { acceptsGifts: true })).status()).toBe(200);

    const offer = await page.request.post('/api/gifts', {
      ...sameOrigin,
      data: {
        fromTankId: senderTank.id,
        fishId,
        toHandle: handle,
        wantsReturn: false,
        idempotencyKey: key(),
      },
    });
    expect(offer.status(), await offer.text()).toBe(201);
    const { offer: created } = (await offer.json()) as { offer: { id: string } };

    const refused = await recipient.request.post(`/api/gifts/${created.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: tiny.id, idempotencyKey: key() },
    });
    expect(refused.status()).toBe(409);
    expect((await errorOf(refused)).reason).toBe('tank_full');
    expect(await livingIds(recipient, tiny.id), 'every resident is still there').toHaveLength(
      NANO_CAP,
    );

    const open = (await (await recipient.request.get('/api/gifts')).json()) as {
      incoming: { id: string; status: string }[];
    };
    expect(open.incoming.find((o) => o.id === created.id)?.status).toBe('open');

    await openTank(recipient);
    const offers = await openTankPanel(recipient);
    await offers.getByRole('button', { name: 'Refresh offers' }).click();
    const incoming = offers.getByRole('region', { name: 'Incoming offers' });
    await expect(incoming).toContainText('Latecomer');
    await incoming.getByRole('button', { name: 'Accept Latecomer' }).click();
    await expect(offers.getByRole('alert')).toContainText(
      'That tank has no room. Make space there or pick another tank.',
    );
    expect(await livingIds(recipient, tiny.id), 'the refused accept changed nothing').toHaveLength(
      NANO_CAP,
    );

    const roomy = await createTank(recipient, { name: 'Roomy' });
    expect((await patchTank(recipient, roomy.id, { acceptsGifts: true })).status()).toBe(200);
    const accepted = await recipient.request.post(`/api/gifts/${created.id}/accept`, {
      ...sameOrigin,
      data: { toTankId: roomy.id, idempotencyKey: key() },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect(await livingIds(recipient, roomy.id)).toHaveLength(1);
    await recipient.context().close();
  });
});

test.describe('the community tank page', () => {
  test('a visitor can watch, and a feeding by someone else shows up live', async ({
    page,
    browser,
  }) => {
    test.setTimeout(420_000);
    const feeder = await freshPlayer(browser, 'livefeeder');
    const handle = uniqueHandle('live');
    expect((await setHandle(feeder, handle)).status()).toBe(200);

    const watcher = await anonymousVisitor(browser);
    await watcher.goto('/community?tier=low&backend=webgl');
    await expect(watcher).toHaveTitle(/Community tank/);
    await expect(watcher.getByRole('heading', { name: 'Community tank', level: 1 })).toBeVisible();
    await expect(watcher.getByRole('heading', { name: 'Happening now' })).toBeVisible();
    await expect(watcher.getByText('You are watching.')).toBeVisible();
    await expect(watcher.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(watcher.locator('.community-viewers')).toHaveText(/\d+ (person|people) watching/, {
      timeout: 60_000,
    });
    await expect(watcher.getByRole('button', { name: 'Drop food' })).toHaveCount(0);

    const fed = await feeder.request.post('/api/community/feed', {
      ...sameOrigin,
      data: { food: 'flakes', portion: 0.5, idempotencyKey: key() },
    });
    expect(fed.status(), await fed.text()).toBe(201);
    await expect(
      watcher.getByRole('region', { name: 'Happening now' }).getByRole('listitem'),
    ).toContainText(`${handle} fed flakes.`, { timeout: 30_000 });

    await watcher.getByText('Tank report').click();
    await expect(watcher.locator('.public-report')).toContainText('fish alive');
    await watcher.context().close();
    await feeder.context().close();
    await page.close();
  });

  test('a signed-in player feeds from the page and sees their own line and the allowance fall', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'pagefeeder');
    const handle = uniqueHandle('pf');
    expect((await setHandle(page, handle)).status()).toBe(200);

    await page.goto('/community?tier=low&backend=webgl');
    await awaitLoaded(page);
    const drop = page.getByRole('button', { name: 'Drop food' });
    await expect(drop).toBeEnabled({ timeout: 120_000 });
    await drop.click();
    await expect(
      page.getByRole('region', { name: 'Happening now' }).getByRole('listitem').first(),
    ).toContainText(`${handle} fed `, { timeout: 30_000 });

    const state = (await (await page.request.get('/api/community')).json()) as {
      quota: { used: number };
    };
    expect(state.quota.used).toBeGreaterThan(0);
  });
});
