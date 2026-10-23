import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  APP_URL,
  PASSWORD,
  awaitLoaded,
  openDock,
  openTank,
  registerVerifiedUser,
} from '../support/app.ts';
import {
  balance,
  createTank,
  errorOf,
  me,
  purchase,
  sameOrigin,
  setBalance,
  wallet,
} from '../support/api.ts';
import { economy, webPack } from '../support/economy.ts';
import {
  dispute,
  event,
  newDisputeId,
  newStripeIds,
  packSession,
  refund,
  sign,
} from '../support/stripe.ts';

const CONSENT = { immediateDelivery: true, withdrawalWaiver: true };

async function adultConfirmed(page: Page): Promise<void> {
  const res = await page.request.put('/api/payments/adult-confirmation', {
    ...sameOrigin,
    data: { confirmed: true, password: PASSWORD },
  });
  expect(res.ok(), 'adult confirmation').toBe(true);
}

function deliver(
  stripe: APIRequestContext,
  payload: string,
  signature = sign(payload),
): ReturnType<APIRequestContext['post']> {
  return stripe.post('/api/payments/webhook', {
    data: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
  });
}

const packRows = (rows: Awaited<ReturnType<typeof wallet>>['ledger'], ref: string) =>
  rows.filter((row) => row.itemRef === ref);

test.describe('Pearl packs in test mode', () => {
  let stripe: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    stripe = await playwright.request.newContext({ baseURL: APP_URL });
  });

  test.afterAll(async () => {
    await stripe.dispose();
  });

  test('only the packs sold on the web are offered, and the state starts unconfirmed', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'packs');

    const state = await page.request.get('/api/payments/state');
    expect(await state.json()).toEqual({
      payments: 'enabled',
      adultConfirmed: false,
      subscription: null,
    });

    const packs = (await (await page.request.get('/api/payments/packs')).json()) as {
      packs: { id: string; pearls: number; priceCents: number }[];
      subscription: { id: string; priceCents: number; pearlsPerDay: number };
    };
    expect(packs.packs.map((p) => p.id)).toEqual(
      economy.packs.filter((p) => p.webAvailable).map((p) => p.id),
    );
    expect(packs.packs.map((p) => p.id)).not.toContain('pearls-100');
    expect(packs.subscription).toEqual(economy.subscription);
  });

  test('checkout needs an adult confirmation, a known pack and both consents, and never takes an amount', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'checkout');
    const pack = webPack('pearls-550');
    const checkout = (data: object) =>
      page.request.post('/api/payments/checkout/pack', { ...sameOrigin, data });

    const unconfirmed = await checkout({ packId: pack.id, consent: CONSENT });
    expect(unconfirmed.status()).toBe(403);
    expect((await errorOf(unconfirmed)).code).toBe('adult_confirmation_required');

    const wrongPassword = await page.request.put('/api/payments/adult-confirmation', {
      ...sameOrigin,
      data: { confirmed: true, password: 'not the password at all' },
    });
    expect(wrongPassword.status()).toBe(403);
    expect(
      (
        (await (await page.request.get('/api/payments/state')).json()) as {
          adultConfirmed: boolean;
        }
      ).adultConfirmed,
    ).toBe(false);

    await adultConfirmed(page);

    const ok = await checkout({ packId: pack.id, consent: CONSENT });
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as { url: string }).url).toMatch(/^https:\/\//);

    const noWaiver = await checkout({
      packId: pack.id,
      consent: { ...CONSENT, withdrawalWaiver: false },
    });
    expect(noWaiver.status()).toBe(400);
    const noDelivery = await checkout({
      packId: pack.id,
      consent: { ...CONSENT, immediateDelivery: false },
    });
    expect(noDelivery.status()).toBe(400);

    const unsold = await checkout({ packId: 'pearls-100', consent: CONSENT });
    expect(unsold.status()).toBe(400);
    expect((await errorOf(unsold)).message).toContain('not sold on the web');
    expect((await checkout({ packId: 'pearls-nothing', consent: CONSENT })).status()).toBe(400);

    const withAmount = await checkout({
      packId: pack.id,
      consent: CONSENT,
      amount: 1,
      pearls: 999_999,
    });
    expect(withAmount.status()).toBe(400);

    const crossSite = await page.request.post('/api/payments/checkout/pack', {
      data: { packId: pack.id, consent: CONSENT },
    });
    expect(crossSite.status(), 'a post without our origin is refused').toBeGreaterThanOrEqual(400);
  });

  test('a signed paid-session webhook credits once, and a replay or a bad signature changes nothing', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'credit');
    const { id: userId } = await me(page);
    const pack = webPack('pearls-550');
    const ids = newStripeIds();
    const body = event('checkout.session.completed', packSession(userId, pack, ids));
    const before = await balance(page);

    const unsigned = await stripe.post('/api/payments/webhook', {
      data: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.status()).toBe(400);
    const forged = await deliver(stripe, body, 't=1,v1=' + '0'.repeat(64));
    expect(forged.status()).toBe(400);
    const wrongSecret = await deliver(stripe, body, sign(body, 'whsec_notthesecretatall'));
    expect(wrongSecret.status()).toBe(400);
    expect(await balance(page), 'an unverified event credits nothing').toBe(before);

    const first = await deliver(stripe, body);
    expect(first.status()).toBe(200);
    expect(await balance(page)).toBe(before + pack.pearls);

    const again = await deliver(stripe, body);
    expect(again.status()).toBe(200);
    expect(await balance(page), 'at-least-once delivery does not credit twice').toBe(
      before + pack.pearls,
    );

    const { ledger } = await wallet(page);
    const rows = packRows(ledger, `pack:${pack.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: pack.pearls, reason: 'pack', source: 'stripe' });

    const order = await page.request.get(`/api/payments/orders/${ids.session}`);
    expect(await order.json()).toEqual({ status: 'paid' });
  });

  test('an unpaid session, a session for another app, or a price that does not match the pack credits nothing', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'nocredit');
    const { id: userId } = await me(page);
    const pack = webPack('pearls-550');
    const before = await balance(page);

    const unpaid = event(
      'checkout.session.completed',
      packSession(userId, pack, newStripeIds(), { paid: false }),
    );
    expect((await deliver(stripe, unpaid)).status()).toBe(200);

    const foreign = event('checkout.session.completed', {
      id: newStripeIds().session,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: pack.priceCents,
      currency: 'eur',
      metadata: {},
    });
    expect((await deliver(stripe, foreign)).status()).toBe(200);

    const cheap = packSession(userId, pack, newStripeIds());
    const mismatched = event('checkout.session.completed', { ...cheap, amount_total: 1 });
    expect((await deliver(stripe, mismatched)).status()).toBeGreaterThanOrEqual(400);

    expect(await balance(page)).toBe(before);
    expect(packRows((await wallet(page)).ledger, `pack:${pack.id}`)).toEqual([]);
  });

  test('a refund takes back Pearls in proportion, a replay changes nothing, and the order shows refunded', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'refund');
    const { id: userId } = await me(page);
    const pack = webPack('pearls-550');
    const ids = newStripeIds();
    await deliver(stripe, event('checkout.session.completed', packSession(userId, pack, ids)));
    const credited = await balance(page);

    const half = Math.floor(pack.priceCents / 2);
    const partial = event('refund.created', refund(ids.paymentIntent, half));
    expect((await deliver(stripe, partial)).status()).toBe(200);
    const clawedBack = Math.floor((pack.pearls * half) / pack.priceCents);
    expect(await balance(page)).toBe(credited - clawedBack);
    expect(await (await page.request.get(`/api/payments/orders/${ids.session}`)).json()).toEqual({
      status: 'paid',
    });

    expect((await deliver(stripe, partial)).status()).toBe(200);
    expect(await balance(page), 'a replayed refund takes nothing more').toBe(credited - clawedBack);

    const rest = event('refund.created', refund(ids.paymentIntent, pack.priceCents - half));
    expect((await deliver(stripe, rest)).status()).toBe(200);
    expect(await balance(page), 'a full refund takes back every Pearl the pack gave').toBe(
      credited - pack.pearls,
    );
    expect(await (await page.request.get(`/api/payments/orders/${ids.session}`)).json()).toEqual({
      status: 'refunded',
    });

    const extra = event('refund.created', refund(ids.paymentIntent, pack.priceCents));
    expect((await deliver(stripe, extra)).status()).toBe(200);
    expect(await balance(page), 'a refund past the full amount takes nothing more').toBe(
      credited - pack.pearls,
    );

    const rows = packRows((await wallet(page)).ledger, `pack:${pack.id}`);
    expect(rows.filter((r) => r.reason === 'clawback').reduce((sum, r) => sum - r.delta, 0)).toBe(
      pack.pearls,
    );
  });

  test('a refund for a payment nobody recorded is not acknowledged, so Stripe retries it', async () => {
    const orphan = event('refund.created', refund(newStripeIds().paymentIntent, 100));
    expect((await deliver(stripe, orphan)).status()).toBeGreaterThanOrEqual(500);
  });

  test('a lost dispute claws the Pearls back, and winning it afterwards gives them back', async ({
    page,
  }) => {
    await registerVerifiedUser(page, 'dispute');
    const { id: userId } = await me(page);
    const pack = webPack('pearls-550');
    const ids = newStripeIds();
    await deliver(stripe, event('checkout.session.completed', packSession(userId, pack, ids)));
    const credited = await balance(page);
    const disputeId = newDisputeId();

    const lost = event(
      'charge.dispute.closed',
      dispute(disputeId, ids.paymentIntent, pack.priceCents, 'lost'),
    );
    expect((await deliver(stripe, lost)).status()).toBe(200);
    expect(await balance(page)).toBe(credited - pack.pearls);
    expect((await deliver(stripe, lost)).status()).toBe(200);
    expect(await balance(page), 'the same loss is taken once').toBe(credited - pack.pearls);

    const won = event(
      'charge.dispute.funds_reinstated',
      dispute(disputeId, ids.paymentIntent, pack.priceCents, 'won'),
    );
    expect((await deliver(stripe, won)).status()).toBe(200);
    expect(await balance(page)).toBe(credited);
  });

  test('a clawback can leave the balance negative, which blocks buying but not free care', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await registerVerifiedUser(page, 'negative');
    const { id: userId } = await me(page);
    const tank = await createTank(page, { name: 'Pond' });
    const pack = webPack('pearls-550');
    const ids = newStripeIds();
    await deliver(stripe, event('checkout.session.completed', packSession(userId, pack, ids)));
    await setBalance(page, 0);
    await deliver(stripe, event('refund.created', refund(ids.paymentIntent, pack.priceCents)));
    expect(await balance(page)).toBe(-pack.pearls);

    const poor = await purchase(page, 'room:room-office');
    expect(poor.status()).toBe(402);
    expect((await errorOf(poor)).code).toBe('insufficient_pearls');

    const care = await page.request.post(`/api/tanks/${tank.id}/care`, {
      ...sameOrigin,
      data: { type: 'water_change' },
    });
    expect(care.ok(), 'free care never depends on Pearls').toBe(true);
  });
});

test('the shop lists the web packs, and Buy waits for the adult confirmation and both consents', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'packui');
  await createTank(page, { name: 'Pond' });
  await openTank(page);

  const shop = await openDock(page, 'Shop', 'Fish shop');
  const list = shop.getByRole('list', { name: 'Pearl packs' });
  await expect(list).toBeVisible();
  const webPacks = economy.packs.filter((p) => p.webAvailable);
  await expect(list.getByRole('listitem')).toHaveCount(webPacks.length);
  for (const pack of webPacks) {
    const name = `Buy ${pack.pearls.toLocaleString('en')} Pearls for €${(pack.priceCents / 100).toFixed(2)}`;
    await expect(list.getByRole('button', { name })).toBeDisabled();
  }
  await expect(shop).toContainText('An adult has to confirm purchases once');

  await shop.getByRole('checkbox', { name: 'I want my Pearls delivered right away.' }).check();
  await shop
    .getByRole('checkbox', {
      name: 'I understand that this ends my 14-day right of withdrawal for what I buy.',
    })
    .check();
  await expect(list.getByRole('button', { name: /^Buy 550 Pearls/ })).toBeDisabled();

  await adultConfirmed(page);
  await openTank(page);
  const reopened = await openDock(page, 'Shop', 'Fish shop');
  await reopened.getByRole('checkbox', { name: 'I want my Pearls delivered right away.' }).check();
  await reopened
    .getByRole('checkbox', {
      name: 'I understand that this ends my 14-day right of withdrawal for what I buy.',
    })
    .check();
  await expect(
    reopened
      .getByRole('list', { name: 'Pearl packs' })
      .getByRole('button', { name: /^Buy 550 Pearls/ }),
  ).toBeEnabled();
  await expect(reopened).not.toContainText('An adult has to confirm purchases once');
});

test('coming back from Checkout opens the shop with a note, and cancelling says nothing was charged', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerVerifiedUser(page, 'comeback');
  await createTank(page, { name: 'Pond' });

  await page.goto('/?tier=low&backend=webgl&payment=cancelled');
  await awaitLoaded(page);
  const shop = page.getByRole('region', { name: 'Fish shop' });
  await expect(shop).toBeVisible();
  await expect(shop).toContainText('Checkout was cancelled. Nothing was charged.');
  await expect(page).not.toHaveURL(/payment=/);

  await page.goto('/?tier=low&backend=webgl&payment=success&session_id=cs_test_unknown');
  await awaitLoaded(page);
  await expect(page.getByRole('region', { name: 'Fish shop' })).toContainText(
    'Stripe has received your payment.',
  );
  await expect(page).not.toHaveURL(/payment=/);
});

test('the account settings confirm and withdraw the adult confirmation', async ({ page }) => {
  await page.route('**/assets/**', (route) => {
    const { pathname } = new URL(route.request().url());
    return /\.(js|css)$/.test(pathname) ? route.continue() : route.abort();
  });
  await registerVerifiedUser(page, 'adultui');
  await page.goto('/settings?backend=webgl&tier=low');
  const purchases = page.getByRole('region', { name: 'Purchases' });
  const checkbox = purchases.getByRole('checkbox', {
    name: 'I am an adult and I confirm purchases on this account.',
  });
  await expect(checkbox).not.toBeChecked();
  const confirmedOnServer = async () =>
    ((await (await page.request.get('/api/payments/state')).json()) as { adultConfirmed: boolean })
      .adultConfirmed;

  await checkbox.check();
  await purchases.getByLabel('Password').fill('the wrong passphrase 1');
  await purchases.getByRole('button', { name: 'Confirm' }).click();
  await expect(purchases.getByRole('alert')).toBeVisible();

  await purchases.getByLabel('Password').fill(PASSWORD);
  await purchases.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(confirmedOnServer).toBe(true);
  await expect(checkbox).toBeChecked();

  await checkbox.click();
  await expect.poll(confirmedOnServer).toBe(false);
  await expect(checkbox).not.toBeChecked();
});
