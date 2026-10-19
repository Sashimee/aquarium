import type { CareEvent, Tank } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { FISH_1, FISH_2, TANK_A, TANK_B, fishFixture, tankFixture } from './fixtures';
import { ReplayController, type ReplayControllerDeps } from './replayController';

const SINCE = '2026-10-18T10:00:00.000Z';
const NOW = Date.parse('2026-10-18T20:00:00.000Z');

function event(n: number, at: string, fishId = FISH_2): CareEvent {
  return {
    id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tankId: TANK_A,
    at,
    kind: 'death',
    payload: { fishId, cause: 'ammonia' },
  };
}

const e1 = event(1, '2026-10-18T11:00:00.000Z');
const e2 = event(2, '2026-10-18T12:00:00.000Z');
const dead = fishFixture(FISH_2, { status: 'dead', health: 0 });
const tank = tankFixture({ fish: [fishFixture(FISH_1), dead] });

function setup(overrides: Partial<ReplayControllerDeps> = {}, tankOverride: Tank = tank) {
  const replay = vi.fn().mockResolvedValue({ events: [e1, e2], nextCursor: null });
  const bus = new EventBus<InteractionEvents>();
  const seen: { type: string; payload: unknown }[] = [];
  for (const type of ['tank:loaded', 'tank:fish-died', 'replay:time-scale'] as const) {
    bus.on(type, (payload) => seen.push({ type, payload }));
  }
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const deps: ReplayControllerDeps = {
    api: { replay },
    interaction: bus,
    tank: tankOverride,
    since: SINCE,
    mode: 'simulate',
    reducedMotion: false,
    timers: {
      setInterval: (cb, ms) => {
        timers.set(next, { cb, ms });
        return next++;
      },
      clearInterval: (handle) => void timers.delete(handle as number),
    },
    online: () => true,
    now: () => NOW,
    ...overrides,
  };
  const controller = new ReplayController(deps);
  const fire = () => {
    for (const t of [...timers.values()]) t.cb();
  };
  return { controller, replay, seen, timers, fire, bus };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ReplayController loading', () => {
  it('fetches once with until fixed at the start and plays from the top', async () => {
    const { controller, replay, timers } = setup();
    await settle();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({
      since: SINCE,
      until: '2026-10-18T20:00:00.000Z',
    });
    expect(controller.getSnapshot().load.status).toBe('ready');
    expect(controller.getSnapshot().playback).toMatchObject({ shown: 0, playing: true });
    expect(timers.size).toBe(1);
  });

  it('does not refetch or restart when a new tank snapshot arrives mid-watch', async () => {
    const { controller, replay, fire } = setup();
    await settle();
    fire();
    expect(controller.getSnapshot().playback.shown).toBe(1);
    controller.setTank({ ...tank, fish: [...tank.fish] });
    await settle();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().playback.shown).toBe(1);
    expect(controller.getSnapshot().playback.playing).toBe(true);
  });

  it('shows the error, then loads on retry', async () => {
    const replay = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const { controller } = setup({ api: { replay } });
    await settle();
    expect(controller.getSnapshot().load).toMatchObject({ status: 'error' });
    replay.mockResolvedValue({ events: [e1], nextCursor: null });
    controller.retry();
    await settle();
    expect(controller.getSnapshot().load).toMatchObject({ status: 'ready' });
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it('does not call the api while offline and says so', async () => {
    const { controller, replay } = setup({ online: () => false });
    await settle();
    expect(replay).not.toHaveBeenCalled();
    const load = controller.getSnapshot().load;
    expect(load.status === 'error' && load.message).toContain('offline');
  });

  it('is ready with nothing to play for an empty timeline', async () => {
    const replay = vi.fn().mockResolvedValue({ events: [], nextCursor: null });
    const { controller, timers, seen } = setup({ api: { replay } });
    await settle();
    expect(controller.getSnapshot().load).toEqual({
      status: 'ready',
      events: [],
      truncated: false,
    });
    expect(timers.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it('follows the cursor across pages before playing', async () => {
    const replay = vi
      .fn()
      .mockResolvedValueOnce({ events: [e1], nextCursor: 'c1' })
      .mockResolvedValueOnce({ events: [e2], nextCursor: null });
    const { controller } = setup({ api: { replay } });
    await settle();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls[1]?.[1]).toMatchObject({ cursor: 'c1' });
    const load = controller.getSnapshot().load;
    expect(load.status === 'ready' && load.events).toEqual([e1, e2]);
  });
});

describe('ReplayController playback', () => {
  it('reveals events in order on the timer and restores the live tank when finished', async () => {
    const { controller, seen, fire, timers } = setup();
    await settle();
    fire();
    expect(controller.getSnapshot().playback.shown).toBe(1);
    fire();
    expect(controller.getSnapshot().playback).toMatchObject({ shown: 2, playing: false });
    expect(timers.size).toBe(0);
    const loaded = seen.filter((s) => s.type === 'tank:loaded');
    expect(loaded).toHaveLength(2);
    expect((loaded[1]?.payload as InteractionEvents['tank:loaded']).fish).toBe(tank.fish);
    expect(seen.at(-2)).toEqual({ type: 'replay:time-scale', payload: { scale: 1 } });
  });

  it('re-times the interval when the speed changes and clears it on pause', async () => {
    const { controller, timers } = setup();
    await settle();
    const before = [...timers.values()][0]?.ms;
    controller.setSpeed(4);
    expect(timers.size).toBe(1);
    expect([...timers.values()][0]?.ms).toBe((before ?? 0) / 2);
    controller.toggle();
    expect(timers.size).toBe(0);
  });

  it('skipping restores the live tank and stops the timer', async () => {
    const { controller, seen, timers, fire } = setup();
    await settle();
    fire();
    controller.dispose();
    expect(timers.size).toBe(0);
    const last = seen.filter((s) => s.type === 'tank:loaded').at(-1);
    expect((last?.payload as InteractionEvents['tank:loaded']).fish).toBe(tank.fish);
    expect(seen.at(-2)).toEqual({ type: 'replay:time-scale', payload: { scale: 1 } });
    const count = seen.length;
    controller.dispose();
    fire();
    expect(seen).toHaveLength(count);
  });

  it('does not put the old tank back when the session switched tanks before the unmount', async () => {
    const { controller, bus, seen, fire } = setup();
    await settle();
    fire();
    const other = tankFixture({ id: TANK_B, fish: [] });
    bus.emit('tank:loaded', {
      tankId: other.id,
      biome: other.biome,
      size: other.size,
      fish: other.fish,
      decorLayout: other.decorLayout,
      decorEdited: other.decorEdited,
      backgroundId: other.backgroundId,
    });
    const before = seen.length;
    controller.dispose();
    const after = seen.slice(before);
    expect(after.filter((s) => s.type === 'tank:loaded')).toEqual([]);
    expect(after.at(-1)).toEqual({ type: 'replay:time-scale', payload: { scale: 1 } });
  });

  it('rebuilds the roster once for a drag across several events, on release', async () => {
    const { controller, seen } = setup();
    await settle();
    const loads = () => seen.filter((m) => m.type === 'tank:loaded').length;
    controller.previewScrub(2);
    const before = loads();
    controller.previewScrub(1);
    controller.previewScrub(2);
    controller.previewScrub(0);
    expect(loads()).toBe(before);
    expect(controller.getSnapshot().playback).toMatchObject({ shown: 0, playing: false });
    controller.commitScrub();
    controller.commitScrub();
    expect(loads()).toBe(before + 1);
  });

  it('commits a pending drag when play is pressed, before the first tick', async () => {
    const { controller, seen, fire } = setup();
    await settle();
    controller.previewScrub(1);
    const before = seen.length;
    controller.toggle();
    const loads = seen.slice(before).filter((m) => m.type === 'tank:loaded');
    expect(loads).toHaveLength(1);
    const roster = (loads[0]?.payload as { fish: { id: string; status: string }[] }).fish;
    expect(roster.find((f) => f.id === FISH_2)?.status).toBe('dead');
    expect(controller.getSnapshot().playback).toMatchObject({ shown: 1, playing: true });
    fire();
    expect(controller.getSnapshot().playback.shown).toBe(2);
  });

  it('under reduced motion shows everything at once and never starts a timer', async () => {
    const { controller, timers, seen } = setup({ reducedMotion: true });
    await settle();
    expect(controller.getSnapshot().playback).toMatchObject({ shown: 2, playing: false });
    expect(timers.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it('drops a load that finishes after dispose', async () => {
    const { controller, seen, timers } = setup();
    controller.dispose();
    await settle();
    expect(controller.getSnapshot().load.status).toBe('loading');
    expect(timers.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it('notifies subscribers on every change until they unsubscribe', async () => {
    const { controller, fire } = setup();
    await settle();
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    fire();
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    fire();
    expect(listener).not.toHaveBeenCalled();
  });
});
