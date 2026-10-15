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
    expect(tracker.current.progress).toBeCloseTo(0.04);
    expect(tracker.current.stage).toBe('Starting the renderer');
    tracker.reach('renderer');
    tracker.reach('scene');
    expect(tracker.current.progress).toBeCloseTo(0.04 + 0.1 + 0.3);
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
    expect(tracker.current.progress).toBeCloseTo(0.3);
  });

  it('counts skipped milestones as done', () => {
    const { tracker } = setup();
    tracker.begin('switch', ['scene']);
    expect(tracker.current.progress).toBeCloseTo(0.3);
    expect(tracker.current.stage).toBe('Loading fish');
  });

  it('moves with the asset share and counts the assets as done once scene and fish are up', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    tracker.reach('code');
    tracker.reach('renderer');
    const base = tracker.current.progress;
    tracker.assets(0.5);
    expect(tracker.current.progress).toBeCloseTo(base + 0.1);
    tracker.reach('scene');
    tracker.reach('fish');
    expect(tracker.current.progress).toBeCloseTo(0.04 + 0.1 + 0.2 + 0.3 + 0.06);
  });

  it('keeps moving while the first frames are drawn', () => {
    const { tracker } = setup();
    tracker.begin('switch', ['scene', 'fish']);
    const before = tracker.current.progress;
    tracker.part('warmup', 0.5);
    expect(tracker.current.progress).toBeGreaterThan(before);
    expect(tracker.current.stage).toBe('Preparing water');
  });

  it('has no plateau above half before the scene is built', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    tracker.reach('code');
    tracker.reach('renderer');
    tracker.assets(1);
    expect(tracker.current.progress).toBeLessThan(0.5);
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

describe('LoadTracker failure and progress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears the failure when a stalled load finishes later', () => {
    const { tracker, states } = setup(1000);
    tracker.begin('boot');
    vi.advanceTimersByTime(1000);
    expect(tracker.current.error).toMatch(/taking longer/);
    tracker.finish();
    expect(tracker.current).toMatchObject({ active: false, progress: 1, error: null });
    expect(states.at(-1)).toBe(tracker.current);
  });

  it('dismisses a failure, stays inactive, and shows again on the next begin', () => {
    const { bus, tracker } = setup();
    tracker.begin('switch');
    tracker.fail('boom');
    bus.emit('load:dismiss', {});
    expect(tracker.current).toMatchObject({ active: false, error: null });
    tracker.finish();
    expect(tracker.current.progress).toBeLessThan(1);
    tracker.begin('switch');
    expect(tracker.current).toMatchObject({ active: true, error: null });
  });

  it('ignores a dismissal while loading without an error', () => {
    const { tracker } = setup();
    tracker.begin('boot');
    tracker.dismiss();
    expect(tracker.current.active).toBe(true);
  });

  it('stops listening for dismissals once disposed', () => {
    const { bus, tracker } = setup();
    tracker.begin('boot');
    tracker.fail('boom');
    tracker.dispose();
    bus.emit('load:dismiss', {});
    expect(tracker.current).toMatchObject({ active: true, error: 'boom' });
  });

  it('keeps the bar moving through later waves of asset requests', () => {
    const { tracker } = setup();
    const source: ProgressSource = {};
    watchAssets([source], tracker);
    tracker.begin('boot');
    tracker.reach('code');
    tracker.reach('renderer');
    const seen: number[] = [];
    const mark = (): number => tracker.current.progress;
    source.onStart?.('a', 0, 10);
    source.onProgress?.('a', 10, 10);
    seen.push(mark());
    source.onStart?.('lod1', 10, 20);
    source.onProgress?.('lod1', 15, 20);
    seen.push(mark());
    source.onProgress?.('lod1', 20, 20);
    seen.push(mark());
    source.onStart?.('lod2', 20, 40);
    source.onProgress?.('lod2', 40, 40);
    seen.push(mark());
    expect(seen.every((v, i) => i === 0 || v >= (seen[i - 1] ?? 0))).toBe(true);
    expect(seen[2]).toBeGreaterThan(seen[0] ?? 1);
    expect(seen[3]).toBeGreaterThan(seen[2] ?? 1);
    expect(seen.at(-1)).toBeLessThan(0.99);
  });
});

describe('watchAssets', () => {
  it('reports the share finished since the last rebase', () => {
    const { tracker } = setup();
    const source: ProgressSource = {};
    const watch = watchAssets([source], tracker);
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
    watchAssets([source], tracker).stop();
    expect(source.onProgress).toBe(previous);
  });
});

describe('watchSwitches', () => {
  function rig(attached = true) {
    const { bus, tracker, states } = setup();
    const gates = { scene: Promise.resolve(), fish: Promise.resolve(), frames: Promise.resolve() };
    const watch = watchSwitches(bus, tracker, 'freshwater');
    if (attached) {
      watch.attach({
        assets: { rebase: vi.fn(), stop: vi.fn() },
        sceneSettled: () => gates.scene,
        fishSynced: () => gates.fish,
        frames: () => gates.frames,
      });
    }
    return { bus, tracker, states, gates, watch };
  }

  const saved = (tankId: string): InteractionEvents['tank:loaded'] =>
    ({ tankId, biome: 'reef' }) as InteractionEvents['tank:loaded'];

  const finishedBoot = (tracker: LoadTracker): void => {
    tracker.begin('boot');
    tracker.finish();
  };

  it('runs a switch to completion when another saved tank loads', async () => {
    const { bus, tracker } = rig();
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current).toMatchObject({ active: true, reason: 'switch' });
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
    expect(tracker.current.progress).toBe(1);
  });

  it('starts nothing for a tank:none while the demo tank is shown', () => {
    const { bus, tracker, states } = rig();
    finishedBoot(tracker);
    const published = states.length;
    bus.emit('tank:none', {});
    bus.emit('tank:none', {});
    expect(tracker.current.active).toBe(false);
    expect(states).toHaveLength(published);
  });

  it('starts nothing when the tank on show loads again', async () => {
    const { bus, tracker } = rig();
    bus.emit('tank:loaded', saved('a'));
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
    const done = tracker.current;
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current).toBe(done);
  });

  it('starts nothing when the demo biome is picked again', () => {
    const { bus, tracker } = rig();
    finishedBoot(tracker);
    bus.emit('demo:biome-changed', { biome: 'freshwater' });
    expect(tracker.current.active).toBe(false);
  });

  it('switches back to the demo tank when the saved one goes', async () => {
    const { bus, tracker } = rig();
    bus.emit('tank:loaded', saved('a'));
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
    bus.emit('tank:none', {});
    expect(tracker.current).toMatchObject({ active: true, reason: 'switch' });
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
  });

  it('finishes a switch when the scene queue has nothing to do', async () => {
    const { bus, tracker } = rig();
    bus.emit('demo:biome-changed', { biome: 'reef' });
    await vi.waitFor(() => expect(tracker.current).toMatchObject({ active: false, progress: 1 }));
  });

  it('waits for the fish and the frames before it finishes', async () => {
    const { bus, tracker, gates } = rig();
    let release: () => void = () => undefined;
    gates.frames = new Promise<void>((resolve) => (release = resolve));
    bus.emit('tank:loaded', saved('a'));
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
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current.reason).toBe('boot');
  });

  it('keeps a failed first load failed', () => {
    const { bus, tracker } = rig();
    tracker.begin('boot');
    tracker.fail('no renderer');
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current).toMatchObject({ reason: 'boot', error: 'no renderer' });
  });

  it('tracks the tank shown during the first load, so a repeat afterwards starts nothing', () => {
    const { bus, tracker } = rig();
    tracker.begin('boot');
    bus.emit('tank:loaded', saved('a'));
    tracker.finish();
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current.active).toBe(false);
  });

  it('tracks tanks before the sources are attached', () => {
    const { bus, tracker, watch } = rig(false);
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current.active).toBe(false);
    watch.attach({
      assets: { rebase: vi.fn(), stop: vi.fn() },
      sceneSettled: () => Promise.resolve(),
      fishSynced: () => Promise.resolve(),
      frames: () => Promise.resolve(),
    });
    bus.emit('tank:loaded', saved('a'));
    expect(tracker.current.active).toBe(false);
  });

  it('lets a newer switch supersede an older one', async () => {
    const { bus, tracker, gates } = rig();
    let releaseOld: () => void = () => undefined;
    gates.fish = new Promise<void>((resolve) => (releaseOld = resolve));
    bus.emit('tank:loaded', saved('a'));
    await vi.waitFor(() => expect(tracker.current.stage).toBe('Loading fish'));
    gates.fish = Promise.resolve();
    bus.emit('tank:loaded', saved('b'));
    await vi.waitFor(() => expect(tracker.current.active).toBe(false));
    const done = tracker.current;
    releaseOld();
    await Promise.resolve();
    expect(tracker.current).toBe(done);
  });

  it('stops listening when stopped', () => {
    const { bus, tracker, watch } = rig();
    watch.stop();
    bus.emit('tank:loaded', saved('a'));
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
