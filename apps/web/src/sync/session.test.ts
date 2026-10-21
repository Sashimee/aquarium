import type { ConflictReason, Plant, Tank } from '@aquarium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../ui/api';
import {
  apiError,
  FISH_1,
  FISH_2,
  FISH_3,
  fishFixture,
  recordBus,
  speciesFixture,
  tankFixture,
  TANK_A,
  TANK_B,
  TANK_C,
} from './fixtures';
import { ACCLIMATION_SECONDS } from './life';
import { TankSession } from './session';

const deadPip = fishFixture(FISH_1, {
  name: 'Pip',
  status: 'dead',
  diedAt: '2026-02-01T06:00:00.000Z',
  cause: 'starvation',
});

function apiMocks() {
  return {
    species: vi.fn(),
    tanks: vi.fn(),
    tank: vi.fn(),
    createTank: vi.fn(),
    renameTank: vi.fn(),
    saveDecorLayout: vi.fn(),
    saveBackground: vi.fn(),
    addFish: vi.fn(),
    wallet: vi.fn().mockResolvedValue({ balance: 500, owned: [] }),
    purchase: vi.fn(),
    saveLight: vi.fn(),
    netFish: vi.fn(),
    care: vi.fn(),
    treat: vi.fn(),
    trimPlant: vi.fn(),
    moveFish: vi.fn(),
    reportAte: vi.fn(),
    shareTank: vi.fn(),
    rotateShare: vi.fn(),
    revokeShare: vi.fn(),
    setGallery: vi.fn(),
  };
}

function setup(
  initial: Tank[] = [tankFixture({ fish: [fishFixture(FISH_1)] })],
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  const api = apiMocks();
  api.species.mockResolvedValue([speciesFixture()]);
  api.tanks.mockResolvedValue(initial);
  const rec = recordBus();
  const session = new TankSession({
    api: api as unknown as ApiClient,
    interaction: rec.bus,
    sleep: async () => undefined,
    layoutDebounceMs: 700,
    now: () => Date.parse('2026-02-01T12:00:00.000Z'),
    ...(storage ? { storage } : {}),
  });
  return { api, rec, session };
}

const setupWithStorage = (storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) =>
  setup(undefined, storage);

const verified = { emailVerified: true };

afterEach(() => vi.useRealTimers());

describe('who gets a saved tank', () => {
  it('keeps anonymous visitors off the API', async () => {
    const { api, session } = setup();
    await session.setUser(null);
    expect(session.getState().phase).toBe('anonymous');
    expect(await session.feed('flakes', 0.5)).toBe(false);
    expect(api.tanks).not.toHaveBeenCalled();
    expect(api.care).not.toHaveBeenCalled();
  });

  it('keeps unverified accounts off the API too', async () => {
    const { api, session } = setup();
    await session.setUser({ emailVerified: false });
    expect(session.getState().phase).toBe('unverified');
    expect(api.tanks).not.toHaveBeenCalled();
  });

  it('unloads the saved tank when the user signs out', async () => {
    const { rec, session } = setup();
    await session.setUser(verified);
    await session.setUser(null);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'reset' }]);
    expect(session.getState()).toMatchObject({ phase: 'anonymous', tanks: [], activeId: null });
  });
});

describe('loading and catch-up', () => {
  it('loads species and tanks, announces the active tank and keeps the server catch-up', async () => {
    const away = {
      elapsedMinutes: 600,
      capped: false,
      deaths: [
        {
          fishId: FISH_1,
          name: 'Pip',
          species: 'neon-tetra',
          cause: 'starvation' as const,
          diedAt: '2026-02-01T06:00:00.000Z',
        },
      ],
    };
    const { rec, session } = setup([tankFixture({ fish: [deadPip], away })]);
    await session.setUser(verified);
    const state = session.getState();
    expect(state.phase).toBe('ready');
    expect(state.activeId).toBe(TANK_A);
    expect(state.awayByTank[TANK_A]).toEqual(away);
    expect(rec.of('tank:loaded')).toMatchObject([
      { tankId: TANK_A, fish: [{ name: 'Pip', status: 'dead' }] },
    ]);
    session.dismissAway(TANK_A);
    expect(session.getState().awayByTank).toEqual({});
  });

  it('loads each saved tank with its own visit days and fish personalities', async () => {
    const bold = { boldness: 0.9, greed: 0.1, sociability: 0.5 };
    const { rec, session } = setup([
      tankFixture({
        id: TANK_A,
        recentVisitDays: 6,
        fish: [fishFixture(FISH_1, { personality: bold })],
      }),
      tankFixture({ id: TANK_B, recentVisitDays: 0 }),
    ]);
    await session.setUser(verified);
    expect(rec.of('tank:loaded')).toMatchObject([
      { tankId: TANK_A, recentVisitDays: 6, fish: [{ personality: bold }] },
    ]);
    await session.select(TANK_B);
    expect(rec.of('tank:loaded').at(-1)).toMatchObject({ tankId: TANK_B, recentVisitDays: 0 });
  });

  it('loads each saved tank with its own size', async () => {
    const { rec, session } = setup([
      tankFixture({ id: TANK_A, size: 'nano30' }),
      tankFixture({ id: TANK_B, size: 'long300' }),
    ]);
    await session.setUser(verified);
    expect(rec.of('tank:loaded')).toMatchObject([{ tankId: TANK_A, size: 'nano30' }]);
    await session.select(TANK_B);
    expect(rec.of('tank:loaded').at(-1)).toMatchObject({ tankId: TANK_B, size: 'long300' });
  });

  it('does not nag about a short, uneventful absence', async () => {
    const { session } = setup([
      tankFixture({ away: { elapsedMinutes: 12, capped: false, deaths: [] } }),
    ]);
    await session.setUser(verified);
    expect(session.getState().awayByTank).toEqual({});
  });

  it('retries a flaky first load with backoff and then succeeds', async () => {
    const { api, session } = setup();
    api.tanks.mockRejectedValueOnce(apiError(0, 'network')).mockResolvedValue([tankFixture()]);
    await session.setUser(verified);
    expect(api.tanks).toHaveBeenCalledTimes(2);
    expect(session.getState().phase).toBe('ready');
  });

  it('goes offline with a plain message when the server stays unreachable', async () => {
    const { api, session } = setup();
    api.tanks.mockRejectedValue(apiError(0, 'network'));
    await session.setUser(verified);
    expect(session.getState()).toMatchObject({ phase: 'offline' });
    expect(session.getState().error).toMatch(/Could not reach the server/);
    api.tanks.mockResolvedValue([tankFixture()]);
    await session.load();
    expect(session.getState()).toMatchObject({ phase: 'ready', error: null });
  });

  it('refreshes after a long absence of the tab and reports the server summary', async () => {
    const { api } = setup();
    let now = Date.parse('2026-02-01T12:00:00.000Z');
    const timed = new TankSession({
      api: api as unknown as ApiClient,
      interaction: recordBus().bus,
      sleep: async () => undefined,
      now: () => now,
    });
    await timed.setUser(verified);
    api.tank.mockResolvedValue(
      tankFixture({
        lastTickAt: '2026-02-01T13:00:00.000Z',
        away: { elapsedMinutes: 90, capped: false, deaths: [] },
      }),
    );
    await timed.onVisible();
    expect(api.tank).not.toHaveBeenCalled();
    now += 11 * 60_000;
    await timed.onVisible();
    expect(api.tank).toHaveBeenCalledTimes(1);
    expect(timed.getState().awayByTank[TANK_A]?.elapsedMinutes).toBe(90);
  });
});

describe('reconciling snapshots', () => {
  it('ignores a stale snapshot rather than rolling the tank back', async () => {
    const { api, session } = setup([tankFixture({ lastTickAt: '2026-02-01T12:00:00.000Z' })]);
    await session.setUser(verified);
    api.care.mockResolvedValue(
      tankFixture({ lastTickAt: '2026-02-01T11:00:00.000Z', name: 'Stale copy' }),
    );
    await session.careAction({ type: 'water_change' });
    expect(session.activeTank?.name).toBe('Home tank');
  });

  it('emits the new hunger and health of a living fish whose server values changed', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    const later = '2026-02-01T12:10:00.000Z';
    const sicker = fishFixture(FISH_1, { hunger: 0.8, health: 0.4 });
    api.care.mockResolvedValue(tankFixture({ lastTickAt: later, fish: [sicker] }));
    await session.careAction({ type: 'water_change' });
    await session.careAction({ type: 'water_change' });
    expect(rec.of('tank:fish-updated')).toEqual([{ tankId: TANK_A, fish: [sicker] }]);
  });

  it('emits an update when only the stage or size of a fish changed', async () => {
    const fry = fishFixture(FISH_1, { stage: 'fry', size: 0.01 });
    const { api, rec, session } = setup([tankFixture({ fish: [fry] })]);
    await session.setUser(verified);
    const grown = { ...fry, stage: 'juvenile' as const, size: 0.015 };
    api.care.mockResolvedValue(
      tankFixture({ lastTickAt: '2026-02-01T12:10:00.000Z', fish: [grown] }),
    );
    await session.careAction({ type: 'water_change' });
    expect(rec.of('tank:fish-updated')).toEqual([{ tankId: TANK_A, fish: [grown] }]);
  });

  it('announces newborn fry, and focusing the brood tells the camera and clears the notice', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    const born = fishFixture(FISH_2, { stage: 'fry', name: 'Tiny' });
    api.care.mockResolvedValue(
      tankFixture({
        lastTickAt: '2026-02-01T12:10:00.000Z',
        fish: [fishFixture(FISH_1), born],
      }),
    );
    await session.careAction({ type: 'water_change' });
    expect(session.getState().birth).toEqual({
      tankId: TANK_A,
      fishIds: [FISH_2],
      text: 'A neon tetra fry was born. Say hello to Tiny.',
    });
    session.focusBrood();
    expect(rec.of('camera:focus-fish')).toEqual([{ fishIds: [FISH_2] }]);
    expect(session.getState().birth).toBeNull();
    session.focusBrood();
    expect(rec.of('camera:focus-fish')).toHaveLength(1);
  });

  it('does not announce a fry the player bought', async () => {
    vi.useFakeTimers();
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish.mockResolvedValue(
      tankFixture({
        lastTickAt: '2026-02-01T12:01:00.000Z',
        fish: [fishFixture(FISH_1), fishFixture(FISH_2, { stage: 'fry', name: 'Dot' })],
      }),
    );
    expect(await session.buy('neon-tetra', 'Dot', 'juvenile')).toBe(true);
    expect(session.getState().bagged.map((b) => b.name)).toEqual(['Dot']);
    expect(session.getState().birth).toBeNull();
  });

  it('drops the birth notice on a tank switch and does not repeat it on the way back', async () => {
    const reef = tankFixture({ id: TANK_B, name: 'Reef', biome: 'reef', fish: [] });
    const { api, session } = setup([tankFixture({ fish: [fishFixture(FISH_1)] }), reef]);
    await session.setUser(verified);
    const withFry = tankFixture({
      lastTickAt: '2026-02-01T12:10:00.000Z',
      fish: [fishFixture(FISH_1), fishFixture(FISH_2, { stage: 'fry' })],
    });
    api.care.mockResolvedValue(withFry);
    await session.careAction({ type: 'water_change' });
    expect(session.getState().birth).not.toBeNull();

    api.tank.mockResolvedValueOnce(reef);
    await session.select(TANK_B);
    expect(session.getState().activeId).toBe(TANK_B);
    expect(session.getState().birth).toBeNull();

    api.tank.mockResolvedValueOnce(withFry);
    await session.select(TANK_A);
    expect(session.getState().activeId).toBe(TANK_A);
    expect(session.getState().birth).toBeNull();
  });

  it('clears the birth notice on dismiss, and a second dismiss changes nothing', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.care.mockResolvedValue(
      tankFixture({
        lastTickAt: '2026-02-01T12:10:00.000Z',
        fish: [fishFixture(FISH_1), fishFixture(FISH_2, { stage: 'fry' })],
      }),
    );
    await session.careAction({ type: 'water_change' });
    expect(session.getState().birth).not.toBeNull();
    session.dismissBirth();
    expect(session.getState().birth).toBeNull();
    session.dismissBirth();
    expect(session.getState().birth).toBeNull();
  });

  it('emits a death exactly once and a removal when another device nets the fish', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    const later = '2026-02-01T12:10:00.000Z';
    api.care.mockResolvedValue(tankFixture({ lastTickAt: later, fish: [deadPip] }));
    await session.careAction({ type: 'water_change' });
    await session.careAction({ type: 'water_change' });
    expect(rec.of('tank:fish-died')).toHaveLength(1);
    api.care.mockResolvedValue(tankFixture({ lastTickAt: later, fish: [] }));
    await session.careAction({ type: 'water_change' });
    expect(rec.of('tank:fish-removed')).toEqual([
      { tankId: TANK_A, fishId: FISH_1, reason: 'gone' },
    ]);
  });

  it('serialises requests so overlapping actions reach the server in order', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    api.care.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          order.push('first-start');
          releaseFirst = () => {
            order.push('first-end');
            resolve(tankFixture());
          };
        }),
    );
    api.care.mockImplementationOnce(async () => {
      order.push('second-start');
      return tankFixture();
    });
    const first = session.careAction({ type: 'gravel_vacuum' });
    const second = session.careAction({ type: 'algae_scrape' });
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});

describe('care and feeding', () => {
  it('posts a hand-feed from the feed:dropped event and reports server rejections', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.care.mockResolvedValue(tankFixture());
    rec.bus.emit('feed:dropped', { food: 'flakes', portion: 0.5, particles: 4 });
    await vi.waitFor(() =>
      expect(api.care).toHaveBeenCalledWith(TANK_A, { type: 'feed', food: 'flakes', portion: 0.5 }),
    );

    api.care.mockRejectedValue(apiError(422, 'feeding_rejected'));
    expect(await session.feed('flakes', 0.5)).toBe(false);
    expect(session.getState().error).toBe('feeding_rejected (422)');
  });

  it('confirms chores in words and tells the scene', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.care.mockResolvedValue(tankFixture());
    await session.careAction({ type: 'gravel_vacuum' });
    expect(session.getState().notice).toBe('The gravel is clean.');
    expect(rec.of('tank:care')).toEqual([{ tankId: TANK_A, action: 'gravel_vacuum' }]);
  });

  it('batches eating reports and posts them for the active tank', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.reportAte.mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:05:00.000Z' }));
    rec.bus.emit('food:ate', {
      eaten: [
        { fishId: FISH_1, portion: 0.2 },
        { fishId: FISH_1, portion: 0.3 },
      ],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.reportAte).toHaveBeenCalledTimes(1);
    const [tankId, reports] = api.reportAte.mock.calls[0] as [
      string,
      { fishId: string; portion: number }[],
    ];
    expect(tankId).toBe(TANK_A);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.portion).toBeCloseTo(0.5);
  });

  it('logs the cause when eating reports cannot be sent without crypto.randomUUID', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, rec, session } = setup();
    await session.setUser(verified);
    vi.stubGlobal('crypto', {});
    try {
      rec.bus.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.2 }] });
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(api.reportAte).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('(unsupported)'),
      expect.objectContaining({ message: expect.stringContaining('crypto.randomUUID') }),
    );
    warn.mockRestore();
  });
});

describe('shop and the acclimation bag', () => {
  it('bags a new fish, then releases it after the acclimation time', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    const fresh = fishFixture(FISH_2, { name: 'Dot' });
    api.addFish.mockResolvedValue(
      tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z', fish: [fishFixture(FISH_1), fresh] }),
    );
    expect(await session.buy('neon-tetra', 'Dot', 'juvenile')).toBe(true);
    expect(rec.of('tank:fish-added')).toEqual([{ tankId: TANK_A, fish: fresh, acclimate: true }]);
    expect(session.getState().bagged.map((b) => b.name)).toEqual(['Dot']);

    await vi.advanceTimersByTimeAsync(ACCLIMATION_SECONDS * 1000 - 1);
    expect(rec.of('tank:fish-released')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.of('tank:fish-released')).toEqual([{ tankId: TANK_A, fishId: FISH_2 }]);
    expect(session.getState().bagged).toEqual([]);
  });

  it('can release early, once', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.addFish.mockResolvedValue(
      tankFixture({
        lastTickAt: '2026-02-01T12:01:00.000Z',
        fish: [fishFixture(FISH_1), fishFixture(FISH_2)],
      }),
    );
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    session.releaseNow(FISH_2);
    session.releaseNow(FISH_2);
    await vi.advanceTimersByTimeAsync(ACCLIMATION_SECONDS * 1000);
    expect(rec.of('tank:fish-released')).toHaveLength(1);
  });

  it('shows the capacity refusal from the server and adds nothing', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.addFish.mockRejectedValue(apiError(409, 'conflict'));
    expect(await session.buy('neon-tetra', 'Dot', 'juvenile')).toBe(false);
    expect(session.getState().error).toBe('conflict (409)');
    expect(rec.of('tank:fish-added')).toEqual([]);
  });
});

describe('death, net and memorial', () => {
  it('nets a dead fish: removes it from the scene and records the memorial', async () => {
    const { api, rec, session } = setup([tankFixture({ fish: [deadPip, fishFixture(FISH_2)] })]);
    await session.setUser(verified);
    api.netFish.mockResolvedValue(
      tankFixture({
        lastTickAt: '2026-02-01T12:02:00.000Z',
        fish: [fishFixture(FISH_2)],
        memorials: [
          {
            id: FISH_3,
            tankId: TANK_A,
            fishName: 'Pip',
            species: 'neon-tetra',
            bornAt: '2026-01-01T00:00:00.000Z',
            diedAt: '2026-02-01T06:00:00.000Z',
            cause: 'starvation',
          },
        ],
      }),
    );
    expect(await session.net(FISH_1)).toBe(true);
    expect(api.netFish).toHaveBeenCalledWith(TANK_A, FISH_1);
    expect(rec.of('tank:fish-removed')).toEqual([
      { tankId: TANK_A, fishId: FISH_1, reason: 'netted' },
    ]);
    expect(session.activeTank?.memorials.map((m) => m.fishName)).toEqual(['Pip']);
    expect(session.getState().notice).toBe('Pip was netted and added to the memorial.');
  });

  it('asks before netting when the fish system reports a net tap', async () => {
    const { api, rec, session } = setup([tankFixture({ fish: [deadPip, fishFixture(FISH_2)] })]);
    await session.setUser(verified);
    api.netFish.mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:02:00.000Z' }));
    rec.bus.emit('net:tap', { fishId: FISH_1 });
    expect(session.getState().pendingNet).toBe(FISH_1);
    expect(api.netFish).not.toHaveBeenCalled();

    session.cancelNet();
    expect(session.getState().pendingNet).toBeNull();
    expect(api.netFish).not.toHaveBeenCalled();

    rec.bus.emit('net:tap', { fishId: FISH_1 });
    expect(await session.confirmNet()).toBe(true);
    expect(api.netFish).toHaveBeenCalledWith(TANK_A, FISH_1);
    expect(session.getState().pendingNet).toBeNull();
  });

  it('ignores a net tap on a living fish', async () => {
    const { api, rec, session } = setup([tankFixture({ fish: [fishFixture(FISH_2)] })]);
    await session.setUser(verified);
    rec.bus.emit('net:tap', { fishId: FISH_2 });
    expect(session.getState().pendingNet).toBeNull();
    expect(await session.confirmNet()).toBe(false);
    expect(api.netFish).not.toHaveBeenCalled();
  });

  it('keeps the fish in the scene when the server refuses to net a living fish', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.netFish.mockRejectedValue(apiError(409, 'conflict'));
    expect(await session.net(FISH_1)).toBe(false);
    expect(rec.of('tank:fish-removed')).toEqual([]);
    expect(session.activeTank?.fish).toHaveLength(1);
  });
});

describe('sign-out safety', () => {
  const second = tankFixture({ id: TANK_B, name: 'Reef', biome: 'reef', fish: [] });

  it('ignores a tank pick made while signing out', async () => {
    const { api, rec, session } = setup([tankFixture(), second]);
    await session.setUser(verified);
    const signingOut = session.setUser(null);
    await session.select(TANK_B);
    await signingOut;
    expect(api.tank).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ phase: 'anonymous', tanks: [], activeId: null });
    expect(rec.of('tank:loaded').map((e) => (e as { tankId: string }).tankId)).toEqual([TANK_A]);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'reset' }]);
  });

  it('keeps the new load when signing out and straight back in', async () => {
    const { rec, session } = setup([tankFixture(), second]);
    await session.setUser(verified);
    const out = session.setUser(null);
    const back = session.setUser(verified);
    await Promise.all([out, back]);
    expect(session.getState()).toMatchObject({ phase: 'ready', activeId: TANK_A });
    const loaded = rec.of('tank:loaded').length;
    expect(loaded - rec.of('tank:unloaded').length).toBe(1);
  });

  const lateReplies: [
    string,
    (s: TankSession) => Promise<boolean>,
    keyof ReturnType<typeof apiMocks>,
  ][] = [
    ['care', (s) => s.careAction({ type: 'gravel_vacuum' }), 'care'],
    ['buy', (s) => s.buy('neon-tetra', 'Pip', 'juvenile'), 'addFish'],
    ['net', (s) => s.net(FISH_1), 'netFish'],
    ['rename', (s) => s.rename('Den'), 'renameTank'],
  ];

  it.each(lateReplies)('drops a late %s reply after sign-out', async (_name, act, method) => {
    const { api, rec, session } = setup([tankFixture({ fish: [deadPip] })]);
    await session.setUser(verified);
    let reply: (tank: Tank) => void = () => undefined;
    api[method].mockReturnValue(new Promise<Tank>((resolve) => (reply = resolve)));
    const pending = act(session);
    await session.setUser(null);
    reply(tankFixture({ lastTickAt: '2026-02-01T12:30:00.000Z', fish: [] }));
    await pending;
    expect(session.getState()).toMatchObject({
      phase: 'anonymous',
      tanks: [],
      notice: null,
      error: null,
    });
    expect(rec.of('tank:care')).toEqual([]);
    expect(rec.of('tank:fish-removed')).toEqual([]);
  });

  it('does not show a late failure from the old account', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    let fail: (e: unknown) => void = () => undefined;
    api.care.mockReturnValue(new Promise<Tank>((_r, reject) => (fail = reject)));
    const pending = session.careAction({ type: 'water_change' });
    await vi.waitFor(() => expect(api.care).toHaveBeenCalled());
    await session.setUser(null);
    fail(apiError(500, 'internal'));
    await pending;
    expect(session.getState().error).toBeNull();
  });

  it('removes the remembered active tank at sign-out', async () => {
    const storage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const { session } = setupWithStorage(storage);
    await session.setUser(verified);
    await session.setUser(null);
    expect(storage.removeItem).toHaveBeenCalledWith('aquarium.activeTank');
  });

  it('does not leave the dropped-reports notice behind when signing out mid-switch', async () => {
    const hang = new Promise<never>(() => undefined);
    const api = {
      species: vi.fn().mockResolvedValue([speciesFixture()]),
      tanks: vi.fn().mockResolvedValue([tankFixture({ fish: [fishFixture(FISH_1)] }), second]),
      tank: vi.fn().mockResolvedValue({ ...second, lastTickAt: '2026-02-01T12:00:00.000Z' }),
      wallet: vi.fn().mockResolvedValue({ balance: 500, owned: [] }),
      reportAte: vi.fn().mockReturnValue(hang),
    };
    const rec = recordBus();
    const session = new TankSession({
      api: api as unknown as ApiClient,
      interaction: rec.bus,
      sleep: async () => undefined,
      now: () => Date.parse('2026-02-01T12:00:00.000Z'),
      leaveFlushMs: 20,
    });
    await session.setUser(verified);
    rec.bus.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });
    const switching = session.select(TANK_B);
    await session.setUser(null);
    await switching;
    expect(session.getState()).toMatchObject({ phase: 'anonymous', notice: null });
    session.dispose();
  });

  it('sends nothing that was still queued when the user signs out', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    let release: (tank: Tank) => void = () => undefined;
    api.care.mockImplementationOnce(() => new Promise<Tank>((resolve) => (release = resolve)));
    api.care.mockResolvedValue(tankFixture());
    const first = session.careAction({ type: 'water_change' });
    const second = session.careAction({ type: 'gravel_vacuum' });
    await vi.waitFor(() => expect(api.care).toHaveBeenCalledTimes(1));
    await session.setUser(null);
    release(tankFixture());
    await Promise.all([first, second]);
    expect(api.care).toHaveBeenCalledTimes(1);
    expect(session.getState().error).toBeNull();
    session.dispose();
  });

  it('announces a death as a notice and clears it with the session', async () => {
    const { api, session } = setup([tankFixture({ fish: [fishFixture(FISH_1, { name: 'Pip' })] })]);
    await session.setUser(verified);
    api.care.mockResolvedValue(
      tankFixture({ lastTickAt: '2026-02-01T12:30:00.000Z', fish: [deadPip] }),
    );
    await session.careAction({ type: 'feed', food: 'flakes', portion: 0.5 });
    expect(session.getState().notice).toMatch(/^Pip the .* has died\./);
    await session.setUser(null);
    expect(session.getState().notice).toBeNull();
  });
});

describe('tank switcher and naming', () => {
  const second = tankFixture({ id: TANK_B, name: 'Reef', biome: 'reef', fish: [] });

  it('switches: unloads the old tank, loads the new one and refreshes it from the server', async () => {
    const { api, rec, session } = setup([tankFixture(), second]);
    await session.setUser(verified);
    api.tank.mockResolvedValue({ ...second, lastTickAt: '2026-02-01T12:00:00.000Z' });
    await session.select(TANK_B);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'switch' }]);
    expect(rec.of('tank:loaded').map((e) => (e as { tankId: string }).tankId)).toEqual([
      TANK_A,
      TANK_B,
    ]);
    expect(session.getState().activeId).toBe(TANK_B);
  });

  it('ignores a switch to the active or an unknown tank', async () => {
    const { rec, session } = setup([tankFixture(), second]);
    await session.setUser(verified);
    await session.select(TANK_A);
    await session.select('nope');
    expect(rec.of('tank:unloaded')).toEqual([]);
  });

  describe('when the tank being switched to goes during the wait for feeding reports', () => {
    function switching(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
      const api = {
        species: vi.fn().mockResolvedValue([speciesFixture()]),
        tanks: vi.fn().mockResolvedValue([tankFixture({ fish: [fishFixture(FISH_1)] }), second]),
        tank: vi.fn().mockResolvedValue(second),
        wallet: vi.fn().mockResolvedValue({ balance: 500, owned: [] }),
        reportAte: vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
      };
      const rec = recordBus();
      const session = new TankSession({
        api: api as unknown as ApiClient,
        interaction: rec.bus,
        sleep: async () => undefined,
        now: () => Date.parse('2026-02-01T12:00:00.000Z'),
        leaveFlushMs: 20,
        ...(storage ? { storage } : {}),
      });
      const remove = (keep: Tank[]) =>
        (session as unknown as { patch(change: { tanks: Tank[] }): void }).patch({ tanks: keep });
      return { api, rec, session, remove };
    }

    it('shows the first remaining tank, says so and does not request the missing one', async () => {
      const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
      const { api, rec, session, remove } = switching(storage);
      await session.setUser(verified);
      rec.bus.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });
      const pending = session.select(TANK_B);
      remove([tankFixture({ fish: [fishFixture(FISH_1)] })]);
      await pending;
      expect(api.tank).not.toHaveBeenCalled();
      expect(session.getState().activeId).toBe(TANK_A);
      expect(session.getState().notice).toBe(
        'That tank is no longer available. Showing Home tank instead.',
      );
      expect(session.getState().error).toBeNull();
      expect(storage.setItem).toHaveBeenLastCalledWith('aquarium.activeTank', TANK_A);
      expect(rec.of('tank:loaded').at(-1)).toMatchObject({ tankId: TANK_A });
      session.dispose();
    });

    it('brings the demo tank back when no tanks are left', async () => {
      const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
      const { api, rec, session, remove } = switching(storage);
      await session.setUser(verified);
      rec.bus.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });
      const pending = session.select(TANK_B);
      remove([]);
      await pending;
      expect(api.tank).not.toHaveBeenCalled();
      expect(session.getState().activeId).toBeNull();
      expect(session.getState().notice).toBe(
        'That tank is no longer available. You have no tanks left.',
      );
      expect(rec.of('tank:none')).toHaveLength(1);
      expect(storage.removeItem).toHaveBeenCalledWith('aquarium.activeTank');
      session.dispose();
    });
  });

  it('creates a tank and makes it the active one', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.createTank.mockResolvedValue(second);
    expect(await session.createTank('Reef', 'reef')).toBe(true);
    expect(session.getState().activeId).toBe(TANK_B);
    expect(session.getState().tanks).toHaveLength(2);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'switch' }]);
  });

  it('sends the chosen size, and the standard size by default', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.createTank.mockResolvedValue(second);
    await session.createTank('Den', 'freshwater', 'nano30');
    expect(api.createTank).toHaveBeenLastCalledWith({
      name: 'Den',
      biome: 'freshwater',
      size: 'nano30',
      idempotencyKey: expect.any(String),
    });
    await session.createTank('Big', 'freshwater');
    expect(api.createTank).toHaveBeenLastCalledWith({
      name: 'Big',
      biome: 'freshwater',
      size: 'standard',
      idempotencyKey: expect.any(String),
    });
  });

  it('surfaces the tank limit and stays on the current tank', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.createTank.mockRejectedValue(apiError(409, 'conflict'));
    expect(await session.createTank('Sixth', 'freshwater')).toBe(false);
    expect(session.getState().activeId).toBe(TANK_A);
  });

  it('lets the last pick win when tanks are chosen in quick succession', async () => {
    const third = tankFixture({ id: TANK_C, name: 'Third', fish: [] });
    const { api, rec, session } = setup([tankFixture(), second, third]);
    await session.setUser(verified);
    api.tank.mockResolvedValue({ ...third, lastTickAt: '2026-02-01T12:00:00.000Z' });
    const pickB = session.select(TANK_B);
    expect(session.getState().busy).toBe(true);
    const pickC = session.select(TANK_C);
    await Promise.all([pickB, pickC]);
    expect(session.getState()).toMatchObject({ activeId: TANK_C, busy: false });
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'switch' }]);
    expect(rec.of('tank:loaded').map((e) => (e as { tankId: string }).tankId)).toEqual([
      TANK_A,
      TANK_C,
    ]);
    expect(api.tank).toHaveBeenCalledTimes(1);
    expect(api.tank).toHaveBeenCalledWith(TANK_C);
  });

  it('does not wait on retries when the network is down during a switch', async () => {
    const abortableSleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const api = {
      species: vi.fn().mockResolvedValue([speciesFixture()]),
      tanks: vi.fn().mockResolvedValue([tankFixture({ fish: [fishFixture(FISH_1)] }), second]),
      tank: vi.fn().mockResolvedValue({ ...second, lastTickAt: '2026-02-01T12:00:00.000Z' }),
      wallet: vi.fn().mockResolvedValue({ balance: 500, owned: [] }),
      reportAte: vi.fn().mockRejectedValue(apiError(0, 'network')),
    };
    const rec = recordBus();
    const session = new TankSession({
      api: api as unknown as ApiClient,
      interaction: rec.bus,
      sleep: abortableSleep,
      now: () => Date.parse('2026-02-01T12:00:00.000Z'),
      leaveFlushMs: 20,
    });
    await session.setUser(verified);
    rec.bus.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });

    await session.select(TANK_B);

    expect(session.getState()).toMatchObject({ activeId: TANK_B, busy: false });
    expect(session.getState().notice).toMatch(/feeding reports .* dropped/);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'switch' }]);
    const calls = api.reportAte.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(api.reportAte.mock.calls.length).toBe(calls);
    session.dispose();
  });

  it('does not resurrect a tank created just before the user signed out', async () => {
    const storage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const { api, rec, session } = setupWithStorage(storage);
    await session.setUser(verified);
    let finishCreate: (tank: Tank) => void = () => undefined;
    api.createTank.mockReturnValue(new Promise<Tank>((resolve) => (finishCreate = resolve)));
    const creating = session.createTank('Den', 'freshwater');
    await session.setUser(null);
    finishCreate(tankFixture({ id: TANK_B, name: 'Den' }));
    expect(await creating).toBe(false);
    expect(session.getState()).toMatchObject({ phase: 'anonymous', tanks: [], activeId: null });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(rec.of('tank:loaded').map((e) => (e as { tankId: string }).tankId)).toEqual([TANK_A]);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'reset' }]);
  });

  it('leaves exactly one tank live when a create finishes during a reload', async () => {
    const { api, rec, session } = setup([tankFixture(), second]);
    await session.setUser(verified);
    let finishCreate: (tank: Tank) => void = () => undefined;
    api.createTank.mockReturnValue(new Promise<Tank>((resolve) => (finishCreate = resolve)));
    const creating = session.createTank('Den', 'freshwater');
    await session.load();
    finishCreate(tankFixture({ id: TANK_C, name: 'Den' }));
    expect(await creating).toBe(false);
    const loaded = rec.of('tank:loaded').length;
    const unloaded = rec.of('tank:unloaded').length;
    expect(loaded - unloaded).toBe(1);
    expect(session.getState().tanks.map((t) => t.id)).toEqual([TANK_A, TANK_B]);
    expect(session.getState().activeId).toBe(TANK_A);
  });

  it('says reports were dropped when the periodic flush was already retrying', async () => {
    vi.useFakeTimers();
    const abortableSleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const api = {
      species: vi.fn().mockResolvedValue([speciesFixture()]),
      tanks: vi.fn().mockResolvedValue([tankFixture({ fish: [fishFixture(FISH_1)] }), second]),
      tank: vi.fn().mockResolvedValue({ ...second, lastTickAt: '2026-02-01T12:00:00.000Z' }),
      wallet: vi.fn().mockResolvedValue({ balance: 500, owned: [] }),
      reportAte: vi.fn().mockRejectedValue(apiError(0, 'network')),
    };
    const rec = recordBus();
    const session = new TankSession({
      api: api as unknown as ApiClient,
      interaction: rec.bus,
      sleep: abortableSleep,
      now: () => Date.parse('2026-02-01T12:00:00.000Z'),
      leaveFlushMs: 20,
    });
    await session.setUser(verified);
    rec.bus.emit('food:ate', { eaten: [{ fishId: FISH_1, portion: 0.3 }] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.reportAte).toHaveBeenCalledTimes(1);

    const switching = session.select(TANK_B);
    await vi.advanceTimersByTimeAsync(30);
    await switching;

    expect(session.getState().activeId).toBe(TANK_B);
    expect(session.getState().notice).toMatch(/feeding reports .* dropped/);
    session.dispose();
  });

  it('renames the active tank from the server reply', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.renameTank.mockResolvedValue(
      tankFixture({ name: 'Den', lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    expect(await session.rename('Den')).toBe(true);
    expect(api.renameTank).toHaveBeenCalledWith(TANK_A, 'Den');
    expect(session.activeTank?.name).toBe('Den');
  });
});

describe('decor layout', () => {
  const layout = [
    {
      assetId: 'rock-a',
      position: [0.1, 0.02, -0.05] as [number, number, number],
      rotationY: 0.5,
      scale: 1,
    },
  ];

  it('announces the saved layout with the tank', async () => {
    const { rec, session } = setup([tankFixture({ decorLayout: layout })]);
    await session.setUser(verified);
    expect(rec.of('tank:loaded')).toMatchObject([{ decorLayout: layout, decorEdited: true }]);
  });

  it('tells a never-edited tank from an emptied one', async () => {
    const never = setup([tankFixture({ decorLayout: [], decorEdited: false })]);
    await never.session.setUser(verified);
    expect(never.rec.of('tank:loaded')).toMatchObject([{ decorLayout: [], decorEdited: false }]);
    const emptied = setup([tankFixture({ decorLayout: [], decorEdited: true })]);
    await emptied.session.setUser(verified);
    expect(emptied.rec.of('tank:loaded')).toMatchObject([{ decorLayout: [], decorEdited: true }]);
  });

  it('saves only the newest of a burst of edits and does not echo it back to the scene', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    const later = [
      {
        assetId: 'rock-a',
        position: [0.2, 0.02, 0] as [number, number, number],
        rotationY: 0.5,
        scale: 1,
      },
    ];
    api.saveDecorLayout.mockResolvedValue(
      tankFixture({ decorLayout: later, lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout });
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout: later });
    await vi.advanceTimersByTimeAsync(700);
    expect(api.saveDecorLayout).toHaveBeenCalledTimes(1);
    expect(api.saveDecorLayout).toHaveBeenCalledWith(TANK_A, later);
    expect(session.activeTank?.decorLayout).toEqual(later);
    expect(rec.of('tank:decor')).toEqual([]);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saved', message: null });
    session.dispose();
  });

  it('announces the saved background with the tank and saves a pick without echoing it back', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup([tankFixture({ backgroundId: 'bg-fw-root-tangle' })]);
    await session.setUser(verified);
    expect(rec.of('tank:loaded')).toMatchObject([{ backgroundId: 'bg-fw-root-tangle' }]);
    api.saveBackground.mockResolvedValue(
      tankFixture({ backgroundId: 'bg-fw-misty-lake', lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    rec.bus.emit('background:save', { tankId: TANK_A, backgroundId: 'bg-fw-plant-wall' });
    rec.bus.emit('background:save', { tankId: TANK_A, backgroundId: 'bg-fw-misty-lake' });
    await vi.advanceTimersByTimeAsync(700);
    expect(api.saveBackground).toHaveBeenCalledTimes(1);
    expect(api.saveBackground).toHaveBeenCalledWith(TANK_A, 'bg-fw-misty-lake');
    expect(session.activeTank?.backgroundId).toBe('bg-fw-misty-lake');
    expect(rec.of('tank:background')).toEqual([]);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saved', message: null });
    session.dispose();
  });

  it('shows a background changed on another device', async () => {
    const { api } = setup();
    const rec = recordBus();
    const session = new TankSession({
      api: api as unknown as ApiClient,
      interaction: rec.bus,
      sleep: async () => undefined,
      now: () => Date.parse('2026-02-01T12:00:00.000Z'),
      refreshAfterMs: 0,
    });
    await session.setUser(verified);
    api.tank.mockResolvedValue(
      tankFixture({ backgroundId: 'bg-fw-plant-wall', lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    await session.onVisible();
    expect(rec.of('tank:background')).toEqual([
      { tankId: TANK_A, backgroundId: 'bg-fw-plant-wall' },
    ]);
  });

  it.each(['layout', 'background'] as const)(
    'keeps a failed %s save on show when the other save succeeds, and Retry resends it',
    async (failing) => {
      vi.useFakeTimers();
      const { api, rec, session } = setup();
      await session.setUser(verified);
      const fresh = { lastTickAt: '2026-02-01T12:00:00.000Z' };
      const failedCall = failing === 'layout' ? api.saveDecorLayout : api.saveBackground;
      const okCall = failing === 'layout' ? api.saveBackground : api.saveDecorLayout;
      failedCall.mockRejectedValueOnce(apiError(400, 'validation_failed'));
      okCall.mockResolvedValue(tankFixture(fresh));
      const submit = (what: 'layout' | 'background') =>
        what === 'layout'
          ? rec.bus.emit('decor:layout', { tankId: TANK_A, layout })
          : rec.bus.emit('background:save', { tankId: TANK_A, backgroundId: 'bg-fw-plant-wall' });
      submit(failing);
      await vi.advanceTimersByTimeAsync(700);
      expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'error' });
      submit(failing === 'layout' ? 'background' : 'layout');
      await vi.advanceTimersByTimeAsync(700);
      expect(okCall).toHaveBeenCalledTimes(1);
      expect(rec.of('decor:save-state').at(-1)).toMatchObject({
        status: 'error',
        source: failing,
      });
      failedCall.mockResolvedValue(tankFixture(fresh));
      rec.bus.emit('decor:command', { type: 'retry-save' });
      await vi.advanceTimersByTimeAsync(700);
      expect(failedCall).toHaveBeenCalledTimes(2);
      expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saved' });
      session.dispose();
    },
  );

  it('names the saver still running when the other one finishes', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    const fresh = { lastTickAt: '2026-02-01T12:00:00.000Z' };
    let finishBackground: (tank: ReturnType<typeof tankFixture>) => void = () => undefined;
    api.saveBackground.mockReturnValue(
      new Promise((resolve) => {
        finishBackground = resolve;
      }),
    );
    let finishLayout: (tank: ReturnType<typeof tankFixture>) => void = () => undefined;
    api.saveDecorLayout.mockReturnValue(
      new Promise((resolve) => {
        finishLayout = resolve;
      }),
    );
    rec.bus.emit('background:save', { tankId: TANK_A, backgroundId: 'bg-fw-plant-wall' });
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout });
    await vi.advanceTimersByTimeAsync(700);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saving' });
    finishBackground(tankFixture(fresh));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.saveDecorLayout).toHaveBeenCalledTimes(1);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saving', source: 'layout' });
    finishLayout(tankFixture(fresh));
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saved', source: 'layout' });
    session.dispose();
  });

  it('keeps a failed background save for Retry', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.saveBackground.mockRejectedValueOnce(apiError(400, 'validation_failed'));
    rec.bus.emit('background:save', { tankId: TANK_A, backgroundId: 'bg-fw-plant-wall' });
    await vi.advanceTimersByTimeAsync(700);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'error' });
    api.saveBackground.mockResolvedValue(
      tankFixture({ backgroundId: 'bg-fw-plant-wall', lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    rec.bus.emit('decor:command', { type: 'retry-save' });
    await vi.advanceTimersByTimeAsync(700);
    expect(api.saveBackground).toHaveBeenCalledTimes(2);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saved', message: null });
    session.dispose();
  });

  it('shows a layout changed on another device', async () => {
    const { api } = setup();
    const rec = recordBus();
    const session = new TankSession({
      api: api as unknown as ApiClient,
      interaction: rec.bus,
      sleep: async () => undefined,
      now: () => Date.parse('2026-02-01T12:00:00.000Z'),
      refreshAfterMs: 0,
    });
    await session.setUser(verified);
    api.tank.mockResolvedValue(
      tankFixture({ decorLayout: layout, lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    await session.onVisible();
    expect(rec.of('tank:decor')).toEqual([{ tankId: TANK_A, layout, edited: true }]);
  });

  it('drops an edit still waiting to be saved when the user signs out', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout });
    await session.setUser(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.saveDecorLayout).not.toHaveBeenCalled();
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'idle', message: null });
    session.dispose();
  });

  it('forgets a failed save at sign-out so Retry cannot resend it to the next account', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.saveDecorLayout.mockRejectedValue(apiError(400, 'validation_failed'));
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout });
    await vi.advanceTimersByTimeAsync(700);
    expect(api.saveDecorLayout).toHaveBeenCalledTimes(1);
    await session.setUser(null);
    await session.setUser(verified);
    rec.bus.emit('decor:command', { type: 'retry-save' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.saveDecorLayout).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('keeps an unsaved edit on screen while a failed save waits for Retry', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.saveDecorLayout.mockRejectedValue(apiError(400, 'validation_failed'));
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout });
    await vi.advanceTimersByTimeAsync(700);
    api.care.mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:30:00.000Z' }));
    await session.careAction({ type: 'gravel_vacuum' });
    expect(rec.of('tank:decor')).toEqual([]);
    session.dispose();
  });

  it('reports a failed save and retries it on request', async () => {
    vi.useFakeTimers();
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.saveDecorLayout.mockRejectedValueOnce(apiError(400, 'validation_failed'));
    rec.bus.emit('decor:layout', { tankId: TANK_A, layout });
    await vi.advanceTimersByTimeAsync(700);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'error' });
    api.saveDecorLayout.mockResolvedValue(
      tankFixture({ decorLayout: layout, lastTickAt: '2026-02-01T12:00:00.000Z' }),
    );
    rec.bus.emit('decor:command', { type: 'retry-save' });
    await vi.advanceTimersByTimeAsync(700);
    expect(rec.of('decor:save-state').at(-1)).toMatchObject({ status: 'saved', message: null });
    session.dispose();
  });
});

describe('telling the scene no saved tank is coming', () => {
  it('says so on sign-out and for unverified accounts, loaded tank or not', async () => {
    const { rec, session } = setup();
    await session.setUser(null);
    expect(rec.of('tank:none')).toHaveLength(1);
    await session.setUser(verified);
    expect(rec.of('tank:none')).toHaveLength(1);
    await session.setUser({ emailVerified: false });
    expect(rec.of('tank:none')).toHaveLength(2);
  });

  it('says so when the account has no tanks', async () => {
    const { rec, session } = setup([]);
    await session.setUser(verified);
    expect(session.getState().phase).toBe('ready');
    expect(rec.of('tank:loaded')).toEqual([]);
    expect(rec.of('tank:none')).toHaveLength(1);
  });

  it('says so when the tank list cannot be loaded after a tank was shown', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.tanks.mockRejectedValue(apiError(0, 'network'));
    await session.load();
    expect(session.getState().phase).toBe('offline');
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A, reason: 'switch' }]);
    expect(rec.of('tank:none')).toHaveLength(1);
  });

  it('stays quiet while a saved tank loads', async () => {
    const { rec, session } = setup();
    await session.setUser(verified);
    expect(rec.of('tank:none')).toEqual([]);
  });
});

describe('public sharing', () => {
  const TOKEN = 'A'.repeat(43);
  const NEXT_TOKEN = 'B'.repeat(43);

  it('hands the issued token to the caller and keeps it out of the stored tank', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.shareTank.mockResolvedValue(tankFixture({ shared: true, shareToken: TOKEN }));
    const outcome = await session.changeSharing('share');
    expect(api.shareTank).toHaveBeenCalledWith(TANK_A);
    expect(outcome).toEqual({ ok: true, token: TOKEN });
    expect(session.activeTank).toMatchObject({ shared: true, shareToken: null });
    expect(JSON.stringify(session.getState())).not.toContain(TOKEN);
  });

  it('rotates a link that was shared before the token could be read back', async () => {
    const { api, session } = setup([tankFixture({ shared: true })]);
    await session.setUser(verified);
    api.rotateShare.mockResolvedValue(tankFixture({ shared: true, shareToken: NEXT_TOKEN }));
    expect(await session.changeSharing('rotate')).toEqual({ ok: true, token: NEXT_TOKEN });
    expect(session.activeTank?.shareToken).toBeNull();
  });

  it('revokes without returning a token', async () => {
    const { api, session } = setup([tankFixture({ shared: true })]);
    await session.setUser(verified);
    api.revokeShare.mockResolvedValue(tankFixture({ shared: false }));
    expect(await session.changeSharing('revoke')).toEqual({ ok: true, token: null });
    expect(session.activeTank?.shared).toBe(false);
  });

  it('reports a failure and changes nothing', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.shareTank.mockRejectedValue(apiError(400, 'validation_failed'));
    expect(await session.changeSharing('share')).toEqual({ ok: false, token: null });
    expect(session.activeTank?.shared).toBe(false);
    expect(session.getState().error).not.toBeNull();
  });

  it('does nothing without an active tank', async () => {
    const { api, session } = setup([]);
    await session.setUser(verified);
    expect(await session.changeSharing('share')).toEqual({ ok: false, token: null });
    expect(api.shareTank).not.toHaveBeenCalled();
  });
});

describe('gallery listing', () => {
  it('lists a shared tank and says so', async () => {
    const { api, session } = setup([tankFixture({ shared: true })]);
    await session.setUser(verified);
    api.setGallery.mockResolvedValue(tankFixture({ shared: true, inGallery: true }));
    expect(await session.setGalleryListed(true)).toBe(true);
    expect(api.setGallery).toHaveBeenCalledWith(TANK_A, true);
    expect(session.activeTank?.inGallery).toBe(true);
    expect(session.getState().notice).toBe('Your tank is in the gallery.');
  });

  it('takes the tank out again', async () => {
    const { api, session } = setup([tankFixture({ shared: true, inGallery: true })]);
    await session.setUser(verified);
    api.setGallery.mockResolvedValue(tankFixture({ shared: true, inGallery: false }));
    expect(await session.setGalleryListed(false)).toBe(true);
    expect(session.activeTank?.inGallery).toBe(false);
    expect(session.getState().notice).toBe('Your tank is out of the gallery.');
  });

  it('shows the server reason for a 409 and keeps the tank unlisted', async () => {
    const { api, session } = setup([tankFixture()]);
    await session.setUser(verified);
    api.setGallery.mockRejectedValue(
      new ApiRequestError(
        409,
        'conflict',
        'Turn on the public link before listing this tank in the gallery.',
      ),
    );
    expect(await session.setGalleryListed(true)).toBe(false);
    expect(session.activeTank?.inGallery).toBe(false);
    expect(session.getState().error).toBe(
      'Turn on the public link before listing this tank in the gallery.',
    );
  });

  it('does nothing without an active tank', async () => {
    const { api, session } = setup([]);
    await session.setUser(verified);
    expect(await session.setGalleryListed(true)).toBe(false);
    expect(api.setGallery).not.toHaveBeenCalled();
  });
});

describe('Pearls and the T70 request contract', () => {
  const boughtTank = () =>
    tankFixture({
      lastTickAt: '2026-02-01T12:01:00.000Z',
      fish: [fishFixture(FISH_1), fishFixture(FISH_2, { name: 'Dot' })],
    });

  const keyOf = (call: unknown) => (call as { idempotencyKey: string }).idempotencyKey;

  it('reads the balance when the tanks load', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValue({ balance: 420, owned: [] });
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(420));
  });

  it('keeps showing the last balance when a refresh fails', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValueOnce({ balance: 420, owned: [] });
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(420));
    api.wallet.mockRejectedValue(apiError(0, 'network'));
    await session.refreshWallet();
    expect(session.getState().balance).toBe(420);
  });

  it('sends the stage and a key with add-fish', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish.mockResolvedValue(boughtTank());
    await session.buy('neon-tetra', 'Dot', 'adult');
    expect(api.addFish).toHaveBeenCalledWith(TANK_A, {
      species: 'neon-tetra',
      name: 'Dot',
      stage: 'adult',
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,}$/),
    });
  });

  it('reuses the key when a purchase is retried after the answer was lost', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish
      .mockRejectedValueOnce(apiError(0, 'timeout'))
      .mockRejectedValueOnce(apiError(502, 'internal'))
      .mockResolvedValue(boughtTank());
    expect(await session.buy('neon-tetra', 'Dot', 'juvenile')).toBe(false);
    expect(await session.buy('neon-tetra', 'Dot', 'juvenile')).toBe(false);
    expect(await session.buy('neon-tetra', 'Dot', 'juvenile')).toBe(true);
    const keys = api.addFish.mock.calls.map((c) => keyOf(c[1]));
    expect(new Set(keys).size).toBe(1);
  });

  it('uses a new key once a purchase went through, so buying again is a new purchase', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish.mockResolvedValue(boughtTank());
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    const [first, second] = api.addFish.mock.calls.map((c) => keyOf(c[1]));
    expect(first).not.toBe(second);
  });

  it('uses a new key after the server refused, and after the intent changed', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish
      .mockRejectedValueOnce(apiError(402, 'insufficient_pearls'))
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValue(boughtTank());
    await session.buy('neon-tetra', 'Dot', 'adult');
    await session.buy('neon-tetra', 'Dot', 'adult');
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    const keys = api.addFish.mock.calls.map((c) => keyOf(c[1]));
    expect(new Set(keys).size).toBe(3);
  });

  it('refreshes the balance after a refusal for too few Pearls', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish.mockRejectedValue(apiError(402, 'insufficient_pearls'));
    api.wallet.mockResolvedValue({ balance: 12, owned: [] });
    await session.buy('neon-tetra', 'Dot', 'adult');
    await vi.waitFor(() => expect(session.getState().balance).toBe(12));
    expect(session.getState().error).not.toBeNull();
  });

  it('sends a key with every tank creation and reuses it on a retry', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.createTank
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValue(tankFixture({ id: TANK_B, name: 'Reef', biome: 'reef' }));
    await session.createTank('Reef', 'reef', 'standard');
    await session.createTank('Reef', 'reef', 'standard');
    const keys = api.createTank.mock.calls.map((c) => keyOf(c[0]));
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('sends a key with bottled bacteria and reuses it on a retry', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.care
      .mockRejectedValueOnce(apiError(0, 'timeout'))
      .mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' }));
    await session.careAction({ type: 'bottled_bacteria' });
    await session.careAction({ type: 'bottled_bacteria' });
    await session.careAction({ type: 'bottled_bacteria' });
    const keys = api.care.mock.calls.map((c) => keyOf(c[1]));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('never gives free care a key', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.care.mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' }));
    await session.careAction({ type: 'water_change' });
    expect(api.care).toHaveBeenCalledWith(TANK_A, { type: 'water_change' });
  });

  it('buys equipment, shows the new balance and the upgraded tank', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.purchase.mockResolvedValue({ wallet: { balance: 250 }, entry: {}, replayed: false });
    const upgraded = tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' });
    api.tank.mockResolvedValue({
      ...upgraded,
      equipment: { ...upgraded.equipment, filter: { tier: 2 } },
    });
    expect(await session.purchase('equipment:filter:2', 'Installed.')).toBe(true);
    expect(api.purchase).toHaveBeenCalledWith({
      itemRef: 'equipment:filter:2',
      tankId: TANK_A,
      idempotencyKey: expect.any(String),
    });
    expect(session.activeTank?.equipment.filter.tier).toBe(2);
    expect(session.getState().notice).toBe('Installed.');
  });

  describe('wave maker tier', () => {
    const withWaveMaker = (tank: Tank, tier: number): Tank => ({
      ...tank,
      equipment: { ...tank.equipment, waveMaker: { tier } },
    });
    const watch = (rec: ReturnType<typeof setup>['rec']) => {
      const seen: { tankId: string; tier: number }[] = [];
      rec.bus.on('tank:wave-maker', (e) => seen.push(e));
      return seen;
    };

    it('announces each tank own tier on load and on a switch', async () => {
      const { rec, session } = setup([
        withWaveMaker(tankFixture({ id: TANK_A }), 0),
        withWaveMaker(tankFixture({ id: TANK_B }), 2),
      ]);
      const seen = watch(rec);
      await session.setUser(verified);
      await session.select(TANK_B);
      expect(seen).toEqual([
        { tankId: TANK_A, tier: 0 },
        { tankId: TANK_B, tier: 2 },
      ]);
    });

    it('announces a bought or upgraded wave maker, and only when the tier changes', async () => {
      const { api, rec, session } = setup();
      const seen = watch(rec);
      await session.setUser(verified);
      api.purchase.mockResolvedValue({ wallet: { balance: 250 }, entry: {}, replayed: false });
      let minute = 1;
      const buy = async (tier: number) => {
        api.tank.mockResolvedValue(
          withWaveMaker(tankFixture({ lastTickAt: `2026-02-01T12:0${minute++}:00.000Z` }), tier),
        );
        await session.purchase(`equipment:waveMaker:${tier}`, 'Installed.');
      };
      await buy(1);
      await buy(1);
      await buy(3);
      expect(seen.map((e) => e.tier)).toEqual([0, 1, 3]);
    });
  });

  it('leaves owned unchanged when an equipment purchase is refused with a conflict', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValueOnce({ balance: 500, owned: ['plant:java-fern'] });
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().owned).toEqual(['plant:java-fern']));
    api.purchase.mockRejectedValue(apiError(409, 'conflict'));
    api.wallet.mockResolvedValue({ balance: 500, owned: ['plant:java-fern'] });
    await session.purchase('equipment:filter:2', 'Installed.');
    expect(session.getState().owned).toEqual(['plant:java-fern']);
  });

  describe('lamp hours for the hood light', () => {
    const withLamp = (tank: Tank, onHour: number, offHour: number): Tank => ({
      ...tank,
      equipment: { ...tank.equipment, light: { ...tank.equipment.light, onHour, offHour } },
    });

    it("announces each tank's own hours on load and on a switch", async () => {
      const { rec, session } = setup([
        withLamp(tankFixture({ id: TANK_A }), 8, 20),
        withLamp(tankFixture({ id: TANK_B }), 14, 2),
      ]);
      const seen: unknown[] = [];
      rec.bus.on('tank:lamp', (e) => seen.push(e));
      await session.setUser(verified);
      await session.select(TANK_B);
      expect(seen).toEqual([
        { tankId: TANK_A, onHour: 8, offHour: 20 },
        { tankId: TANK_B, onHour: 14, offHour: 2 },
      ]);
    });

    it('announces a saved schedule and not an unchanged one', async () => {
      const { api, rec, session } = setup();
      const seen: unknown[] = [];
      rec.bus.on('tank:lamp', (e) => seen.push(e));
      await session.setUser(verified);
      const base = tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' });
      api.saveLight.mockResolvedValue(withLamp(base, 22, 6));
      await session.setLight({ intensity: 0.5, onHour: 22, offHour: 6 });
      api.care.mockResolvedValue(
        withLamp(tankFixture({ lastTickAt: '2026-02-01T12:02:00.000Z' }), 22, 6),
      );
      await session.careAction({ type: 'water_change' });
      expect(seen).toEqual([
        { tankId: TANK_A, onHour: 8, offHour: 20 },
        { tankId: TANK_A, onHour: 22, offHour: 6 },
      ]);
    });
  });

  it('reuses the purchase key on a retry', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.purchase
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValue({ wallet: { balance: 250 }, entry: {}, replayed: true });
    api.tank.mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' }));
    await session.purchase('equipment:filter:2', 'Installed.');
    await session.purchase('equipment:filter:2', 'Installed.');
    const keys = api.purchase.mock.calls.map((c) => keyOf(c[0]));
    expect(keys[1]).toBe(keys[0]);
  });

  it('saves the lamp schedule in UTC hours and shows the saved tank', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    const base = tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' });
    const light = { tier: 1, intensity: 0.5, onHour: 22, offHour: 6 };
    api.saveLight.mockResolvedValue({ ...base, equipment: { ...base.equipment, light } });
    expect(await session.setLight({ intensity: 0.5, onHour: 22, offHour: 6 })).toBe(true);
    expect(api.saveLight).toHaveBeenCalledWith(TANK_A, { intensity: 0.5, onHour: 22, offHour: 6 });
    expect(session.activeTank?.equipment.light).toEqual(light);
  });
});

describe('a balance that moves on the server', () => {
  const fresh = () => tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' });
  const wallet = (balance: number, owned: string[] = []) => ({ balance, owned });
  const keyOf = (call: unknown) => (call as { idempotencyKey: string }).idempotencyKey;

  it('re-reads the wallet after free care and reports what was earned', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValueOnce(wallet(100));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(100));
    api.care.mockResolvedValue(fresh());
    api.wallet.mockResolvedValue(wallet(140));
    await session.careAction({ type: 'water_change' });
    expect(session.getState()).toMatchObject({ balance: 140, earned: 40 });
  });

  it('adds up what is earned until it is dismissed, and never calls a spend an earning', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValueOnce(wallet(100));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(100));
    api.wallet.mockResolvedValueOnce(wallet(130)).mockResolvedValueOnce(wallet(150));
    await session.refreshWallet();
    await session.refreshWallet();
    expect(session.getState().earned).toBe(50);
    api.wallet.mockResolvedValueOnce(wallet(100));
    await session.refreshWallet();
    expect(session.getState().earned).toBe(50);
    session.dismissEarned();
    expect(session.getState().earned).toBeNull();
  });

  it('does not call the first read an earning', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValue(wallet(500));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(500));
    expect(session.getState().earned).toBeNull();
  });

  it('re-reads the wallet after netting a fish', async () => {
    const { api, session } = setup([tankFixture({ fish: [deadPip] })]);
    await session.setUser(verified);
    await vi.waitFor(() => expect(api.wallet).toHaveBeenCalledTimes(1));
    api.netFish.mockResolvedValue(fresh());
    await session.net(FISH_1);
    expect(api.wallet).toHaveBeenCalledTimes(2);
  });

  it('re-reads the wallet when the tab comes back, even within the refresh window', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    await vi.waitFor(() => expect(api.wallet).toHaveBeenCalledTimes(1));
    await session.onVisible();
    expect(api.wallet).toHaveBeenCalledTimes(2);
  });

  it('drops a wallet read that lands after a purchase reply, so no earning is announced', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValueOnce(wallet(500));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(500));
    let land: (v: { balance: number; owned: string[] }) => void = () => {};
    api.wallet.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));
    const stale = session.refreshWallet();
    api.purchase.mockResolvedValue({ wallet: { balance: 450 }, entry: {}, replayed: false });
    api.tank.mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' }));
    api.wallet.mockResolvedValue(wallet(450, ['plant:java-fern']));
    await session.purchase('plant:java-fern', 'Planted.');
    land({ balance: 500, owned: [] });
    await stale;
    expect(session.getState()).toMatchObject({ balance: 450, earned: null });
  });

  it('shares one wallet read between callers that ask while it is in flight', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    await vi.waitFor(() => expect(api.wallet).toHaveBeenCalledTimes(1));
    let land: (v: { balance: number; owned: string[] }) => void = () => {};
    api.wallet.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));
    const reads = [session.refreshWallet(), session.refreshWallet(), session.onVisible()];
    land({ balance: 500, owned: [] });
    await Promise.all(reads);
    expect(api.wallet).toHaveBeenCalledTimes(2);
  });

  it('replays the same key on a retry even after a plain wallet read', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish
      .mockRejectedValueOnce(apiError(0, 'timeout'))
      .mockResolvedValue(tankFixture({ lastTickAt: '2026-02-01T12:01:00.000Z' }));
    await session.buy('neon-tetra', 'Pip', 'juvenile');
    api.wallet.mockResolvedValue({ balance: 485, owned: [] });
    await session.refreshWallet();
    await session.buy('neon-tetra', 'Pip', 'juvenile');
    const keys = api.addFish.mock.calls.map((c) => keyOf(c[1]));
    expect(keys[1]).toBe(keys[0]);
  });

  it('does not let a new load join a wallet read started by the previous one', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(500));
    let land: (v: { balance: number; owned: string[] }) => void = () => {};
    api.wallet.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));
    void session.refreshWallet();
    await session.setUser(null);
    api.wallet.mockResolvedValue(wallet(300));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(300));
    land({ balance: 999, owned: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getState().balance).toBe(300);
  });

  it('forgets an ownership the ledger shows refunded and marks one the server calls a conflict', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValueOnce(wallet(500, ['plant:java-fern']));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().owned).toEqual(['plant:java-fern']));
    api.wallet.mockResolvedValue({ balance: 525, owned: [] });
    await session.refreshWallet();
    expect(session.getState().owned).toEqual([]);
    api.purchase.mockRejectedValue(apiError(409, 'conflict'));
    api.wallet.mockResolvedValue({ balance: 525, owned: ['decor:boulder-01'] });
    await session.purchase('decor:boulder-01', 'Placed.');
    expect(session.getState().owned).toEqual(['decor:boulder-01']);
  });

  it('marks a refusal for too few Pearls with the balance the server holds now', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish.mockRejectedValue(apiError(402, 'insufficient_pearls'));
    api.wallet.mockResolvedValue(wallet(12));
    expect(await session.buy('neon-tetra', 'Dot', 'adult')).toBe(false);
    expect(session.getState()).toMatchObject({ pearlsRefused: true, balance: 12 });
  });

  it('clears the refusal at the next paid request', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.addFish.mockRejectedValueOnce(apiError(402, 'insufficient_pearls'));
    await session.buy('neon-tetra', 'Dot', 'adult');
    api.addFish.mockResolvedValue(fresh());
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    expect(session.getState().pearlsRefused).toBe(false);
  });

  it('remembers what the ledger shows as bought, and adds a purchase at once', async () => {
    const { api, session } = setup();
    api.wallet.mockResolvedValue(wallet(500, ['plant:java-fern']));
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().owned).toEqual(['plant:java-fern']));
    api.purchase.mockResolvedValue({ wallet: { balance: 450 }, entry: {}, replayed: false });
    api.tank.mockResolvedValue(fresh());
    api.wallet.mockResolvedValue(wallet(450, ['plant:java-fern']));
    await session.purchase('decor:boulder-01', 'Yours.');
    expect(session.getState().owned).toContain('plant:java-fern');
    expect(session.getState().balance).toBe(450);
  });

  it('keeps the key of an intent with an unknown outcome however late the retry comes', async () => {
    let now = Date.parse('2026-02-01T12:00:00.000Z');
    const { api, rec } = (() => {
      const made = apiMocks();
      made.species.mockResolvedValue([speciesFixture()]);
      made.tanks.mockResolvedValue([tankFixture()]);
      return { api: made, rec: recordBus() };
    })();
    const session = new TankSession({
      api: api as unknown as ApiClient,
      interaction: rec.bus,
      sleep: async () => undefined,
      now: () => now,
    });
    await session.setUser(verified);
    api.addFish.mockRejectedValue(apiError(0, 'timeout'));
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    now += 60_000;
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    now += 11 * 60_000;
    await session.buy('neon-tetra', 'Dot', 'juvenile');
    const keys = api.addFish.mock.calls.map(
      (c) => (c[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    session.dispose();
  });
});

describe('moving a fish', () => {
  const quarantine = tankFixture({ id: TANK_B, name: 'Quarantine', quarantine: true });
  const home = () => tankFixture({ fish: [fishFixture(FISH_1, { name: 'Pip' })] });
  const refuse = (status: number, reason: ConflictReason | null, retry: number | null = null) =>
    new ApiRequestError(
      status,
      status === 429 ? 'rate_limited' : 'conflict',
      'server words',
      {},
      retry,
      reason,
    );

  it('sends the move with a key and applies both tanks', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    const pip = fishFixture(FISH_1, { name: 'Pip' });
    api.moveFish.mockResolvedValue({
      source: tankFixture({ fish: [], lastTickAt: '2026-02-01T12:01:00.000Z' }),
      destination: tankFixture({
        id: TANK_B,
        name: 'Quarantine',
        quarantine: true,
        fish: [pip],
        lastTickAt: '2026-02-01T12:01:00.000Z',
      }),
    });
    const outcome = await session.move(FISH_1, TANK_B);
    expect(outcome).toEqual({ ok: true, refusal: null });
    expect(api.moveFish).toHaveBeenCalledWith(TANK_A, FISH_1, {
      toTankId: TANK_B,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,}$/),
    });
    const state = session.getState();
    expect(state.tanks.find((t) => t.id === TANK_A)?.fish).toHaveLength(0);
    expect(state.tanks.find((t) => t.id === TANK_B)?.fish).toHaveLength(1);
    expect(state.notice).toBe('Pip was moved to Quarantine.');
  });

  it.each([
    ['fish_dead', /Pip has died/],
    ['wrong_biome', /Pip cannot live in Quarantine: it is a different kind of water/],
    ['tank_full', /Quarantine has no room for Pip/],
    ['key_reused', /clashed with an earlier one/],
  ] as const)('explains a %s refusal and starts a new key next time', async (reason, text) => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    api.moveFish.mockRejectedValue(refuse(409, reason));
    const outcome = await session.move(FISH_1, TANK_B);
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toMatch(text);
    await session.move(FISH_1, TANK_B);
    const keys = api.moveFish.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('reports a refusal once, not also as a session error', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    api.moveFish.mockRejectedValue(refuse(409, 'tank_full'));
    const errors: (string | null)[] = [];
    session.subscribe(() => errors.push(session.getState().error));
    await session.move(FISH_1, TANK_B);
    expect(errors.filter((e) => e !== null)).toEqual([]);
    api.moveFish.mockRejectedValue(refuse(429, null, 5));
    await session.move(FISH_1, TANK_B);
    expect(errors.filter((e) => e !== null)).toEqual([]);
  });

  it.each([
    ['a network error', apiError(0, 'network')],
    ['a timeout', apiError(0, 'timeout')],
    ['a 500', apiError(500, 'internal')],
    ['a 503', apiError(503, 'internal')],
  ])('keeps the key after %s so the retry replays', async (_name, failure) => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    api.moveFish.mockRejectedValue(failure);
    await session.move(FISH_1, TANK_B);
    await session.move(FISH_1, TANK_B);
    const keys = api.moveFish.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
  });

  it('does not replay a held key after the fish has been moved back', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    const pip = fishFixture(FISH_1, { name: 'Pip' });
    const at = '2026-02-01T12:01:00.000Z';
    const inHome = (fish: Tank['fish']) => tankFixture({ fish, lastTickAt: at });
    const inQuarantine = (fish: Tank['fish']) =>
      tankFixture({ id: TANK_B, name: 'Quarantine', quarantine: true, fish, lastTickAt: at });

    api.moveFish.mockRejectedValueOnce(apiError(0, 'network'));
    await session.move(FISH_1, TANK_B);

    api.tank.mockResolvedValueOnce(inQuarantine([pip]));
    await session.select(TANK_B);
    api.moveFish.mockResolvedValueOnce({ source: inQuarantine([]), destination: inHome([pip]) });
    await session.move(FISH_1, TANK_A);

    api.tank.mockResolvedValueOnce(inHome([pip]));
    await session.select(TANK_A);
    api.moveFish.mockResolvedValueOnce({ source: inHome([]), destination: inQuarantine([pip]) });
    await session.move(FISH_1, TANK_B);

    expect(api.moveFish).toHaveBeenCalledTimes(3);
    const keys = api.moveFish.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('falls back to the server text for a 409 without a known reason', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    api.moveFish.mockRejectedValue(refuse(409, null));
    expect((await session.move(FISH_1, TANK_B)).refusal).toBe('server words');
  });

  it('says how long to wait after a 429 and keeps the key for the retry', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    api.moveFish.mockRejectedValue(refuse(429, null, 12));
    const outcome = await session.move(FISH_1, TANK_B);
    expect(outcome.refusal).toBe('Too many moves in a short time. Try again in 12 seconds.');
    await session.move(FISH_1, TANK_B);
    const keys = api.moveFish.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
  });

  it('leaves the refusal empty for a failure the player cannot act on', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    api.moveFish.mockRejectedValue(apiError(0, 'network'));
    const outcome = await session.move(FISH_1, TANK_B);
    expect(outcome).toEqual({ ok: false, refusal: null });
    expect(session.getState().error).toMatch(/Could not reach the server/);
  });

  it('sends nothing for an unknown fish or tank', async () => {
    const { api, session } = setup([home(), quarantine]);
    await session.setUser(verified);
    expect((await session.move(FISH_2, TANK_B)).ok).toBe(false);
    expect((await session.move(FISH_1, '00000000-0000-4000-8000-0000000000ff')).ok).toBe(false);
    expect(api.moveFish).not.toHaveBeenCalled();
  });
});

describe('treating a tank', () => {
  const sick = fishFixture(FISH_1, {
    disease: {
      kind: 'ich',
      since: '2026-02-01T00:00:00.000Z',
      severity: 0.4,
      treatedUntil: null,
    },
  });
  const keyOf = (call: unknown) => (call as { idempotencyKey: string }).idempotencyKey;
  const dosed = (overrides: Partial<Tank> = {}) =>
    tankFixture({ fish: [sick], lastTickAt: '2026-02-01T12:01:00.000Z', ...overrides });
  const sickTank = () => [tankFixture({ fish: [sick] })];

  it('sends the dose with a key, applies the tank and the new balance for premium', async () => {
    const { api, session } = setup(sickTank());
    await session.setUser(verified);
    api.treat.mockResolvedValue({
      tank: dosed({
        medicine: {
          kind: 'ich',
          potency: 'premium',
          doses: 1,
          until: '2026-02-03T12:00:00.000Z',
        },
      }),
      overdose: false,
      wallet: { balance: 460 },
      entry: null,
    });
    const outcome = await session.treat('ich', 'premium');
    expect(outcome).toEqual({ ok: true, overdose: false, refusal: null, reason: null });
    expect(api.treat).toHaveBeenCalledWith(TANK_A, {
      kind: 'ich',
      potency: 'premium',
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,}$/),
    });
    const state = session.getState();
    expect(state.tanks[0]?.medicine?.doses).toBe(1);
    expect(state.notice).toContain('ich medicine is in the water');
  });

  it('leaves the balance alone for the free standard medicine', async () => {
    const { api, session } = setup(sickTank());
    await session.setUser(verified);
    await vi.waitFor(() => expect(session.getState().balance).toBe(500));
    api.treat.mockResolvedValue({ tank: dosed(), overdose: false, wallet: null, entry: null });
    await session.treat('ich', 'standard');
    expect(session.getState().balance).toBe(500);
  });

  it('flags an overdose in the notice', async () => {
    const { api, session } = setup(sickTank());
    await session.setUser(verified);
    api.treat.mockResolvedValue({ tank: dosed(), overdose: true, wallet: null, entry: null });
    const outcome = await session.treat('ich', 'standard');
    expect(outcome.overdose).toBe(true);
    expect(session.getState().notice).toContain('more than one dose');
  });

  it('reuses the key after an unknown outcome, then starts a new one', async () => {
    const { api, session } = setup(sickTank());
    await session.setUser(verified);
    api.treat
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValue({ tank: dosed(), overdose: false, wallet: null, entry: null });
    const first = await session.treat('ich', 'premium');
    expect(first.ok).toBe(false);
    expect(first.refusal).toBeNull();
    expect(session.getState().error).toMatch(/Could not reach the server/);
    await session.treat('ich', 'premium');
    await session.treat('ich', 'premium');
    const keys = api.treat.mock.calls.map((c) => keyOf(c[1]));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('hands back the 409 reason and does not keep the key', async () => {
    const { api, session } = setup(sickTank());
    await session.setUser(verified);
    const water = 'Change the water until only a trace is left, then switch.';
    api.treat.mockRejectedValue(
      new ApiRequestError(409, 'conflict', water, {}, null, 'other_medicine'),
    );
    const refused = await session.treat('ich', 'standard');
    expect(refused).toEqual({
      ok: false,
      overdose: false,
      refusal: water,
      reason: 'other_medicine',
    });
    await session.treat('ich', 'standard');
    const keys = api.treat.mock.calls.map((c) => keyOf(c[1]));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('starts the shortfall flow when the server refuses for too few Pearls', async () => {
    const { api, session } = setup(sickTank());
    await session.setUser(verified);
    api.treat.mockRejectedValue(apiError(402, 'insufficient_pearls'));
    api.wallet.mockResolvedValue({ balance: 12, owned: [] });
    const outcome = await session.treat('ich', 'premium');
    expect(outcome.ok).toBe(false);
    expect(session.getState().pearlsRefused).toBe(true);
    await vi.waitFor(() => expect(session.getState().balance).toBe(12));
  });

  it('sends nothing when no tank is active', async () => {
    const { api, session } = setup();
    expect(await session.treat('ich', 'standard')).toEqual({
      ok: false,
      overdose: false,
      refusal: null,
      reason: null,
    });
    expect(api.treat).not.toHaveBeenCalled();
  });

  it('creates a quarantine tank with the nano size and makes it active', async () => {
    const { api, session } = setup();
    await session.setUser(verified);
    api.createTank.mockResolvedValue(
      tankFixture({ id: TANK_B, name: 'Quarantine', quarantine: true, size: 'nano30' }),
    );
    await session.createTank('Quarantine', 'freshwater', 'nano30', true);
    expect(api.createTank).toHaveBeenCalledWith(
      expect.objectContaining({ quarantine: true, size: 'nano30' }),
    );
    expect(session.getState().activeId).toBe(TANK_B);
  });
});

describe('growing plants', () => {
  const fern = (over: Partial<Plant> = {}): Plant => ({
    key: 's7',
    assetId: 'plant-fern',
    tintSeed: 7,
    parentKey: null,
    position: null,
    size: 1.6,
    minSize: 0.4,
    maxSize: 2.4,
    ...over,
  });
  const planted = (over: Partial<Tank> = {}) =>
    tankFixture({ plants: [fern()], lastTickAt: '2026-02-01T00:00:00.000Z', ...over });
  const refuse = (status: number, code: ApiRequestError['code'], reason?: ConflictReason) =>
    new ApiRequestError(status, code, 'server words', {}, null, reason ?? null);

  it('announces the plants on load and when a returned tank changes them', async () => {
    const { api, rec, session } = setup([planted()]);
    await session.setUser(verified);
    expect(rec.of('tank:plants')).toEqual([{ tankId: TANK_A, plants: [fern()] }]);
    api.care.mockResolvedValue(planted({ lastTickAt: '2026-02-01T00:05:00.000Z' }));
    await session.careAction({ type: 'water_change' });
    expect(rec.of('tank:plants')).toHaveLength(1);
    api.care.mockResolvedValue(
      planted({ plants: [fern({ size: 1.9 })], lastTickAt: '2026-02-01T00:10:00.000Z' }),
    );
    await session.careAction({ type: 'water_change' });
    expect(rec.of('tank:plants')).toHaveLength(2);
    expect(rec.of('tank:plants')[1]).toEqual({ tankId: TANK_A, plants: [fern({ size: 1.9 })] });
  });

  it('announces an empty list for a tank without growth state', async () => {
    const { rec, session } = setup([tankFixture()]);
    await session.setUser(verified);
    expect(rec.of('tank:plants')).toEqual([{ tankId: TANK_A, plants: [] }]);
  });

  it('sends the trim with a key, applies the returned tank and announces the new size', async () => {
    const { api, rec, session } = setup([planted()]);
    await session.setUser(verified);
    api.trimPlant.mockResolvedValue(
      planted({ plants: [fern({ size: 1 })], lastTickAt: '2026-02-01T00:01:00.000Z' }),
    );
    const outcome = await session.trimPlant('s7', 1);
    expect(outcome).toEqual({ ok: true, refusal: null });
    expect(api.trimPlant).toHaveBeenCalledWith(TANK_A, {
      plantKey: 's7',
      size: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,}$/),
    });
    expect(session.getState().tanks[0]?.plants?.[0]?.size).toBe(1);
    expect(rec.of('tank:plants').at(-1)).toEqual({ tankId: TANK_A, plants: [fern({ size: 1 })] });
    expect(session.getState().notice).toBe('The fern was trimmed.');
  });

  it.each([
    [400, 'validation_failed', undefined, /cannot be cut back that far/],
    [404, 'not_found', undefined, /no longer in this tank/],
    [409, 'conflict', 'plant_not_grown', /has not grown past that size/],
    [409, 'conflict', 'key_reused', /clashed with an earlier one/],
    [429, 'rate_limited', undefined, /Too many trims/],
  ] as const)('explains a %s %s refusal', async (status, code, reason, text) => {
    const { api, session } = setup([planted()]);
    await session.setUser(verified);
    api.trimPlant.mockRejectedValue(refuse(status, code, reason));
    const outcome = await session.trimPlant('s7', 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toMatch(text);
    expect(session.getState().tanks[0]?.plants?.[0]?.size).toBe(1.6);
  });

  it('keeps the key after a rate limit or a lost reply and drops it after a refusal', async () => {
    const { api, session } = setup([planted()]);
    await session.setUser(verified);
    api.trimPlant
      .mockRejectedValueOnce(refuse(429, 'rate_limited'))
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValueOnce(
        planted({ plants: [fern({ size: 1 })], lastTickAt: '2026-02-01T00:01:00.000Z' }),
      )
      .mockRejectedValue(refuse(409, 'conflict', 'plant_not_grown'));
    await session.trimPlant('s7', 1);
    await session.trimPlant('s7', 1);
    await session.trimPlant('s7', 1);
    await session.trimPlant('s7', 0.5);
    await session.trimPlant('s7', 0.5);
    const keys = api.trimPlant.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[4]).not.toBe(keys[3]);
  });

  it('starts a new key once a trim has worked', async () => {
    const { api, session } = setup([planted()]);
    await session.setUser(verified);
    api.trimPlant.mockResolvedValue(
      planted({ plants: [fern({ size: 1 })], lastTickAt: '2026-02-01T00:01:00.000Z' }),
    );
    await session.trimPlant('s7', 1);
    await session.trimPlant('s7', 1);
    const keys = api.trimPlant.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('uses another key for another size', async () => {
    const { api, session } = setup([planted()]);
    await session.setUser(verified);
    api.trimPlant.mockRejectedValue(apiError(0, 'network'));
    await session.trimPlant('s7', 1);
    await session.trimPlant('s7', 0.8);
    const keys = api.trimPlant.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('does not call the server for a plant the tank does not have, or with no tank', async () => {
    const { api, session } = setup([tankFixture()]);
    expect(await session.trimPlant('s7', 1)).toEqual({ ok: false, refusal: null });
    await session.setUser(verified);
    expect(await session.trimPlant('s7', 1)).toEqual({ ok: false, refusal: null });
    expect(api.trimPlant).not.toHaveBeenCalled();
  });
});
