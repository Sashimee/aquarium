import type { Tank } from '@aquarium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../ui/api';
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

function setup(initial: Tank[] = [tankFixture({ fish: [fishFixture(FISH_1)] })]) {
  const api = {
    species: vi.fn().mockResolvedValue([speciesFixture()]),
    tanks: vi.fn().mockResolvedValue(initial),
    tank: vi.fn(),
    createTank: vi.fn(),
    renameTank: vi.fn(),
    addFish: vi.fn(),
    netFish: vi.fn(),
    care: vi.fn(),
    reportAte: vi.fn(),
  };
  const rec = recordBus();
  const session = new TankSession({
    api: api as unknown as ApiClient,
    interaction: rec.bus,
    sleep: async () => undefined,
    now: () => Date.parse('2026-02-01T12:00:00.000Z'),
  });
  return { api, rec, session };
}

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
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A }]);
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
    expect(await session.buy('neon-tetra', 'Dot')).toBe(true);
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
    await session.buy('neon-tetra', 'Dot');
    session.releaseNow(FISH_2);
    session.releaseNow(FISH_2);
    await vi.advanceTimersByTimeAsync(ACCLIMATION_SECONDS * 1000);
    expect(rec.of('tank:fish-released')).toHaveLength(1);
  });

  it('shows the capacity refusal from the server and adds nothing', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.addFish.mockRejectedValue(apiError(409, 'conflict'));
    expect(await session.buy('neon-tetra', 'Dot')).toBe(false);
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

describe('tank switcher and naming', () => {
  const second = tankFixture({ id: TANK_B, name: 'Reef', biome: 'reef', fish: [] });

  it('switches: unloads the old tank, loads the new one and refreshes it from the server', async () => {
    const { api, rec, session } = setup([tankFixture(), second]);
    await session.setUser(verified);
    api.tank.mockResolvedValue({ ...second, lastTickAt: '2026-02-01T12:00:00.000Z' });
    await session.select(TANK_B);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A }]);
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

  it('creates a tank and makes it the active one', async () => {
    const { api, rec, session } = setup();
    await session.setUser(verified);
    api.createTank.mockResolvedValue(second);
    expect(await session.createTank('Reef', 'reef')).toBe(true);
    expect(session.getState().activeId).toBe(TANK_B);
    expect(session.getState().tanks).toHaveLength(2);
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A }]);
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
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A }]);
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
    expect(rec.of('tank:unloaded')).toEqual([{ tankId: TANK_A }]);
    const calls = api.reportAte.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(api.reportAte.mock.calls.length).toBe(calls);
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
