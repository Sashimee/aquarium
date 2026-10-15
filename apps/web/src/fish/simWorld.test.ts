import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Collider } from '@aquarium/shared';
import {
  SimClient,
  SNAPSHOT_STRIDE,
  World,
  type SimClientPort,
  type SimReady,
} from '@aquarium/sim';
import { HUNGER_PER_PORTION } from '@aquarium/sim/lifecycle';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import type { SceneAnchor } from '../scene/anemone';
import { FISH_1, FISH_2, TANK_A, fishFixture } from '../sync/fixtures';
import { demoTank, sceneAnchorsToSim } from './demoStock';
import { TankRoster } from './roster';
import { allSpeciesInputs } from './species';
import {
  initSim,
  layoutChanges,
  SimErrorGate,
  SimInitTimeout,
  SimWorkerFailure,
  SimWorldSpec,
  startWorld,
  type SimInit,
  type WorldControls,
} from './simWorld';

const DEMO = demoTank(DEFAULT_TANK, 7, 'reef');
const ANEMONE: SceneAnchor = {
  id: 'anemone-1',
  kind: 'anemone',
  position: [0.15, 0.22, -0.05],
  radius: 0.06,
};
const MOVED: SceneAnchor = { ...ANEMONE, position: [-0.2, 0.2, 0.05] };
const CLOWN = { species: 'ocellaris-clownfish' } as const;
const ROCK: Collider = {
  id: 'scene:0',
  kind: 'sphere',
  hard: true,
  center: [0, 0.15, 0],
  radius: 0.05,
};

function setup(): { spec: SimWorldSpec; roster: TankRoster } {
  return { spec: new SimWorldSpec(DEMO, 7), roster: new TankRoster(DEMO.config.fish) };
}

function anchorsOf(spec: SimWorldSpec, roster: TankRoster): unknown {
  return spec.config(roster.swimming())?.anchors;
}

describe('SimWorldSpec', () => {
  it('starts a world without homes until the scene sends them', () => {
    const { spec, roster } = setup();
    expect(anchorsOf(spec, roster)).toEqual([]);
  });

  it('hands the latest colliders to every new world, which the sim accepts', () => {
    const { spec, roster } = setup();
    expect(spec.config(roster.swimming())?.decor).toEqual([]);
    spec.setDecor([
      { id: 'scene:0', kind: 'sphere', hard: true, center: [0, 0.25, 0], radius: 0.05 },
    ]);
    const config = spec.config(roster.swimming());
    expect(config?.decor).toBe(spec.decor);
    if (config === null) throw new Error('the demo has no world');
    expect(() => new World(config)).not.toThrow();
  });

  it('hands the scene anchors, in the sim frame, to every world after them', () => {
    const { spec, roster } = setup();
    const sim = spec.setAnchors([ANEMONE]);
    expect(sim).toEqual(sceneAnchorsToSim([ANEMONE], DEMO));
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_1, CLOWN)],
    });
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.add({ tankId: TANK_A, fish: fishFixture(FISH_2, CLOWN), acclimate: true });
    roster.release({ tankId: TANK_A, fishId: FISH_2 });
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.died({ tankId: TANK_A, fish: fishFixture(FISH_1, { ...CLOWN, status: 'dead' }) });
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.unload({ tankId: TANK_A, reason: 'switch' });
    expect(anchorsOf(spec, roster)).toEqual(sim);
  });

  it('seeds each saved fish with its lifecycle hunger and leaves demo fish unset', () => {
    const { spec, roster } = setup();
    expect(spec.config(roster.swimming())?.fish.every((f) => f.hunger === undefined)).toBe(true);
    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_1, { ...CLOWN, hunger: 0.7 })],
    });
    const config = spec.config(roster.swimming());
    expect(config?.fish.map((f) => f.hunger)).toEqual([0.7]);
    if (config === null) throw new Error('no world');
    expect(() => new World(config)).not.toThrow();
  });

  it('seeds a world rebuilt mid-session with what the fish ate since it joined', () => {
    const { spec, roster } = setup();
    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_1, { ...CLOWN, hunger: 0.7 })],
    });
    const fishId = roster.simIdOf(FISH_1);
    if (fishId === undefined) throw new Error('the fish did not join');
    roster.translateAte([{ fishId, foodId: 1, portion: 1 }]);
    const config = spec.config(roster.swimming());
    expect(config?.fish[0]?.hunger).toBeCloseTo(0.7 - HUNGER_PER_PORTION);
    if (config === null) throw new Error('no world');
    expect(() => new World(config)).not.toThrow();
  });

  it('uses the latest anchors once the scene moves them', () => {
    const { spec, roster } = setup();
    spec.setAnchors([ANEMONE]);
    const moved = spec.setAnchors([MOVED]);
    expect(anchorsOf(spec, roster)).toEqual(moved);
    expect(moved).not.toEqual(sceneAnchorsToSim([ANEMONE], DEMO));
  });

  it('builds a world the sim accepts, homes included', () => {
    const { spec, roster } = setup();
    spec.setAnchors([ANEMONE]);
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the reef demo stock has no world');
    expect(config.fish.map((f) => f.species)).toContain('ocellaris-clownfish');
    expect(() => new World(config)).not.toThrow();
  });

  it('spawns saved fish under their sim ids and sizes, skipping species with no content', () => {
    const { spec, roster } = setup();
    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [
        fishFixture(FISH_1, { ...CLOWN, size: 0.07 }),
        fishFixture(FISH_2, { species: 'coelacanth' }),
      ],
    });
    const config = spec.config(roster.swimming());
    expect(config?.fish).toEqual([
      {
        id: roster.simIdOf(FISH_1),
        species: 'ocellaris-clownfish',
        bodyLengthM: 0.07,
        hunger: 0.1,
      },
    ]);
    expect(config?.species).toBe(allSpeciesInputs());
    expect(config?.seed).toBe(7);
    expect(config?.space).toBe(DEMO.config.space);
  });

  it('spawns a stored male guppy at the male length, so it swims at its own body lengths', () => {
    const { spec, roster } = setup();
    roster.load({
      tankId: TANK_A,
      biome: 'freshwater',
      decorLayout: [],
      decorEdited: false,
      fish: [
        fishFixture(FISH_2, { species: 'guppy', size: 0.04, sex: 'female' }),
        fishFixture(FISH_1, { species: 'guppy', size: 0.04, sex: 'male' }),
      ],
    });
    const lengths = spec.config(roster.swimming())?.fish.map((f) => f.bodyLengthM);
    expect(lengths?.[0]).toBe(0.04);
    expect(lengths?.[1]).toBeCloseTo(0.025);
  });

  it('builds a world that can take in a fish of a species it started without', () => {
    const { spec, roster } = setup();
    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_1, CLOWN)],
    });
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the clownfish tank has no world');
    const world = new World(config);
    expect(() => world.addFish({ id: 'tang', species: 'blue-tang' })).not.toThrow();
    expect(world.fishIds).toEqual([roster.simIdOf(FISH_1), 'tang']);
  });

  it('names the colliders and homes that changed while a world was starting', () => {
    const { spec, roster } = setup();
    spec.setDecor([ROCK]);
    spec.setAnchors([ANEMONE]);
    const starting = spec.config(roster.swimming());
    if (starting === null) throw new Error('the demo has no world');
    expect(spec.changedSince(starting)).toEqual({ decor: null, anchors: null });

    const moved: Collider = { ...ROCK, center: [0.2, 0.15, 0.1] };
    spec.setDecor([moved]);
    expect(spec.changedSince(starting)).toEqual({ decor: [moved], anchors: null });

    const homes = spec.setAnchors([MOVED]);
    expect(spec.changedSince(starting)).toEqual({ decor: [moved], anchors: homes });

    const next = spec.config(roster.swimming());
    if (next === null) throw new Error('the demo has no world');
    expect(spec.changedSince(next)).toEqual({ decor: null, anchors: null });
  });

  it('has no world to run when nothing swims', () => {
    const { spec, roster } = setup();
    roster.load({ tankId: TANK_A, biome: 'reef', decorLayout: [], decorEdited: false, fish: [] });
    expect(spec.config(roster.swimming())).toBeNull();
  });
});

describe('layoutChanges', () => {
  const spawn = (id: string) => ({ id, species: 'neon-tetra' });

  it('adds the newcomers and removes the leavers, leaving the rest alone', () => {
    const { remove, add } = layoutChanges(['a', 'b', 'c'], [spawn('a'), spawn('c'), spawn('d')]);
    expect(remove).toEqual(['b']);
    expect(add).toEqual([spawn('d')]);
  });

  it('changes nothing when the world already holds the wanted fish', () => {
    expect(layoutChanges(new Set(['a', 'b']), [spawn('b'), spawn('a')])).toEqual({
      remove: [],
      add: [],
    });
  });

  it('fills an empty world and empties a full one', () => {
    expect(layoutChanges([], [spawn('a')])).toEqual({ remove: [], add: [spawn('a')] });
    expect(layoutChanges(['a'], [])).toEqual({ remove: ['a'], add: [] });
  });
});

describe('startWorld', () => {
  type Call = readonly [string, unknown?];

  function recorder(): { sim: WorldControls; calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      sim: {
        setLight: (level) => calls.push(['light', level]),
        setDecor: (decor) => calls.push(['decor', decor]),
        setAnchors: (anchors) => calls.push(['anchors', anchors]),
        start: () => calls.push(['start']),
      },
    };
  }

  function pending(): { promise: Promise<SimReady>; answer: (ready: SimReady) => void } {
    let answer: (ready: SimReady) => void = () => undefined;
    const promise = new Promise<SimReady>((resolve) => {
      answer = resolve;
    });
    return { promise, answer };
  }

  const READY: SimReady = {
    type: 'ready',
    request: 1,
    epoch: 1,
    fishIds: ['a'],
    stride: SNAPSHOT_STRIDE,
    stepHz: 30,
  };

  function demoConfig(spec: SimWorldSpec, roster: TankRoster) {
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the demo has no world');
    return config;
  }

  it('re-sends the colliders and homes the scene sent while the first world was starting', async () => {
    const { spec, roster } = setup();
    const { sim, calls } = recorder();
    const init = pending();
    const config = demoConfig(spec, roster);
    let light = 0.3;
    const started = startWorld(sim, spec, config, init.promise, {
      current: () => true,
      light: () => light,
      begin: (ready) => calls.push(['begin', ready]),
    });

    spec.setDecor([ROCK]);
    const homes = spec.setAnchors([ANEMONE]);
    light = 0.8;
    expect(calls).toEqual([]);

    init.answer(READY);
    await started;
    expect(calls).toEqual([
      ['light', 0.8],
      ['decor', [ROCK]],
      ['anchors', homes],
      ['begin', READY],
      ['start'],
    ]);
  });

  it('sends no colliders or homes the config already carried', async () => {
    const { spec, roster } = setup();
    spec.setDecor([ROCK]);
    spec.setAnchors([ANEMONE]);
    const { sim, calls } = recorder();
    await startWorld(sim, spec, demoConfig(spec, roster), Promise.resolve(READY), {
      current: () => true,
      light: () => 1,
      begin: () => undefined,
    });
    expect(calls).toEqual([['light', 1], ['start']]);
  });

  it('leaves a world dropped while starting unstarted', async () => {
    const { spec, roster } = setup();
    const { sim, calls } = recorder();
    const init = pending();
    let current = true;
    const started = startWorld(sim, spec, demoConfig(spec, roster), init.promise, {
      current: () => current,
      light: () => 1,
      begin: (ready) => calls.push(['begin', ready]),
    });
    spec.setDecor([ROCK]);
    current = false;
    init.answer(READY);
    await started;
    expect(calls).toEqual([]);
  });

  it('passes on a failed init without starting anything', async () => {
    const { spec, roster } = setup();
    const { sim, calls } = recorder();
    const failure = new Error('worker failed to start');
    await expect(
      startWorld(sim, spec, demoConfig(spec, roster), Promise.reject(failure), {
        current: () => true,
        light: () => 1,
        begin: () => undefined,
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual([]);
  });
});

describe('initSim', () => {
  const READY: SimReady = {
    type: 'ready',
    request: 1,
    epoch: 1,
    fishIds: ['a'],
    stride: SNAPSHOT_STRIDE,
    stepHz: 30,
  };

  function start(client: SimInit['client'], signal = new AbortController().signal) {
    const listeners = new Set<(event: Pick<ErrorEvent, 'message'>) => void>();
    const worker: SimInit['worker'] = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    };
    const { spec, roster } = setup();
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the demo has no world');
    const init = initSim({ client, worker, config, signal, timeoutMs: 1000 });
    return {
      init,
      listeners,
      fail: (message: string) => {
        for (const l of [...listeners]) l({ message });
      },
    };
  }

  const never: SimInit['client'] = { init: () => new Promise<SimReady>(() => undefined) };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the answer and lets go of the worker', async () => {
    vi.useFakeTimers();
    const { init, listeners } = start({ init: () => Promise.resolve(READY) });
    await expect(init).resolves.toBe(READY);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with SimInitTimeout when the worker never answers', async () => {
    vi.useFakeTimers();
    const { init, listeners } = start(never);
    const settled = expect(init).rejects.toThrow(/did not answer init within 1 s/);
    await vi.advanceTimersByTimeAsync(999);
    expect(listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    await expect(init).rejects.toBeInstanceOf(SimInitTimeout);
    expect(listeners.size).toBe(0);
  });

  it('fails when the worker script errors, without waiting for the timeout', async () => {
    vi.useFakeTimers();
    const { init, fail } = start(never);
    fail('404');
    await expect(init).rejects.toThrow('Fish sim worker failed to start: 404');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes on the sim refusing the config', async () => {
    const refused = new Error('bad config');
    await expect(start({ init: () => Promise.reject(refused) }).init).rejects.toBe(refused);
  });

  it('rejects with the abort reason, whether aborted before or during init', async () => {
    vi.useFakeTimers();
    const gone = new Error('disposed');
    const before = new AbortController();
    before.abort(gone);
    await expect(start(never, before.signal).init).rejects.toBe(gone);

    const during = new AbortController();
    const { init } = start(never, during.signal);
    during.abort(gone);
    await expect(init).rejects.toBe(gone);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SimErrorGate', () => {
  class FakePort implements SimClientPort {
    readonly sent: unknown[] = [];
    private readonly listeners = new Map<string, Set<(event: never) => void>>();
    postMessage(message: unknown): void {
      this.sent.push(message);
    }
    addEventListener(type: string, listener: (event: never) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }
    removeEventListener(type: string, listener: (event: never) => void): void {
      this.listeners.get(type)?.delete(listener);
    }
    emit(data: unknown): void {
      this.dispatch('message', new MessageEvent('message', { data }));
    }
    crash(type: 'error' | 'messageerror' = 'error', message = ''): void {
      this.dispatch(type, Object.assign(new Event(type), type === 'error' ? { message } : {}));
    }
    private dispatch(type: string, event: Event): void {
      for (const l of [...(this.listeners.get(type) ?? [])]) (l as (event: Event) => void)(event);
    }
  }

  function connect(): {
    port: FakePort;
    client: SimClient;
    reported: string[];
    gate: SimErrorGate;
  } {
    const port = new FakePort();
    const client = new SimClient(port);
    const reported: string[] = [];
    const gate = new SimErrorGate((message) => reported.push(message));
    client.onError(gate.receive);
    port.addEventListener('error', gate.workerFailed);
    return { port, client, reported, gate };
  }

  function starting(port: FakePort, client: SimClient, timeoutMs = 1000): Promise<SimReady> {
    const { spec, roster } = setup();
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the demo has no world');
    const signal = new AbortController().signal;
    return initSim({ client, worker: port, config, signal, timeoutMs });
  }

  async function failure(start: Promise<unknown>): Promise<unknown> {
    try {
      await start;
    } catch (cause) {
      return cause;
    }
    throw new Error('the start succeeded');
  }

  it('holds an unrequested error from a world still starting instead of throwing it', () => {
    const { port, reported, gate } = connect();
    expect(() => port.emit({ type: 'error', message: 'bad collider' })).not.toThrow();
    expect(reported).toEqual([]);

    gate.open();
    expect(reported).toEqual(['bad collider']);
  });

  it('reports errors as they come once open, after the held ones and in order', () => {
    const { port, reported, gate } = connect();
    port.emit({ type: 'error', message: 'first' });
    port.emit({ type: 'error', message: 'second' });
    gate.open();
    port.emit({ type: 'error', message: 'third' });
    gate.open();
    expect(reported).toEqual(['first', 'second', 'third']);
  });

  it('never reports a worker failure that rejected the start, when the start does not open it', async () => {
    const { port, client, reported } = connect();
    const { spec, roster } = setup();
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the demo has no world');
    const init = client.init(config);
    port.crash();
    await expect(init).rejects.toThrow();
    expect(reported).toEqual([]);
  });

  it('reports neither copy of a worker crash that failed the start', async () => {
    const { port, client, reported, gate } = connect();
    const start = starting(port, client);
    port.crash('error', 'boom');
    const cause = await failure(start);
    expect(cause).toBeInstanceOf(SimWorkerFailure);
    gate.close(cause);
    expect(reported).toEqual([]);
  });

  it('reports a held error, not the unreadable message, when that message failed the start', async () => {
    const { port, client, reported, gate } = connect();
    const start = starting(port, client);
    port.emit({ type: 'error', message: 'bad collider' });
    port.crash('messageerror');
    gate.close(await failure(start));
    expect(reported).toEqual(['bad collider']);
  });

  it('reports what it held, crash included, when the start failed for another reason', async () => {
    vi.useFakeTimers();
    try {
      const { port, client, reported, gate } = connect();
      port.crash('error', 'boom');
      port.emit({ type: 'error', message: 'bad collider' });
      const start = failure(starting(port, client));
      await vi.advanceTimersByTimeAsync(1000);
      const cause = await start;
      expect(cause).toBeInstanceOf(SimInitTimeout);
      gate.close(cause);
      expect(reported).toEqual(['sim worker failed: boom', 'bad collider']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an error held before a worker crash that failed the start', async () => {
    const { port, client, reported, gate } = connect();
    const start = starting(port, client);
    port.emit({ type: 'error', message: 'bad collider' });
    port.crash('error', 'boom');
    gate.close(await failure(start));
    expect(reported).toEqual(['bad collider']);
  });

  it('reports errors as they come once closed', async () => {
    const { port, reported, gate } = connect();
    gate.close(await failure(Promise.reject(new Error('species failed to load'))));
    port.emit({ type: 'error', message: 'late' });
    expect(reported).toEqual(['late']);
  });

  it('leaves an error naming a pending request to that request', async () => {
    const { port, client, reported, gate } = connect();
    gate.open();
    const { spec, roster } = setup();
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the demo has no world');
    const init = client.init(config);
    const { request } = port.sent[0] as { request: number };
    port.emit({ type: 'error', request, message: 'bad config' });
    await expect(init).rejects.toThrow('bad config');
    expect(reported).toEqual([]);
  });
});
