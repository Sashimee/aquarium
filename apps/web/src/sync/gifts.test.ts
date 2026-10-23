import type { GiftArrival, GiftFish, GiftOffer, Tank } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../ui/api';
import {
  FISH_1,
  FISH_2,
  TANK_A,
  TANK_B,
  fishFixture,
  speciesFixture,
  tankFixture,
} from './fixtures';
import {
  GiftBook,
  checkHandle,
  destinations,
  effectiveStatus,
  giftRefusalText,
  giftableFish,
  offerView,
  offersNeedingMe,
  pledgeChoices,
  timeLeftText,
  type GiftBookDeps,
} from './gifts';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const HOUR = 3_600_000;
const NAMES = new Map([['neon-tetra', 'Neon tetra']]);

const giftFish = (overrides: Partial<GiftFish> = {}): GiftFish => ({
  id: FISH_1,
  species: 'neon-tetra',
  name: 'Pip',
  sex: 'female',
  stage: 'adult',
  size: 0.02,
  health: 1,
  disease: null,
  ...overrides,
});

const offer = (overrides: Partial<GiftOffer> = {}): GiftOffer => ({
  id: '20000000-0000-4000-8000-000000000001',
  status: 'open',
  role: 'recipient',
  counterpart: 'reef_fan',
  fish: giftFish(),
  wantsReturn: false,
  pledged: null,
  createdAt: new Date(NOW - HOUR).toISOString(),
  expiresAt: new Date(NOW + 20 * HOUR).toISOString(),
  settledAt: null,
  ...overrides,
});

const conflict = (reason: ConstructorParameters<typeof ApiRequestError>[5]) =>
  new ApiRequestError(409, 'conflict', 'server words', {}, null, reason);

describe('checkHandle', () => {
  it('accepts a handle and tidies a pasted one', () => {
    expect(checkHandle('reef_fan')).toEqual({ ok: true, handle: 'reef_fan' });
    expect(checkHandle('  @Reef_Fan ')).toEqual({ ok: true, handle: 'reef_fan' });
  });

  it('refuses an empty or malformed handle with a message', () => {
    expect(checkHandle('   ')).toMatchObject({ ok: false });
    expect(checkHandle('@')).toMatchObject({ ok: false });
    expect(checkHandle('ab')).toMatchObject({ ok: false });
    expect(checkHandle('1fish')).toMatchObject({ ok: false });
    expect(checkHandle('has space')).toMatchObject({ ok: false });
    expect(checkHandle('a'.repeat(21))).toMatchObject({ ok: false });
  });
});

describe('giftableFish', () => {
  it('leaves out the dead', () => {
    const tank = tankFixture({
      fish: [
        fishFixture(FISH_1),
        fishFixture(FISH_2, { status: 'dead', diedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    });
    expect(giftableFish(tank).map((f) => f.id)).toEqual([FISH_1]);
  });
});

describe('effectiveStatus and timeLeftText', () => {
  it('shows a live offer past its expiry as expired, and leaves settled ones alone', () => {
    const late = { expiresAt: new Date(NOW - 1).toISOString() };
    expect(effectiveStatus(offer(late), NOW)).toBe('expired');
    expect(effectiveStatus(offer({ ...late, status: 'countered' }), NOW)).toBe('expired');
    expect(effectiveStatus(offer({ ...late, status: 'accepted' }), NOW)).toBe('accepted');
    expect(effectiveStatus(offer(), NOW)).toBe('open');
  });

  it('words the time left at hour, day and expiry boundaries', () => {
    const at = (ms: number) => timeLeftText(new Date(NOW + ms).toISOString(), NOW);
    expect(at(-1)).toBe('expired');
    expect(at(0)).toBe('expired');
    expect(at(30 * 60_000)).toBe('less than an hour left');
    expect(at(HOUR)).toBe('about 1 hour left');
    expect(at(20 * HOUR)).toBe('about 20 hours left');
    expect(at(72 * HOUR)).toBe('about 3 days left');
  });
});

describe('offerView', () => {
  it('lets the recipient accept or decline an open gift', () => {
    const view = offerView(offer(), NOW, NAMES);
    expect(view.actions).toEqual(['accept', 'decline']);
    expect(view.headline).toBe('@reef_fan offers you Pip the neon tetra as a gift');
    expect(view.timeLeft).toBe('about 20 hours left');
    expect(view.settled).toBe(false);
  });

  it('asks the recipient of a trade to counter, not accept', () => {
    const view = offerView(offer({ wantsReturn: true }), NOW, NAMES);
    expect(view.actions).toEqual(['counter', 'decline']);
    expect(view.status).toContain('Choose one of yours');
  });

  it('lets the sender only cancel an open offer', () => {
    const view = offerView(offer({ role: 'sender' }), NOW, NAMES);
    expect(view.actions).toEqual(['cancel']);
    expect(view.headline).toContain('offered to @reef_fan');
  });

  it('asks the sender to confirm or cancel a countered trade', () => {
    const view = offerView(
      offer({
        role: 'sender',
        status: 'countered',
        wantsReturn: true,
        pledged: giftFish({ id: FISH_2, name: 'Bubbles' }),
      }),
      NOW,
      NAMES,
    );
    expect(view.actions).toEqual(['confirm', 'cancel']);
    expect(view.status).toContain('Bubbles the neon tetra');
  });

  it('only lets the sender cancel when the pledged fish is gone', () => {
    const view = offerView(
      offer({ role: 'sender', status: 'countered', wantsReturn: true, pledged: null }),
      NOW,
      NAMES,
    );
    expect(view.actions).toEqual(['cancel']);
    expect(view.status).toContain('no longer available');
  });

  it('lets the recipient of a countered trade only decline, and says it ends the trade', () => {
    const view = offerView(
      offer({ status: 'countered', wantsReturn: true, pledged: giftFish({ name: 'Bubbles' }) }),
      NOW,
      NAMES,
    );
    expect(view.actions).toEqual(['decline']);
    expect(view.status).toContain('Your fish stays in your tank');
    expect(view.status).toContain('Declining ends the whole trade and sends Pip back to @reef_fan');
  });

  it('offers no action on a final offer and says where the fish went', () => {
    for (const status of ['accepted', 'declined', 'cancelled', 'expired'] as const) {
      const sent = offerView(offer({ role: 'sender', status }), NOW, NAMES);
      expect(sent.actions).toEqual([]);
      expect(sent.settled).toBe(true);
      expect(sent.timeLeft).toBeNull();
    }
    expect(offerView(offer({ role: 'sender', status: 'declined' }), NOW, NAMES).status).toContain(
      'Pip is back in your tank',
    );
    expect(offerView(offer({ role: 'sender', status: 'accepted' }), NOW, NAMES).status).toContain(
      'now lives with them',
    );
    expect(offerView(offer({ status: 'cancelled' }), NOW, NAMES).status).toContain('withdrew');
  });

  it('shows a live offer past its expiry as expired with no action', () => {
    const view = offerView(offer({ expiresAt: new Date(NOW - 1).toISOString() }), NOW, NAMES);
    expect(view.actions).toEqual([]);
    expect(view.status).toContain('Expired');
  });

  it('names a player whose account is gone', () => {
    const view = offerView(offer({ counterpart: null }), NOW, NAMES);
    expect(view.headline).toContain('a player who has left');
  });
});

describe('offersNeedingMe', () => {
  it('counts fresh incoming offers and countered trades the player must confirm', () => {
    const list = {
      incoming: [offer(), offer({ status: 'countered' }), offer({ status: 'declined' })],
      outgoing: [
        offer({ role: 'sender' }),
        offer({ role: 'sender', status: 'countered' }),
        offer({ role: 'sender', status: 'countered', expiresAt: new Date(NOW - 1).toISOString() }),
      ],
    };
    expect(offersNeedingMe(list, NOW)).toBe(2);
    expect(offersNeedingMe(null, NOW)).toBe(0);
  });
});

describe('destinations', () => {
  const species = [speciesFixture()];
  const open = tankFixture({ acceptsGifts: true });
  const closed = tankFixture({ id: TANK_B, name: 'Closed' });
  const reef = tankFixture({
    id: '00000000-0000-4000-8000-0000000000d1',
    name: 'Reef',
    biome: 'reef',
    acceptsGifts: true,
  });

  it('allows only tanks that opted in and hold the right water', () => {
    const result = destinations([open, closed, reef], giftFish(), species);
    expect(result.map((d) => d.usable)).toEqual([true, false, false]);
    expect(result[1]?.note).toContain('Not accepting gifts');
    expect(result[2]?.note).toContain('freshwater');
  });

  it('refuses a tank too short for the species, but not a quarantine tank', () => {
    const mono = speciesFixture({ id: 'silver-mono', commonName: 'Silver mono' });
    const standard = tankFixture({ acceptsGifts: true, size: 'standard' });
    const long = tankFixture({ id: TANK_B, acceptsGifts: true, size: 'long300' });
    const quarantine = tankFixture({
      id: '00000000-0000-4000-8000-0000000000d2',
      acceptsGifts: true,
      size: 'standard',
      quarantine: true,
    });
    const result = destinations(
      [standard, long, quarantine],
      giftFish({ species: 'silver-mono' }),
      [mono],
    );
    expect(result.map((d) => d.usable)).toEqual([false, true, true]);
    expect(result[0]?.note).toContain('150 cm');
  });

  it('warns about a full tank but keeps it usable', () => {
    const crowd = Array.from({ length: 40 }, (_, i) =>
      fishFixture(`10000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`),
    );
    const nano = tankFixture({ acceptsGifts: true, size: 'nano30', fish: crowd });
    const [only] = destinations([nano], giftFish(), species);
    expect(only?.usable).toBe(true);
    expect(only?.note).toContain('full');
  });

  it('leaves the check to the server for a species it does not know', () => {
    const [only] = destinations([open], giftFish({ species: 'mystery-fish' }), species);
    expect(only).toMatchObject({ usable: true, note: null });
  });
});

describe('pledgeChoices', () => {
  it('lists living fish of every tank with their tank', () => {
    const a = tankFixture({ fish: [fishFixture(FISH_1)] });
    const b = tankFixture({
      id: TANK_B,
      fish: [
        fishFixture(FISH_2, { status: 'dead', diedAt: '2026-02-01T00:00:00.000Z' }),
        fishFixture('10000000-0000-4000-8000-000000000003'),
      ],
    });
    expect(pledgeChoices([a, b]).map((c) => [c.fish.id, c.tank.id])).toEqual([
      [FISH_1, TANK_A],
      ['10000000-0000-4000-8000-000000000003', TANK_B],
    ]);
  });
});

describe('giftRefusalText', () => {
  it('words gifts_closed differently when sending, accepting and confirming', () => {
    const create = giftRefusalText(conflict('gifts_closed'), { op: 'create', handle: 'reef_fan' });
    expect(create).toContain('@reef_fan is not taking gifts');
    expect(giftRefusalText(conflict('gifts_closed'), { op: 'create' })).toContain(
      'That player is not taking gifts',
    );
    expect(giftRefusalText(conflict('gifts_closed'), { op: 'accept' })).toContain(
      'Turn on "Accept gifts"',
    );
    expect(giftRefusalText(conflict('gifts_closed'), { op: 'confirm' })).toContain(
      'One of the two',
    );
  });

  it('words the settled-offer conflicts', () => {
    expect(giftRefusalText(conflict('offer_closed'), { op: 'accept' })).toContain(
      'already settled',
    );
    expect(giftRefusalText(conflict('offer_expired'), { op: 'accept' })).toContain('72 hours');
    expect(giftRefusalText(conflict('too_many_offers'), { op: 'create' })).toContain('cancel one');
    expect(giftRefusalText(conflict('fish_unavailable'), { op: 'confirm' })).toContain(
      'no longer available',
    );
  });

  it('keeps the server words for an unknown handle and a gift to oneself', () => {
    const unknown = new ApiRequestError(404, 'not_found', 'No player has that handle.');
    expect(giftRefusalText(unknown, { op: 'create' })).toBe('No player has that handle.');
    const self = new ApiRequestError(
      400,
      'validation_failed',
      'You cannot send a fish to yourself.',
    );
    expect(giftRefusalText(self, { op: 'create' })).toBe('You cannot send a fish to yourself.');
  });

  it('explains offer_changed on confirm', () => {
    expect(giftRefusalText(conflict('offer_changed'), { op: 'confirm' })).toBe(
      'The offer changed while you were confirming. The list has been refreshed.',
    );
  });

  it('treats a 404 on an existing offer as gone', () => {
    const gone = new ApiRequestError(404, 'not_found', 'Offer not found.');
    expect(giftRefusalText(gone, { op: 'accept' })).toContain('no longer exists');
  });

  it('falls back to the shared wording for network errors and non-API errors', () => {
    const net = new ApiRequestError(0, 'network', 'x');
    expect(giftRefusalText(net, { op: 'create' })).toContain('Could not reach the server');
    expect(giftRefusalText(new Error('boom'), { op: 'create' })).toContain('Something went wrong');
  });
});

describe('GiftBook', () => {
  const sender = tankFixture({ name: 'Home' });
  const arrival: GiftArrival = { fishId: FISH_1, tankId: TANK_A, stress: 0.2 };
  const emptyList = { incoming: [], outgoing: [] };

  function setup(overrides: Partial<GiftBookDeps['api']> = {}) {
    let counter = 0;
    const api = {
      gifts: vi.fn().mockResolvedValue(emptyList),
      createGift: vi.fn().mockResolvedValue({ offer: offer({ role: 'sender' }), tank: sender }),
      acceptGift: vi.fn().mockResolvedValue({ offer: offer(), tank: sender, arrival }),
      confirmGift: vi.fn().mockResolvedValue({ offer: offer(), tank: sender, arrival }),
      declineGift: vi.fn().mockResolvedValue({ offer: offer() }),
      cancelGift: vi.fn().mockResolvedValue({ offer: offer(), tank: sender }),
      ...overrides,
    };
    const onTank = vi.fn<(tank: Tank, arrival: GiftArrival | null) => void>();
    const book = new GiftBook({ api, onTank, newKey: () => `key-${++counter}` });
    return { api, onTank, book };
  }

  const createInput = {
    fromTankId: TANK_A,
    fishId: FISH_1,
    fishName: 'Pip',
    handle: 'reef_fan',
    wantsReturn: true,
  };

  it('creates an offer with a key, hands the sender tank over and refreshes the list', async () => {
    const { api, onTank, book } = setup();
    expect(await book.create(createInput)).toBe(true);
    expect(api.createGift).toHaveBeenCalledWith({
      fromTankId: TANK_A,
      fishId: FISH_1,
      toHandle: 'reef_fan',
      wantsReturn: true,
      idempotencyKey: 'key-1',
    });
    expect(onTank).toHaveBeenCalledWith(sender, null);
    expect(api.gifts).toHaveBeenCalledTimes(1);
    expect(book.getState()).toMatchObject({ busy: null, error: null });
    expect(book.getState().notice).toContain('on its way to @reef_fan');
  });

  it('shows a clear message for gifts_closed and leaves the tank alone', async () => {
    const { onTank, book } = setup({
      createGift: vi.fn().mockRejectedValue(conflict('gifts_closed')),
    });
    expect(await book.create(createInput)).toBe(false);
    expect(onTank).not.toHaveBeenCalled();
    expect(book.getState().error).toContain('@reef_fan is not taking gifts');
    expect(book.getState().busy).toBeNull();
  });

  it('keeps the key across a network failure and takes a new one after a refusal', async () => {
    const createGift = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(0, 'network', 'down'))
      .mockRejectedValueOnce(conflict('too_many_offers'))
      .mockResolvedValue({ offer: offer({ role: 'sender' }), tank: sender });
    const { book } = setup({ createGift });
    await book.create(createInput);
    await book.create(createInput);
    await book.create(createInput);
    const keys = createGift.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual(['key-1', 'key-1', 'key-2']);
  });

  it('accepts a gift into the chosen tank and reports the arrival', async () => {
    const { api, onTank, book } = setup();
    expect(await book.accept({ offer: offer(), toTankId: TANK_A })).toBe(true);
    expect(api.acceptGift).toHaveBeenCalledWith(offer().id, {
      toTankId: TANK_A,
      idempotencyKey: 'key-1',
    });
    expect(onTank).toHaveBeenCalledWith(sender, arrival);
    expect(book.getState().notice).toContain('getting used to the water');
  });

  it('drops the notice of a send that finishes after the messages were cleared', async () => {
    let finish: (value: { offer: GiftOffer; tank: Tank }) => void = () => undefined;
    const { book } = setup({
      createGift: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      ),
    });
    const sent = book.create(createInput);
    book.clearMessages();
    finish({ offer: offer({ role: 'sender' }), tank: sender });
    await sent;
    expect(book.getState().notice).toBeNull();
    expect(book.getState().busy).toBeNull();
  });

  it('drops the error of a send that fails after the messages were cleared', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const { book } = setup({
      createGift: vi.fn().mockReturnValue(
        new Promise((_, reject) => {
          fail = reject;
        }),
      ),
    });
    const sent = book.create(createInput);
    book.clearMessages();
    fail(new Error('boom'));
    await sent;
    expect(book.getState().error).toBeNull();
  });

  it('sends the pledged fish when countering and expects no arrival yet', async () => {
    const { api, onTank, book } = setup({
      acceptGift: vi.fn().mockResolvedValue({ offer: offer(), tank: sender, arrival: null }),
    });
    const trade = offer({ wantsReturn: true });
    await book.accept({ offer: trade, toTankId: TANK_A, returnFishId: FISH_2 });
    expect(api.acceptGift).toHaveBeenCalledWith(trade.id, {
      toTankId: TANK_A,
      returnFishId: FISH_2,
      idempotencyKey: 'key-1',
    });
    expect(onTank).toHaveBeenCalledWith(sender, null);
    expect(book.getState().notice).toContain('arrives once @reef_fan confirms');
  });

  it('confirms a countered trade and reports the arrival', async () => {
    const { api, onTank, book } = setup();
    const countered = offer({
      role: 'sender',
      status: 'countered',
      wantsReturn: true,
      pledged: giftFish({ name: 'Bubbles' }),
    });
    expect(await book.confirm(countered, TANK_A)).toBe(true);
    expect(api.confirmGift).toHaveBeenCalledWith(countered.id, {
      toTankId: TANK_A,
      idempotencyKey: 'key-1',
    });
    expect(onTank).toHaveBeenCalledWith(sender, arrival);
    expect(book.getState().notice).toContain('Bubbles');
  });

  it('declines without a tank, and cancels with the returned tank', async () => {
    const { api, onTank, book } = setup();
    await book.decline(offer());
    expect(api.declineGift).toHaveBeenCalledWith(offer().id);
    expect(onTank).not.toHaveBeenCalled();
    await book.cancel(offer({ role: 'sender' }));
    expect(api.cancelGift).toHaveBeenCalledTimes(1);
    expect(onTank).toHaveBeenCalledWith(sender, null);
    expect(book.getState().notice).toContain('back in your tank');
  });

  it('refreshes the list after a stale-offer refusal and keeps the message', async () => {
    const { api, book } = setup({
      acceptGift: vi.fn().mockRejectedValue(conflict('offer_closed')),
    });
    expect(await book.accept({ offer: offer(), toTankId: TANK_A })).toBe(false);
    expect(api.gifts).toHaveBeenCalledTimes(1);
    expect(book.getState().error).toContain('already settled');
  });

  it('refreshes the list after offer_changed on confirm', async () => {
    const { api, book } = setup({
      confirmGift: vi.fn().mockRejectedValue(conflict('offer_changed')),
    });
    expect(await book.confirm(offer({ role: 'sender', status: 'countered' }), TANK_A)).toBe(false);
    expect(api.gifts).toHaveBeenCalledTimes(1);
    expect(book.getState().error).toContain('offer changed while you were confirming');
  });

  it('keeps the key across a network failure for accept and confirm', async () => {
    const down = new ApiRequestError(0, 'network', 'down');
    const acceptGift = vi
      .fn()
      .mockRejectedValueOnce(down)
      .mockResolvedValue({ offer: offer(), tank: sender, arrival });
    const confirmGift = vi
      .fn()
      .mockRejectedValueOnce(down)
      .mockResolvedValue({ offer: offer(), tank: sender, arrival });
    const { book } = setup({ acceptGift, confirmGift });
    await book.accept({ offer: offer(), toTankId: TANK_A });
    await book.accept({ offer: offer(), toTankId: TANK_A });
    const countered = offer({ role: 'sender', status: 'countered' });
    await book.confirm(countered, TANK_A);
    await book.confirm(countered, TANK_A);
    const keyOf = (c: unknown[]) => (c[1] as { idempotencyKey: string }).idempotencyKey;
    expect(acceptGift.mock.calls.map(keyOf)).toEqual(['key-1', 'key-1']);
    expect(confirmGift.mock.calls.map(keyOf)).toEqual(['key-2', 'key-2']);
  });

  it('ignores an older refresh that lands after a newer one', async () => {
    const stale = { incoming: [offer({ id: 'stale' })], outgoing: [] };
    const fresh = { incoming: [], outgoing: [] };
    let releaseOld: (v: typeof stale) => void = () => undefined;
    const gifts = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValue(fresh);
    const { book } = setup({ gifts });
    const old = book.refresh();
    await book.refresh();
    releaseOld(stale);
    await old;
    expect(book.getState().offers).toEqual(fresh);
    expect(book.getState().loading).toBe(false);
  });

  it('refuses a second call while one is running', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { api, book } = setup({
      declineGift: vi.fn().mockImplementation(async () => {
        await hold;
        return { offer: offer() };
      }),
    });
    const first = book.decline(offer());
    expect(book.getState().busy).toBe(offer().id);
    expect(await book.cancel(offer({ role: 'sender' }))).toBe(false);
    expect(api.cancelGift).not.toHaveBeenCalled();
    release();
    expect(await first).toBe(true);
  });

  it('keeps the list when a refresh fails and says so', async () => {
    const gifts = vi
      .fn()
      .mockResolvedValueOnce({ incoming: [offer()], outgoing: [] })
      .mockRejectedValueOnce(new ApiRequestError(0, 'network', 'down'));
    const { book } = setup({ gifts });
    await book.refresh();
    await book.refresh();
    expect(book.getState().offers?.incoming).toHaveLength(1);
    expect(book.getState().error).toContain('Could not reach the server');
    expect(book.getState().loading).toBe(false);
  });

  it('notifies subscribers and stops after dispose', async () => {
    const { book } = setup();
    const listener = vi.fn();
    book.subscribe(listener);
    await book.refresh();
    expect(listener).toHaveBeenCalled();
    book.dispose();
    listener.mockClear();
    await book.refresh();
    expect(listener).not.toHaveBeenCalled();
  });
});
