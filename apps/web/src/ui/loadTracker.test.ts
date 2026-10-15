import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import {
  STICKY_INTERACTION_EVENTS,
  type InteractionEvents,
  type LoadState,
} from '../interaction/events';
import { parseStallMs, watchAssets, watchSwitches, type ProgressSource } from './loadSignals';
import { LoadTracker } from './loadTracker';

function setup(stallMs?: number) {
  const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
  const states: LoadState[] = [];
  bus.on('load:state', (state) => states.push(state));
  const tracker = new LoadTracker(bus, stallMs === undefined ? {} : { stallMs });
  return { bus, tracker, states };
}

describe('LoadTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts idle and publishes a sticky state', () => {
    const { bus } = setup();
    expect(bus.peek('load:state')).toMatchObject({ active: false, progress: 0, error: null });
  });

  it('adds up the boot milestones in order and names the pending stage', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    expect(tracker.current).toMatchObject({
      active: true,
      progress: 0,
      stage: 'Loading the aquarium',
    });
    tracker.reach('code');
    expect(tracker.current.progress).toBeCloseTo(0.08);
    expect(tracker.current.stage).toBe('Starting the renderer');
    tracker.reach('renderer');
    tracker.reach('scene');
    expect(tracker.current.progress).toBeCloseTo(0.45);
    expect(tracker.current.stage).toBe('Loading fish');
    tracker.reach('fish');
    expect(tracker.current.stage).toBe('Preparing water');
    tracker.reach('warmup');
    expect(tracker.current.progress).toBeCloseTo(0.99);
    expect(tracker.current.active).toBe(true);
  });

  it('only reaches 1 on finish', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    for (const m of ['code', 'renderer', 'scene', 'fish', 'warmup'] as const) tracker.reach(m);
    expect(tracker.current.progress).toBeLessThan(1);
    tracker.finish();
    expect(tracker.current).toMatchObject({ active: false, progress: 1 });
  });

  it('counts a switch from the scene stage and treats code and renderer as done', () => {
    const { tracker } = setup();
    tracker.begin('switch');
    expect(tracker.current.stage).toBe('Building the tank');
    tracker.reach('scene');
    expect(tracker.current.progress).toBeCloseTo(0.35);
  });

  it('counts skipped milestones as done', () => {
    const { tracker } = setup();
    tracker.begin('switch', ['scene']);
    expect(tracker.current.progress).toBeCloseTo(0.35);
    expect(tracker.current.stage).toBe('Loading fish');
  });

  it('fills pending asset weight from the asset share, never past a milestone', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    tracker.reach('code');
    tracker.reach('renderer');
    tracker.assets(0.5);
    const half = tracker.current.progress;
    expect(half).toBeGreaterThan(0.15);
    tracker.assets(1);
    expect(tracker.current.progress).toBeGreaterThan(half);
    expect(tracker.current.progress).toBeLessThan(0.15 + 0.6);
  });

  it('never moves backwards', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    tracker.assets(0.8);
    const before = tracker.current.progress;
    tracker.assets(0.2);
    expect(tracker.current.progress).toBe(before);
  });

  it('ignores signals while idle', () => {
    const { tracker, states } = setup();
    const published = states.length;
    tracker.reach('scene');
    tracker.assets(1);
    tracker.finish();
    expect(states).toHaveLength(published);
  });

  it('keeps a failure until the next begin', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    tracker.fail('boom');
    expect(tracker.current).toMatchObject({ active: true, error: 'boom' });
    tracker.reach('scene');
    tracker.finish();
    expect(tracker.current.error).toBe('boom');
    tracker.begin('switch');
    expect(tracker.current.error).toBeNull();
  });

  it('turns a load that goes quiet into an error', () => {
    const { tracker } = setup(1000);
    tracker.begin('boot');
    vi.advanceTimersByTime(999);
    expect(tracker.current.error).toBeNull();
    vi.advanceTimersByTime(2);
    expect(tracker.current.error).toMatch(/taking longer than expected/);
  });

  it('restarts the stall timer on each real signal', () => {
    const { tracker } = setup(1000);
    tracker.begin('boot');
    vi.advanceTimersByTime(800);
    tracker.reach('code');
    vi.advanceTimersByTime(800);
    expect(tracker.current.error).toBeNull();
    vi.advanceTimersByTime(300);
    expect(tracker.current.error).not.toBeNull();
  });

  it('stops the stall timer once finished', () => {
    const { tracker } = setup(1000);
    tracker.begin('switch');
    tracker.finish();
    vi.advanceTimersByTime(5000);
    expect(tracker.current.error).toBeNull();
  });
});

describe('watchAssets', () => {
  it('reports the share finished since the last rebase', () => {
    const { tracker } = setup();
    const source: ProgressSource = {};
    const watch = watchAssets(source, tracker);
    tracker.begin('boot');
    tracker.reach('code');
    tracker.reach('renderer');
    source.onStart?.('a.glb', 0, 2);
    source.onProgress?.('a.glb', 1, 2);
    const first = tracker.current.progress;
    expect(first).toBeGreaterThan(0.15);
    source.onProgress?.('b.glb', 2, 2);
    expect(tracker.current.progress).toBeGreaterThan(first);

    watch.rebase();
    tracker.begin('switch');
    source.onStart?.('c.glb', 2, 3);
    expect(tracker.current.progress).toBe(0);
    source.onProgress?.('c.glb', 3, 3);
    expect(tracker.current.progress).toBeGreaterThan(0);
  });

  it('puts the previous callbacks back on stop', () => {
    const { tracker } = setup();
    const previous = vi.fn();
    const source: ProgressSource = { onProgress: previous };
    watchAssets(source, tracker).stop();
    expect(source.onProgress).toBe(previous);
  });
});

describe('watchSwitches', () => {
  function rig() {
    const { bus, tracker, states } = setup();
    const gates = { scene: Promise.resolve(), fish: Promise.resolve(), frames: Promise.resolve() };
    const stop = watchSwitches({
      interaction: bus,
      tracker,
      assets: { rebase: vi.fn(), stop: vi.fn() },
      sceneSettled: () => gates.scene,
      fishSynced: () => gates.fish,
      frames: () => gates.frames,
    });
    return { bus, tracker, states, gates, stop };
  }

  const loaded = { biome: 'reef' } as InteractionEvents['tank:loaded'];

  it('runs a switch to completion on tank:loaded', async () => {
    const { bus, tracker } = rig();
    bus.emit('tank:loaded', loaded);
    expect(tracker.current).toMatchObject({ active: true, reason: 'switch' });
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
    expect(tracker.current.progress).toBe(1);
  });

  it('waits for the fish and the frames before it finishes', async () => {
    const { bus, tracker, gates } = rig();
    let release: () => void = () => undefined;
    gates.frames = new Promise<void>((resolve) => (release = resolve));
    bus.emit('tank:loaded', loaded);
    await vi.waitFor(() => expect(tracker.current.stage).toBe('Preparing water'));
    expect(tracker.current.active).toBe(true);
    release();
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
  });

  it('fails the load when the scene settles with an error', async () => {
    const { bus, tracker, gates } = rig();
    gates.scene = Promise.reject(new Error('preset broke'));
    bus.emit('demo:biome-changed', { biome: 'reef' });
    await vi.waitFor(() => expect(tracker.current.error).toBe('preset broke'));
  });

  it('leaves the first load alone', () => {
    const { bus, tracker } = rig();
    tracker.begin('boot');
    bus.emit('tank:none', {});
    expect(tracker.current.reason).toBe('boot');
  });

  it('lets a newer switch supersede an older one', async () => {
    const { bus, tracker, gates } = rig();
    let releaseOld: () => void = () => undefined;
    gates.fish = new Promise<void>((resolve) => (releaseOld = resolve));
    bus.emit('tank:loaded', loaded);
    await vi.waitFor(() => expect(tracker.current.stage).toBe('Loading fish'));
    gates.fish = Promise.resolve();
    bus.emit('tank:loaded', loaded);
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
    const done = tracker.current;
    releaseOld();
    await Promise.resolve();
    expect(tracker.current).toBe(done);
  });

  it('stops listening when disposed', () => {
    const { bus, tracker, stop } = rig();
    stop();
    bus.emit('tank:loaded', loaded);
    expect(tracker.current.active).toBe(false);
  });
});

describe('parseStallMs', () => {
  it('reads the override only in e2e mode', () => {
    expect(parseStallMs('?e2e&loadStallMs=3000')).toBe(3000);
    expect(parseStallMs('?loadStallMs=3000')).toBeUndefined();
    expect(parseStallMs('?e2e')).toBeUndefined();
  });

  it('rejects values that are not a whole number of at least 100', () => {
    expect(() => parseStallMs('?e2e&loadStallMs=abc')).toThrow(/loadStallMs/);
    expect(() => parseStallMs('?e2e&loadStallMs=5')).toThrow(/loadStallMs/);
  });
});
