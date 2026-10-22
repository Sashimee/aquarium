import type { CommunityEvent, CommunityQuota, CommunityState, Tank } from '@aquarium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTankToScene,
  CommunityController,
  eventText,
  feedProblem,
  quotaText,
  secondsLeft,
  waitText,
  type CommunityControllerDeps,
} from './community';
import { ApiRequestError } from '../ui/api';
import type { OpenStreamOptions } from './communityStream';
import { apiError, FISH_1, FISH_2, fishFixture, recordBus, tankFixture } from './fixtures';

const T0 = Date.parse('2026-02-01T12:00:00.000Z');

const quota = (overrides: Partial<CommunityQuota> = {}): CommunityQuota => ({
  limit: 2,
  used: 0,
  remaining: 2,
  windowMs: 86_400_000,
  resetsAt: null,
  ...overrides,
});

function stateOf(overrides: Partial<CommunityState> = {}): CommunityState {
  return {
    tank: tankFixture({ name: 'Community Tank' }),
    viewers: 3,
    tankFeedRemaining: 3,
    at: new Date(T0).toISOString(),
    quota: quota(),
    ...overrides,
  };
}

function streamStateFrame(state: CommunityState) {
  return { event: 'state', data: JSON.stringify({ ...state, quota: undefined }) };
}

class FakeStreams {
  readonly opened: {
    options: OpenStreamOptions;
    end(): void;
    fail(error: unknown): void;
  }[] = [];

  readonly open = (options: OpenStreamOptions): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const connection = { options, end: resolve, fail: reject };
      options.signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
      this.opened.push(connection);
    });

  get last() {
    const last = this.opened.at(-1);
    if (!last) throw new Error('no stream opened');
    return last;
  }
}

function setup(
  overrides: Partial<CommunityControllerDeps> = {},
  api: Partial<CommunityControllerDeps['api']> = {},
) {
  const streams = new FakeStreams();
  const drops: [string, number][] = [];
  const fullApi = {
    community: vi.fn(() => Promise.resolve(stateOf())),
    communityFeed: vi.fn(() => Promise.resolve({ state: stateOf(), replayed: false })),
    communityAte: vi.fn(() => Promise.resolve(stateOf())),
    myHandle: vi.fn(() => Promise.resolve<string | null>('mossy')),
    ...api,
  };
  const controller = new CommunityController({
    api: fullApi,
    openStream: streams.open,
    onDrop: (food, portion) => drops.push([food, portion]),
    now: () => Date.now(),
    random: () => 0.5,
    ...overrides,
  });
  return { controller, streams, drops, api: fullApi };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stream lifecycle', () => {
  it('goes live on the first state frame and shows viewers and tank allowance', async () => {
    const { controller, streams } = setup();
    controller.start();
    await settle();
    expect(controller.getState().connection).toBe('connecting');
    streams.last.options.onFrame(streamStateFrame(stateOf({ viewers: 7, tankFeedRemaining: 1.5 })));
    const state = controller.getState();
    expect(state.connection).toBe('live');
    expect(state.viewers).toBe(7);
    expect(state.tankFeedRemaining).toBe(1.5);
    expect(state.tank?.name).toBe('Community Tank');
    controller.dispose();
  });

  it('updates viewers from heartbeat frames and ignores malformed ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { controller, streams } = setup();
    controller.start();
    await settle();
    const { options } = streams.last;
    options.onFrame({ event: 'viewers', data: '{"viewers":12}' });
    expect(controller.getState().viewers).toBe(12);
    options.onFrame({ event: 'viewers', data: '{"viewers":-4}' });
    options.onFrame({ event: 'state', data: 'not json' });
    expect(controller.getState().viewers).toBe(12);
    expect(warn).toHaveBeenCalledTimes(2);
    controller.dispose();
    warn.mockRestore();
  });

  it('reconnects with growing backoff after the stream drops, and resets after a good connection', async () => {
    const { controller, streams } = setup();
    controller.start();
    await settle();
    streams.last.end();
    await settle();
    expect(controller.getState().connection).toBe('reconnecting');
    expect(controller.getState().reconnectAt).toBe(Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(streams.opened).toHaveLength(2);
    expect(controller.getState().connection).toBe('connecting');

    streams.last.fail(apiError(0, 'network'));
    await settle();
    expect(controller.getState().reconnectAt).toBe(Date.now() + 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(streams.opened).toHaveLength(3);

    streams.last.options.onFrame(streamStateFrame(stateOf()));
    streams.last.end();
    await settle();
    expect(controller.getState().reconnectAt).toBe(Date.now() + 1_000);
    controller.dispose();
  });

  it('waits at least the Retry-After of a refusal', async () => {
    const { controller, streams } = setup();
    controller.start();
    await settle();
    streams.last.fail(apiError(429, 'rate_limited', 10));
    await settle();
    expect(controller.getState().reconnectAt).toBe(Date.now() + 10_000);
    expect(controller.getState().streamProblem).toContain('rate_limited');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(streams.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams.opened).toHaveLength(2);
    controller.dispose();
  });

  it('restarts a stream that stays silent for twice the heartbeat', async () => {
    const { controller, streams } = setup({ heartbeatMs: 15_000 });
    controller.start();
    await settle();
    streams.last.options.onFrame(streamStateFrame(stateOf()));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(controller.getState().connection).toBe('live');
    streams.last.options.onFrame({ event: 'viewers', data: '{"viewers":1}' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(controller.getState().connection).toBe('live');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(controller.getState().connection).toBe('reconnecting');
    expect(controller.getState().streamProblem).toMatch(/quiet/);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(streams.opened).toHaveLength(2);
    controller.dispose();
  });

  it('closes the stream, stops retrying and drops listeners on dispose', async () => {
    const { controller, streams } = setup();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.start();
    await settle();
    const { signal } = streams.last.options;
    controller.dispose();
    await settle();
    expect(signal.aborted).toBe(true);
    listener.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(streams.opened).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not retry after dispose while waiting out a backoff', async () => {
    const { controller, streams } = setup();
    controller.start();
    await settle();
    streams.last.end();
    await settle();
    controller.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streams.opened).toHaveLength(1);
  });
});

describe('live feed and scene', () => {
  const feedEvent = (by: string | null, portion = 0.5): CommunityEvent => ({
    type: 'feed',
    at: new Date(T0).toISOString(),
    food: 'flakes',
    portion,
    by,
  });

  it('lists feed, death and birth lines newest first without free text from outside', async () => {
    const { controller, streams } = setup();
    controller.start();
    await settle();
    const { options } = streams.last;
    options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('misty')) });
    options.onFrame({
      event: 'death',
      data: JSON.stringify({
        type: 'death',
        at: new Date(T0).toISOString(),
        fishId: FISH_1,
        name: 'Neon 2',
        species: 'neon-tetra',
        cause: 'ammonia',
      }),
    });
    options.onFrame({
      event: 'born',
      data: JSON.stringify({
        type: 'born',
        at: new Date(T0).toISOString(),
        fishId: FISH_2,
        parentId: FISH_1,
        name: 'Neon 9',
        species: 'neon-tetra',
      }),
    });
    const texts = controller.getState().lines.map((l) => l.text);
    expect(texts).toEqual([
      'Neon 9, a young neon tetra, was born.',
      'Neon 2 the neon tetra was poisoned by ammonia.',
      'misty fed flakes.',
    ]);
    controller.dispose();
  });

  it('names an anonymous feeder as someone and caps the list', async () => {
    expect(eventText(feedEvent(null))).toBe('Someone fed flakes.');
    const { controller, streams } = setup();
    controller.start();
    await settle();
    for (let i = 0; i < 20; i++) {
      streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('misty')) });
    }
    expect(controller.getState().lines).toHaveLength(12);
    controller.dispose();
  });

  it('rejects an event whose type does not match its frame name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { controller, streams } = setup();
    controller.start();
    await settle();
    streams.last.options.onFrame({ event: 'death', data: JSON.stringify(feedEvent('misty')) });
    expect(controller.getState().lines).toHaveLength(0);
    controller.dispose();
    warn.mockRestore();
  });

  it('drops other people food into the scene but not the echo of the own feed', async () => {
    const { controller, streams, drops } = setup();
    controller.start();
    await settle();
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('misty', 0.25)) });
    expect(drops).toEqual([['flakes', 0.25]]);

    await controller.feed('flakes', 0.5);
    expect(drops).toEqual([
      ['flakes', 0.25],
      ['flakes', 0.5],
    ]);
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('mossy', 0.5)) });
    expect(drops).toHaveLength(2);
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('mossy', 0.5)) });
    expect(drops).toHaveLength(3);
    controller.dispose();
  });

  it('drops an own feed once when the stream frame arrives before the reply', async () => {
    let reply: (v: { state: CommunityState; replayed: boolean }) => void = () => undefined;
    const communityFeed = vi.fn(
      () => new Promise<{ state: CommunityState; replayed: boolean }>((r) => (reply = r)),
    );
    const { controller, streams, drops } = setup({}, { communityFeed });
    controller.start();
    await settle();
    const pending = controller.feed('flakes', 0.5);
    await settle();
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('mossy', 0.5)) });
    expect(drops).toEqual([['flakes', 0.5]]);
    reply({ state: stateOf(), replayed: false });
    await pending;
    expect(drops).toHaveLength(1);
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('misty', 0.5)) });
    expect(drops).toHaveLength(2);
    controller.dispose();
  });

  it('leaves no echo behind for a replayed or refused feed', async () => {
    const communityFeed = vi
      .fn()
      .mockResolvedValueOnce({ state: stateOf(), replayed: true })
      .mockRejectedValueOnce(apiError(422, 'feeding_rejected'));
    const { controller, streams, drops } = setup({}, { communityFeed });
    controller.start();
    await settle();
    await controller.feed('flakes', 0.5);
    await controller.feed('flakes', 0.5);
    expect(drops).toHaveLength(0);
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('misty', 0.5)) });
    expect(drops).toEqual([['flakes', 0.5]]);
    controller.dispose();
  });

  it('ignores the reply of an ate report that lands after dispose', async () => {
    let reply: (v: CommunityState) => void = () => undefined;
    const communityAte = vi.fn(() => new Promise<CommunityState>((r) => (reply = r)));
    const onTank = vi.fn();
    const { controller } = setup({ onTank, ateOptions: { intervalMs: 1_000 } }, { communityAte });
    controller.start();
    await settle();
    controller.reportAte([{ fishId: FISH_1, portion: 0.1 }]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(communityAte).toHaveBeenCalled();
    controller.dispose();
    onTank.mockClear();
    reply(stateOf({ tank: tankFixture({ lastTickAt: '2026-02-02T00:00:00.000Z' }) }));
    await settle();
    expect(onTank).not.toHaveBeenCalled();
  });

  it('does not mistake another player with the same food and portion for the own echo', async () => {
    let reply: (v: { state: CommunityState; replayed: boolean }) => void = () => undefined;
    const communityFeed = vi.fn(
      () => new Promise<{ state: CommunityState; replayed: boolean }>((r) => (reply = r)),
    );
    const { controller, streams, drops } = setup(
      {},
      { communityFeed, myHandle: vi.fn(() => Promise.resolve('mossy')) },
    );
    controller.start();
    await settle();
    const pending = controller.feed('flakes', 0.5);
    await settle();
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('misty', 0.5)) });
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('mossy', 0.5)) });
    expect(drops).toHaveLength(2);
    reply({ state: stateOf(), replayed: false });
    await pending;
    expect(drops).toHaveLength(2);
    controller.dispose();
  });

  it('drops once when the handle cannot be loaded, matching on food and portion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let reply: (v: { state: CommunityState; replayed: boolean }) => void = () => undefined;
    const communityFeed = vi.fn(
      () => new Promise<{ state: CommunityState; replayed: boolean }>((r) => (reply = r)),
    );
    const { controller, streams, drops } = setup(
      {},
      { communityFeed, myHandle: vi.fn(() => Promise.reject(new Error('offline'))) },
    );
    controller.start();
    await settle();
    const pending = controller.feed('flakes', 0.5);
    await settle();
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('mossy', 0.5)) });
    reply({ state: stateOf(), replayed: false });
    await pending;
    expect(drops).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    controller.dispose();
  });

  describe('own feeds before the handle is known', () => {
    type Reply = { state: CommunityState; replayed: boolean };
    function pendingFeed(myHandle: () => Promise<string | null>) {
      let reply: (v: Reply) => void = () => undefined;
      const communityFeed = vi.fn(() => new Promise<Reply>((r) => (reply = r)));
      const made = setup({}, { communityFeed, myHandle });
      const frame = (by: string) =>
        made.streams.last.options.onFrame({
          event: 'feed',
          data: JSON.stringify(feedEvent(by, 0.5)),
        });
      return { ...made, frame, answer: () => reply({ state: stateOf(), replayed: false }) };
    }
    const never = () => new Promise<string | null>(() => undefined);

    it('drops once when the own frame comes before the reply', async () => {
      const { controller, drops, frame, answer } = pendingFeed(never);
      controller.start();
      await settle();
      const pending = controller.feed('flakes', 0.5);
      await settle();
      frame('mossy');
      answer();
      await pending;
      expect(drops).toHaveLength(1);
      controller.dispose();
    });

    it('drops once when the reply comes before the own frame', async () => {
      const { controller, drops, frame, answer } = pendingFeed(never);
      controller.start();
      await settle();
      const pending = controller.feed('flakes', 0.5);
      await settle();
      answer();
      await pending;
      frame('mossy');
      expect(drops).toHaveLength(1);
      controller.dispose();
    });

    it('uses the handle once it arrives mid-flight, so a foreign frame still drops', async () => {
      let resolveHandle: (h: string | null) => void = () => undefined;
      const { controller, drops, frame, answer } = pendingFeed(
        () => new Promise<string | null>((r) => (resolveHandle = r)),
      );
      controller.start();
      await settle();
      const pending = controller.feed('flakes', 0.5);
      await settle();
      resolveHandle('mossy');
      await settle();
      frame('misty');
      expect(drops).toHaveLength(1);
      frame('mossy');
      expect(drops).toHaveLength(2);
      answer();
      await pending;
      expect(drops).toHaveLength(2);
      controller.dispose();
    });

    it('matches on food and portion after a 401, so a later own feed drops once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const myHandle = vi.fn(() =>
        Promise.reject(new ApiRequestError(401, 'unauthenticated', 'Sign in.')),
      );
      const { controller, drops, frame, answer } = pendingFeed(myHandle);
      controller.start();
      await settle();
      expect(myHandle).toHaveBeenCalledTimes(1);
      const pending = controller.feed('flakes', 0.5);
      await settle();
      frame('mossy');
      answer();
      await pending;
      expect(drops).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      controller.dispose();
    });
  });

  it('does not hold the first feed for a slow handle request', async () => {
    const communityFeed = vi.fn(() => Promise.resolve({ state: stateOf(), replayed: false }));
    const myHandle = vi.fn(() => new Promise<string | null>(() => undefined));
    const { controller } = setup({}, { communityFeed, myHandle });
    controller.start();
    await settle();
    await controller.feed('flakes', 0.5);
    expect(communityFeed).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('keeps the pending feed matchable for as long as the request may run', async () => {
    let reply: (v: { state: CommunityState; replayed: boolean }) => void = () => undefined;
    const communityFeed = vi.fn(
      () => new Promise<{ state: CommunityState; replayed: boolean }>((r) => (reply = r)),
    );
    const { controller, streams, drops } = setup({}, { communityFeed });
    controller.start();
    await settle();
    const pending = controller.feed('flakes', 0.5);
    await vi.advanceTimersByTimeAsync(59_000);
    streams.last.options.onFrame({ event: 'feed', data: JSON.stringify(feedEvent('mossy', 0.5)) });
    reply({ state: stateOf(), replayed: false });
    await pending;
    expect(drops).toHaveLength(1);
    controller.dispose();
  });

  it('refuses an older snapshot than the one held', async () => {
    const onTank = vi.fn();
    const { controller, streams } = setup({ onTank });
    controller.start();
    await settle();
    const newer = stateOf({ tank: tankFixture({ lastTickAt: '2026-02-01T00:10:00.000Z' }) });
    const older = stateOf({
      tank: tankFixture({ lastTickAt: '2026-02-01T00:05:00.000Z' }),
      viewers: 99,
    });
    onTank.mockClear();
    streams.last.options.onFrame(streamStateFrame(newer));
    streams.last.options.onFrame(streamStateFrame(older));
    expect(onTank).toHaveBeenCalledTimes(1);
    expect(controller.getState().viewers).toBe(newer.viewers);
    controller.dispose();
  });
});

describe('applyTankToScene', () => {
  it('loads the first snapshot whole and later ones as a diff', () => {
    const { bus, of } = recordBus();
    const first = tankFixture({ fish: [fishFixture(FISH_1), fishFixture(FISH_2)] });
    applyTankToScene(bus, null, first);
    expect(of('tank:loaded')).toHaveLength(1);

    const next: Tank = {
      ...first,
      lastTickAt: '2026-02-01T01:00:00.000Z',
      fish: [fishFixture(FISH_1, { status: 'dead' })],
    };
    applyTankToScene(bus, first, next);
    expect(of('tank:loaded')).toHaveLength(1);
    expect(of('tank:fish-died')).toHaveLength(1);
    expect(of('tank:fish-removed')).toEqual([{ tankId: first.id, fishId: FISH_2, reason: 'gone' }]);
  });

  it('announces the lamp again when a later snapshot changes it', () => {
    const { bus, of } = recordBus();
    const first = tankFixture();
    applyTankToScene(bus, null, first);
    expect(of('tank:lamp')).toHaveLength(1);
    const light = first.equipment.light;
    const dimmer: Tank = {
      ...first,
      equipment: { ...first.equipment, light: { ...light, intensity: light.intensity / 2 } },
    };
    applyTankToScene(bus, first, dimmer);
    expect(of('tank:lamp')).toHaveLength(2);
    expect(of('tank:lamp')[1]).toMatchObject({ intensity: light.intensity / 2 });
    const later: Tank = {
      ...dimmer,
      equipment: {
        ...dimmer.equipment,
        light: { ...dimmer.equipment.light, offHour: (light.offHour + 1) % 24 },
      },
    };
    applyTankToScene(bus, dimmer, later);
    expect(of('tank:lamp')).toHaveLength(3);
    expect(of('tank:lamp')[2]).toMatchObject({
      tankId: first.id,
      intensity: light.intensity / 2,
      onHour: light.onHour,
      offHour: (light.offHour + 1) % 24,
    });
  });

  it('announces the lamp when only the on-hour changes', () => {
    const { bus, of } = recordBus();
    const first = tankFixture();
    applyTankToScene(bus, null, first);
    const light = first.equipment.light;
    const onHour = (light.onHour + 1) % 24;
    const next: Tank = {
      ...first,
      equipment: { ...first.equipment, light: { ...light, onHour } },
    };
    applyTankToScene(bus, first, next);
    expect(of('tank:lamp')).toHaveLength(2);
    expect(of('tank:lamp')[1]).toMatchObject({
      tankId: first.id,
      intensity: light.intensity,
      onHour,
      offHour: light.offHour,
    });
  });

  it('does not announce the lamp when the snapshot leaves it unchanged', () => {
    const { bus, of } = recordBus();
    const first = tankFixture();
    applyTankToScene(bus, null, first);
    applyTankToScene(bus, first, { ...first, lastTickAt: '2026-02-01T01:00:00.000Z' });
    expect(of('tank:lamp')).toHaveLength(1);
  });
});

describe('quota', () => {
  it('loads the allowance on start and keeps it across stream state frames', async () => {
    const { controller, streams } = setup();
    controller.start();
    await settle();
    expect(controller.getState().quota?.remaining).toBe(2);
    streams.last.options.onFrame(streamStateFrame(stateOf({ quota: null })));
    expect(controller.getState().quota?.remaining).toBe(2);
    controller.dispose();
  });

  it('shows no allowance for a viewer who cannot feed', async () => {
    const { controller } = setup(
      {},
      { community: vi.fn(() => Promise.resolve(stateOf({ quota: null }))) },
    );
    controller.start();
    await settle();
    expect(controller.getState().quota).toBeNull();
    expect(quotaText(null, 2).mine).toBeNull();
    controller.dispose();
  });

  it('formats the allowances', () => {
    expect(quotaText(quota({ remaining: 1.25 }), 0)).toEqual({
      mine: 'You can still feed 1.25 of 2 portions.',
      tank: 'The fish are full for now.',
    });
    expect(quotaText(quota(), 2.5).tank).toBe('The tank still takes 2.5 portions.');
    expect(quotaText(null, null).tank).toBeNull();
  });

  it('asks again once the oldest feed leaves the window', async () => {
    const resetsAt = new Date(T0 + 60_000).toISOString();
    const community = vi
      .fn()
      .mockResolvedValueOnce(stateOf({ quota: quota({ used: 2, remaining: 0, resetsAt }) }))
      .mockResolvedValue(stateOf());
    const { controller } = setup({}, { community });
    controller.start();
    await settle();
    expect(controller.getState().quota?.remaining).toBe(0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(community).toHaveBeenCalledTimes(2);
    expect(controller.getState().quota?.remaining).toBe(2);
    controller.dispose();
  });

  it('formats waits', () => {
    expect(waitText(1)).toBe('1 second');
    expect(waitText(45)).toBe('45 seconds');
    expect(waitText(600)).toBe('10 minutes');
    expect(waitText(3 * 3600)).toBe('3 hours');
    expect(secondsLeft(null, 0)).toBe(0);
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(9_000, 10_000)).toBe(0);
  });
});

describe('feeding', () => {
  it('posts the food, takes the new quota and drops the food into the scene', async () => {
    const after = stateOf({ quota: quota({ used: 0.5, remaining: 1.5 }), tankFeedRemaining: 2.5 });
    const { controller, drops, api } = setup(
      {},
      { communityFeed: vi.fn(() => Promise.resolve({ state: after, replayed: false })) },
    );
    controller.start();
    await settle();
    await controller.feed('pellets', 0.5);
    expect(api.communityFeed).toHaveBeenCalledWith({
      food: 'pellets',
      portion: 0.5,
      idempotencyKey: expect.stringMatching(/.{8,}/),
    });
    expect(controller.getState().quota?.remaining).toBe(1.5);
    expect(controller.getState().tankFeedRemaining).toBe(2.5);
    expect(controller.getState().feeding).toBe(false);
    expect(controller.getState().problem).toBeNull();
    expect(drops).toEqual([['pellets', 0.5]]);
    controller.dispose();
  });

  it('retries a lost response with the same idempotency key, and a new feed with a new one', async () => {
    const communityFeed = vi
      .fn()
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValue({ state: stateOf(), replayed: true });
    const { controller, drops } = setup({}, { communityFeed });
    controller.start();
    await settle();

    await controller.feed('flakes', 0.5);
    expect(controller.getState().problem?.text).toMatch(/will not be doubled/);
    expect(drops).toHaveLength(0);

    await controller.feed('flakes', 0.5);
    const [first, second] = communityFeed.mock.calls.map(([r]) => r.idempotencyKey);
    expect(second).toBe(first);
    expect(controller.getState().notice).toBe('That feeding had already gone through.');
    expect(drops).toHaveLength(0);

    await controller.feed('flakes', 0.5);
    expect(communityFeed.mock.calls[2]?.[0].idempotencyKey).not.toBe(first);
    controller.dispose();
  });

  it('keeps the key through a rate limit and reuses it after the countdown', async () => {
    const communityFeed = vi
      .fn()
      .mockRejectedValueOnce(apiError(429, 'rate_limited', 20))
      .mockResolvedValue({ state: stateOf(), replayed: false });
    const { controller } = setup({}, { communityFeed });
    controller.start();
    await settle();
    await controller.feed('flakes', 0.5);
    expect(controller.getState().problem?.retryAt).toBe(Date.now() + 20_000);

    await controller.feed('flakes', 0.5);
    expect(communityFeed).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await controller.feed('flakes', 0.5);
    expect(communityFeed).toHaveBeenCalledTimes(2);
    expect(communityFeed.mock.calls[1]?.[0].idempotencyKey).toBe(
      communityFeed.mock.calls[0]?.[0].idempotencyKey,
    );
    controller.dispose();
  });

  it('drops the key after a definite refusal so the next press is a new intent', async () => {
    const communityFeed = vi
      .fn()
      .mockRejectedValueOnce(apiError(422, 'feeding_rejected'))
      .mockResolvedValue({ state: stateOf(), replayed: false });
    const { controller, drops } = setup({}, { communityFeed });
    controller.start();
    await settle();
    await controller.feed('flakes', 0.5);
    expect(drops).toHaveLength(0);
    await controller.feed('flakes', 0.5);
    expect(communityFeed.mock.calls[1]?.[0].idempotencyKey).not.toBe(
      communityFeed.mock.calls[0]?.[0].idempotencyKey,
    );
    controller.dispose();
  });

  it('ignores a second press while one is in flight', async () => {
    let release: (v: { state: CommunityState; replayed: boolean }) => void = () => undefined;
    const communityFeed = vi.fn(
      () => new Promise<{ state: CommunityState; replayed: boolean }>((r) => (release = r)),
    );
    const { controller } = setup({}, { communityFeed });
    controller.start();
    await settle();
    const first = controller.feed('flakes', 0.5);
    expect(controller.getState().feeding).toBe(true);
    await controller.feed('flakes', 0.5);
    release({ state: stateOf(), replayed: false });
    await first;
    expect(communityFeed).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe('feed error mapping', () => {
  const now = 1_000_000;
  const cases: [string, ReturnType<typeof apiError>, Partial<ReturnType<typeof feedProblem>>][] = [
    ['signed out', apiError(401, 'unauthenticated'), { needs: 'sign-in', retryAt: null }],
    ['unverified', apiError(403, 'email_not_verified'), { needs: 'verify', retryAt: null }],
    [
      'own quota',
      apiError(429, 'quota_exceeded', 3600),
      { text: 'quota_exceeded (429)', retryAt: now + 3_600_000, needs: null },
    ],
    [
      'rate limit',
      apiError(429, 'rate_limited', 12),
      { text: 'Feeding too often.', retryAt: now + 12_000 },
    ],
    ['reused key', apiError(409, 'conflict'), { retryAt: null }],
    ['rejected', apiError(422, 'feeding_rejected'), { retryAt: null }],
    ['network', apiError(0, 'network'), { retryAt: null }],
  ];
  it.each(cases)('%s', (_name, error, expected) => {
    expect(feedProblem(error, now)).toMatchObject(expected);
  });

  it('gives a generic message for an unexpected failure', () => {
    expect(feedProblem(new Error('boom'), now).text).toMatch(/not dropped/);
  });
});

describe('ate reports', () => {
  it('batches what the fish ate for a player who can feed', async () => {
    const communityAte = vi.fn(() => Promise.resolve(stateOf()));
    const { controller } = setup({ ateOptions: { intervalMs: 1_000 } }, { communityAte });
    controller.start();
    await settle();
    controller.reportAte([{ fishId: FISH_1, portion: 0.1 }]);
    controller.reportAte([{ fishId: FISH_1, portion: 0.2 }]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(communityAte).toHaveBeenCalledTimes(1);
    const reports = (communityAte.mock.calls[0] as unknown as [{ fishId: string }[]])[0];
    expect(reports).toHaveLength(1);
    controller.dispose();
  });

  it('sends nothing for a viewer who cannot feed', async () => {
    const communityAte = vi.fn(() => Promise.resolve(stateOf()));
    const { controller } = setup(
      { ateOptions: { intervalMs: 1_000 } },
      { community: vi.fn(() => Promise.resolve(stateOf({ quota: null }))), communityAte },
    );
    controller.start();
    await settle();
    controller.reportAte([{ fishId: FISH_1, portion: 0.1 }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(communityAte).not.toHaveBeenCalled();
    controller.dispose();
  });
});
