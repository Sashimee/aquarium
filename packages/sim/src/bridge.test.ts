import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Anchor } from './behaviour.ts';
import {
  createSimHost,
  SimClient,
  type SimAte,
  type SimClientPort,
  type SimCrew,
  type SimHost,
  type SimHostOptions,
} from './bridge.ts';
import type { Collider } from '@aquarium/shared';
import type { CrewTally } from './crew.ts';
import { compileCollider, type Point3 } from './decor.ts';
import {
  angelfish,
  ARCHETYPES,
  benchmarkConfig,
  blueTang,
  bronzeCorydoras,
  cherryShrimp,
  clownfish,
  guppy,
  neonTetra,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_TANK,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import { FOOD_STRIDE, FOOD_TYPES, type AteEvent } from './food.ts';
import { SNAPSHOT_STRIDE, SnapshotField, SnapshotInterpolator, type Snapshot } from './snapshot.ts';
import type { SimToy, ToyNudge } from './toys.ts';
import { STEP_HZ, World, type WorldConfig } from './world.ts';

interface Harness {
  host: SimHost;
  client: SimClient;
  hostPort: MessagePort;
  clientPort: MessagePort;
}

const open: Harness[] = [];

function connect(options?: SimHostOptions): Harness {
  const channel = new MessageChannel();
  const host = createSimHost(channel.port1, options);
  const client = new SimClient(channel.port2);
  const harness = { host, client, hostPort: channel.port1, clientPort: channel.port2 };
  open.push(harness);
  return harness;
}

function nextSnapshot(client: SimClient): Promise<Snapshot> {
  return new Promise((resolve) => {
    const off = client.onSnapshot((s) => {
      off();
      resolve(s);
    });
  });
}

function nextError(client: SimClient): Promise<string> {
  return new Promise((resolve) => {
    const off = client.onError((m) => {
      off();
      resolve(m);
    });
  });
}

function flakeGrid(count: number, firstId = 1): Float32Array {
  const records = new Float32Array(count * FOOD_STRIDE);
  for (let k = 0; k < count; k++) {
    records.set(
      [
        firstId + k,
        -0.5 + (k % 10) * 0.1,
        0.3,
        -0.1 + Math.floor(k / 10) * 0.1,
        FOOD_TYPES.indexOf('flakes'),
      ],
      k * FOOD_STRIDE,
    );
  }
  return records;
}

/** Steps the host and gathers every `ate` message sent up to the snapshot at `tick`. */
async function stepCollecting(client: SimClient, steps: number, tick: number) {
  const ate: SimAte[] = [];
  const offAte = client.onAte((events, a) => {
    expect(events).toBe(a.events);
    ate.push(a);
  });
  const snapshot = await new Promise<Snapshot>((resolve) => {
    const off = client.onSnapshot((s) => {
      if (s.tick !== tick) return;
      off();
      resolve(s);
    });
    client.step(steps);
  });
  offAte();
  return { snapshot, ate };
}

/** A worker the test drives by hand: `post` delivers a message, `emit` any other port event. */
function fakeWorker() {
  const sent: unknown[] = [];
  const listeners = new Map<string, Set<(event: never) => void>>();
  const port: SimClientPort = {
    postMessage: (message: unknown) => {
      sent.push(message);
    },
    addEventListener: (type: string, listener: (event: never) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: never) => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const emit = (type: string, event: object): void => {
    for (const l of listeners.get(type) ?? []) (l as (event: object) => void)({ ...event, type });
  };
  const post = (data: unknown): void => emit('message', { data });
  const initRequest = (): number => {
    const init = sent.findLast((m) => (m as { type: string }).type === 'init');
    if (init === undefined) throw new Error('fakeWorker: no init was sent');
    return (init as { request: number }).request;
  };
  return {
    port,
    sent,
    emit,
    post,
    initRequest,
    /** Answers the latest init sent. */
    ready: (epoch: number, fishIds: readonly string[] = []): void =>
      post({
        type: 'ready',
        request: initRequest(),
        epoch,
        fishIds,
        stride: SNAPSHOT_STRIDE,
        stepHz: STEP_HZ,
      }),
    listening: (): number => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

afterEach(() => {
  for (const h of open.splice(0)) {
    h.client.dispose();
    h.host.dispose();
    h.hostPort.close();
    h.clientPort.close();
  }
});

describe('sim worker bridge', () => {
  it('initialises, then streams snapshots matching a local world', async () => {
    const { client } = connect();
    const config = benchmarkConfig(8);
    const first = nextSnapshot(client);
    const ready = await client.init(config);
    expect(ready.fishIds).toEqual(config.fish.map((f) => f.id));
    expect(ready.stride).toBe(SNAPSHOT_STRIDE);
    expect(ready.stepHz).toBe(STEP_HZ);

    const initial = await first;
    expect(initial.tick).toBe(0);
    expect(initial.data.length).toBe(config.fish.length * SNAPSHOT_STRIDE);

    const stepped = nextSnapshot(client);
    client.step(45);
    const s = await stepped;
    expect(s.tick).toBe(45);
    expect(s.time).toBeCloseTo(1.5, 12);

    const local = new World(config);
    for (let t = 0; t < 45; t++) local.step();
    const expected = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(expected);
    expect(s.data).toEqual(expected);
  });

  it('transfers buffers both ways and reuses recycled ones', async () => {
    const { client } = connect();
    await client.init(benchmarkConfig(1));
    const a = nextSnapshot(client);
    client.step(1);
    const snapshot = await a;
    const bytes = snapshot.data.byteLength;
    client.recycle(snapshot);
    expect(snapshot.data.byteLength).toBe(0);
    const b = nextSnapshot(client);
    client.step(1);
    const next = await b;
    expect(next.data.byteLength).toBe(bytes);
    expect(next.data[SnapshotField.QuatW]).not.toBe(0);
  });

  it('runs on its own fixed-step clock once started', async () => {
    const { client } = connect();
    const initial = nextSnapshot(client);
    await client.init(benchmarkConfig(1));
    expect((await initial).tick).toBe(0);
    const startedAt = performance.now();
    client.start();
    const first = await nextSnapshot(client);
    const second = await nextSnapshot(client);
    client.stop();
    const elapsedMs = performance.now() - startedAt;
    expect(first.tick).toBeGreaterThanOrEqual(1);
    expect(second.tick).toBeGreaterThan(first.tick);
    expect(second.tick).toBeLessThanOrEqual(Math.ceil((elapsedMs / 1000) * STEP_HZ) + 1);
  });

  it('reports commands before init and bad step counts as errors', async () => {
    const { client } = connect();
    const early = nextError(client);
    client.step(1);
    expect(await early).toMatch(/before "init"/);

    await client.init(benchmarkConfig(1));
    const bad = nextError(client);
    client.step(0);
    expect(await bad).toMatch(/positive integer/);
  });

  it('applies startle, light, decor and anchor commands exactly as a local world would', async () => {
    const { client } = connect();
    const config = benchmarkConfig(3);
    await client.init(config);
    const local = new World(config);
    const stimulus = { position: [0, 0.3, 0.29] as const, intensity: 1 };
    const decor = REEF_DECOR.filter((c) => c.id !== 'rock-left');
    const anchors = REEF_ANCHORS.filter((a) => a.kind === 'cave');

    client.startle(stimulus);
    client.setLight(0.2);
    client.setDecor(decor);
    client.setAnchors(anchors);
    const pending = new Promise<Snapshot>((resolve) => {
      const off = client.onSnapshot((snapshot) => {
        if (snapshot.tick !== 45) return;
        off();
        resolve(snapshot);
      });
    });
    client.step(45);
    const remote = await pending;

    local.startle(stimulus);
    local.setLight(0.2);
    local.setDecor(decor);
    local.setAnchors(anchors);
    for (let t = 0; t < 45; t++) local.step();
    const expected = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(expected);
    expect(Array.from(remote.data)).toEqual(Array.from(expected));
  });

  it('moves fish out of a rock moved onto them through the worker, not out of where it was', async () => {
    const rockAt = (x: number): Collider => ({
      id: 'decor:rock',
      hard: true,
      kind: 'box',
      center: [x, 0.1, 0],
      halfExtents: [0.12, 0.1, 0.12],
      rotationY: 0,
      rounding: 0.02,
    });
    const config: WorldConfig = {
      seed: 1,
      tank: SHOW_TANK,
      species: [neonTetra, bronzeCorydoras, cherryShrimp, angelfish],
      decor: [rockAt(-0.3)],
      fish: [
        ...spawnMany(neonTetra.id, 12),
        ...spawnMany(bronzeCorydoras.id, 4),
        ...spawnMany(cherryShrimp.id, 8),
        ...spawnMany(angelfish.id, 2),
      ],
    };
    const { client } = connect();
    await client.init(config);
    const local = new World(config);
    const n = new Float64Array(3);
    const oldRock = compileCollider(rockAt(-0.3));
    const newRock = compileCollider(rockAt(0.3));
    const inside = (data: Float32Array, rock: typeof newRock): number => {
      let count = 0;
      for (let k = 0; k < data.length / SNAPSHOT_STRIDE; k++) {
        const o = k * SNAPSHOT_STRIDE;
        const x = data[o + SnapshotField.PosX] ?? Number.NaN;
        const y = data[o + SnapshotField.PosY] ?? Number.NaN;
        const z = data[o + SnapshotField.PosZ] ?? Number.NaN;
        if (rock.sample(x, y, z, n) < 0) count++;
      }
      return count;
    };
    const settled = await stepCollecting(client, 900, 900);
    expect(inside(settled.snapshot.data, newRock)).toBeGreaterThan(0);
    expect(inside(settled.snapshot.data, oldRock)).toBe(0);

    client.setDecor([rockAt(0.3)]);
    const moved = await stepCollecting(client, 1, 901);
    expect(inside(moved.snapshot.data, newRock)).toBe(0);

    for (let t = 0; t < 900; t++) local.step();
    local.setDecor([rockAt(0.3)]);
    local.step();
    const expected = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(expected);
    expect(Array.from(moved.snapshot.data)).toEqual(Array.from(expected));
  });

  it('applies lure commands exactly as a local world would', async () => {
    const { client } = connect();
    const config = benchmarkConfig(3);
    await client.init(config);
    const local = new World(config);
    const lure = [0, 0.3, 0.297] as const;
    const tick = (n: number) =>
      new Promise<Snapshot>((resolve) => {
        const off = client.onSnapshot((snapshot) => {
          if (snapshot.tick !== n) return;
          off();
          resolve(snapshot);
        });
      });

    client.setLure([...lure]);
    const lured = tick(150);
    client.step(150);
    await lured;
    client.setLure(null);
    const released = tick(180);
    client.step(30);
    const remote = await released;

    local.setLure([...lure]);
    for (let t = 0; t < 150; t++) local.step();
    expect(local.behaviour.curiosity.follow.some((f) => f === 1)).toBe(true);
    local.setLure(null);
    for (let t = 0; t < 30; t++) local.step();
    const expected = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(expected);
    expect(Array.from(remote.data)).toEqual(Array.from(expected));
  });

  // Two 60-fish worlds step 1800 times each: about 1 s on a quiet machine, but past the 5 s
  // default on a shared one under heavy load.
  it('applies toys as a local world would and passes on its nudges in order', async () => {
    const { client } = connect();
    const config = benchmarkConfig(6);
    const ready = await client.init(config);
    const local = new World(config);
    const back = -REEF_TANK.depth / 2 + 0.004;
    const toys: SimToy[] = [
      { kind: 'mirror', position: [0.2, 0.45, back], normal: [0, 0, 1] },
      { kind: 'ball', position: [0, REEF_TANK.height + 0.012, 0], velocity: [0, 0, 0] },
    ];
    const steps = 1800;
    const received: ToyNudge[] = [];
    const off = client.onToyNudge((n) => received.push(n));
    const done = new Promise<Snapshot>((resolve) => {
      const offSnapshot = client.onSnapshot((snapshot) => {
        if (snapshot.tick !== steps) return;
        offSnapshot();
        resolve(snapshot);
      });
    });
    client.setToys(toys);
    client.step(steps);
    const remote = await done;
    off();

    local.setToys(toys);
    const expected: ToyNudge[] = [];
    for (let t = 0; t < steps; t++) {
      local.step();
      expected.push(...local.takeToyNudges());
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(received).toEqual(expected);
    const data = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(data);
    expect(Array.from(remote.data)).toEqual(Array.from(data));

    const id = ready.fishIds[ready.fishIds.length - 1] ?? '';
    const point = client.fishPoint(id);
    const i = ready.fishIds.length - 1;
    expect(point).toEqual(
      [SnapshotField.PosX, SnapshotField.PosY, SnapshotField.PosZ].map(
        (f) => data[i * SNAPSHOT_STRIDE + f],
      ),
    );
    expect(client.fishPoint('nobody')).toBeNull();
  }, 20_000);

  it('answers fishPoint only from a snapshot of the current layout', async () => {
    const { client } = connect();
    const ready = await client.init(benchmarkConfig(2));
    const first = ready.fishIds[0] ?? '';
    expect(client.fishPoint(first)).toBeNull();
    const snapshot = nextSnapshot(client);
    client.step(1);
    await snapshot;
    expect(client.fishPoint(first)).not.toBeNull();
    await client.removeFish(first);
    expect(client.fishPoint(first)).toBeNull();
    const second = ready.fishIds[1] ?? '';
    expect(client.fishPoint(second)).toBeNull();
    const after = nextSnapshot(client);
    client.step(1);
    await after;
    expect(client.fishPoint(first)).toBeNull();
    expect(client.fishPoint(second)).not.toBeNull();
  });

  it('reports malformed toys as an error and keeps the world running', async () => {
    const { client } = connect();
    await client.init(benchmarkConfig(2));
    const error = nextError(client);
    client.setToys([{ kind: 'mirror', position: [0, 0.3, 0], normal: [0, 0, 0] }]);
    expect(await error).toMatch(/toys/);
    const snapshot = nextSnapshot(client);
    client.step(1);
    expect((await snapshot).tick).toBe(1);
  });

  it('passes on nudges of the current world only', async () => {
    const worker = fakeWorker();
    const client = new SimClient(worker.port);
    const received: ToyNudge[] = [];
    client.onToyNudge((n) => received.push(n));
    const nudge: ToyNudge = { fishId: 'betta-0', toyId: 'ball', toy: 0, ix: 0.01, iz: 0 };
    const first = client.init(benchmarkConfig(1));
    worker.ready(1);
    await first;
    worker.post({ type: 'toyNudge', epoch: 0, tick: 1, nudges: [nudge] });
    expect(received).toEqual([]);
    worker.post({ type: 'toyNudge', epoch: 1, tick: 2, nudges: [nudge, nudge] });
    expect(received).toEqual([nudge, nudge]);
    const second = client.init(benchmarkConfig(2));
    worker.post({ type: 'toyNudge', epoch: 1, tick: 3, nudges: [nudge] });
    expect(received.length).toBe(2);
    worker.ready(2);
    await second;
    client.dispose();
    worker.post({ type: 'toyNudge', epoch: 2, tick: 1, nudges: [nudge] });
    expect(received.length).toBe(2);
  });

  it('reports scene commands before init and invalid scene values as errors', async () => {
    const { client } = connect();
    const early = nextError(client);
    client.setLight(1);
    expect(await early).toMatch(/"light" before "init"/);

    await client.init(benchmarkConfig(1));
    const dark = nextError(client);
    client.setLight(2);
    expect(await dark).toMatch(/light level/);
    const nowhere = nextError(client);
    client.setLure([Number.NaN, 0.2, 0]);
    expect(await nowhere).toMatch(/lure: position/);
    const tap = nextError(client);
    client.startle({ position: [0, 0.2, 0], intensity: 3 });
    expect(await tap).toMatch(/intensity/);
    const twins = nextError(client);
    client.setDecor([...REEF_DECOR, ...REEF_DECOR.slice(0, 1)]);
    expect(await twins).toMatch(/unique/);
    const cone = nextError(client);
    const forgedDecor = { id: 'cone', hard: true, kind: 'cone' } as unknown;
    client.setDecor([forgedDecor as Collider]);
    expect(await cone).toMatch(/decor "cone": kind/);
    const reefless = nextError(client);
    const forgedAnchor = { id: 'x', kind: 'reef', position: [0, 0.1, 0], radius: 0.05 } as unknown;
    client.setAnchors([forgedAnchor as Anchor]);
    expect(await reefless).toMatch(/anchor "x": kind must be/);
  });

  it('feeds fish from a food buffer and reports what they ate as a local world would', async () => {
    const { client } = connect();
    const config = benchmarkConfig(5);
    const food = flakeGrid(30);
    const ready = await client.init(config);
    client.setFood(food);
    const { snapshot, ate } = await stepCollecting(client, 90, 90);

    const local = new World(config);
    local.setFood(food);
    const expected: AteEvent[] = [];
    for (let t = 0; t < 90; t++) {
      local.step();
      expected.push(...local.takeAteEvents());
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(ate.every((a) => a.epoch === ready.epoch)).toBe(true);
    expect(ate.flatMap((a) => a.events)).toEqual(expected);
    const data = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(data);
    expect(Array.from(snapshot.data)).toEqual(Array.from(data));
  });

  it('grazes the algae it is sent and reports the crew tally as a local world would', async () => {
    const { client } = connect();
    const config: WorldConfig = {
      seed: 4,
      tank: SHOW_TANK,
      species: [...ARCHETYPES, cherryShrimp],
      decor: [],
      fish: spawnMany(cherryShrimp.id, 3),
    };
    const ready = await client.init(config);
    const tallies: SimCrew[] = [];
    client.onCrew((tally, crew) => {
      expect(tally).toBe(crew.tally);
      tallies.push(crew);
    });
    client.setAlgae(0.6);
    await stepCollecting(client, 95, 95);

    const local = new World(config);
    local.setAlgae(0.6);
    for (let t = 0; t < 95; t++) local.step();
    const expected = local.takeCrewTally();
    expect(expected.length).toBe(3);
    expect(tallies).toEqual([{ type: 'crew', epoch: ready.epoch, tick: 95, tally: expected }]);
    expect(() => client.setAlgae(1.5)).toThrow(/algae/);
  });

  it('sends the crew tally at most once a second, and all of it before a layout change', async () => {
    const { client } = connect();
    const config: WorldConfig = {
      seed: 4,
      tank: SHOW_TANK,
      species: [...ARCHETYPES, cherryShrimp],
      decor: [],
      fish: spawnMany(cherryShrimp.id, 3),
    };
    const ready = await client.init(config);
    const ticks: number[] = [];
    client.onCrew((_, crew) => ticks.push(crew.tick));
    client.setAlgae(1);
    for (let t = 1; t <= 40; t++) await stepCollecting(client, 1, t);
    expect(ticks).toEqual([STEP_HZ]);
    const gone = await client.removeFish('cherry-shrimp-0');
    expect(gone.epoch).toBe(ready.epoch + 1);
    expect(ticks).toEqual([STEP_HZ, 40]);
  });

  it('passes on crew tallies of the current world only', async () => {
    const worker = fakeWorker();
    const client = new SimClient(worker.port);
    const seen: CrewTally[] = [];
    client.onCrew((tally) => seen.push(...tally));
    const entry: CrewTally = { fishId: 'cherry-shrimp-0', algaeM2: 1e-5, settledPortions: 0 };
    const first = client.init(benchmarkConfig(1));
    worker.ready(1);
    await first;
    worker.post({ type: 'crew', epoch: 0, tick: 30, tally: [entry] });
    expect(seen).toEqual([]);
    worker.post({ type: 'crew', epoch: 1, tick: 30, tally: [entry] });
    expect(seen).toEqual([entry]);
    const second = client.init(benchmarkConfig(2));
    worker.post({ type: 'crew', epoch: 1, tick: 60, tally: [entry] });
    expect(seen).toEqual([entry]);
    client.dispose();
    await expect(second).rejects.toThrow(/client disposed/);
  });

  it('passes on polyp extensions of the current world only', async () => {
    const worker = fakeWorker();
    const client = new SimClient(worker.port);
    const seen: number[] = [];
    client.onPolyps((extension) => seen.push(extension));
    const first = client.init(benchmarkConfig(1));
    worker.ready(1);
    await first;
    worker.post({ type: 'polyps', epoch: 0, tick: 30, extension: 0.25 });
    expect(seen).toEqual([]);
    worker.post({ type: 'polyps', epoch: 1, tick: 30, extension: 0.5 });
    expect(seen).toEqual([0.5]);
    const second = client.init(benchmarkConfig(2));
    worker.post({ type: 'polyps', epoch: 1, tick: 60, extension: 0.75 });
    expect(seen).toEqual([0.5]);
    client.dispose();
    await expect(second).rejects.toThrow(/client disposed/);
  });

  it('rejects bad food as a whole, keeps the previous food, and refuses food before init', async () => {
    const { client } = connect();
    const early = nextError(client);
    client.setFood(flakeGrid(1));
    expect(await early).toMatch(/"food" before "init"/);

    const config = benchmarkConfig(6);
    await client.init(config);
    const food = flakeGrid(20);
    client.setFood(food);
    const poisoned = food.slice();
    poisoned[3 * FOOD_STRIDE + 2] = Number.NaN;
    const bad = nextError(client);
    client.setFood(poisoned);
    expect(await bad).toMatch(/finite/);
    expect(() => client.setFood(new Float32Array(7))).toThrow(/multiple of 5/);
    const { snapshot } = await stepCollecting(client, 60, 60);

    const local = new World(config);
    local.setFood(food);
    for (let t = 0; t < 60; t++) local.step();
    const data = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(data);
    expect(Array.from(snapshot.data)).toEqual(Array.from(data));
  });

  it('drops ate events from a world that a pending or completed init replaced', async () => {
    const { port, post, ready } = fakeWorker();
    const client = new SimClient(port);
    const ate = (epoch: number, foodId: number): unknown => ({
      type: 'ate',
      epoch,
      tick: 1,
      events: [{ fishId: 'f', foodId, portion: 0.025 }],
    });
    const seen: number[] = [];
    client.onAte((events) => seen.push(...events.map((e) => e.foodId)));

    const first = client.init(benchmarkConfig(1));
    post(ate(0, 1));
    ready(1);
    await first;
    post(ate(1, 2));
    const second = client.init(benchmarkConfig(1));
    post(ate(1, 3));
    ready(2);
    await second;
    post(ate(1, 4));
    post(ate(2, 5));
    expect(seen).toEqual([2, 5]);
  });

  it('tags a re-init with a new epoch so the interpolator restarts cleanly', async () => {
    const { client } = connect();
    const interp = new SnapshotInterpolator(1 / 30);
    client.onSnapshot((s) => interp.push(s, performance.now()));
    const out = new Float32Array(benchmarkConfig(1).fish.length * SNAPSHOT_STRIDE);

    const firstInitial = nextSnapshot(client);
    const firstReady = await client.init(benchmarkConfig(1));
    await firstInitial;
    const stepped = nextSnapshot(client);
    client.step(30);
    const before = await stepped;
    expect(before.epoch).toBe(firstReady.epoch);
    expect(before.tick).toBe(30);

    const initial = nextSnapshot(client);
    const secondReady = await client.init(benchmarkConfig(2));
    expect(secondReady.epoch).toBeGreaterThan(firstReady.epoch);
    const restarted = await initial;
    expect(restarted.epoch).toBe(secondReady.epoch);
    expect(restarted.tick).toBe(0);

    const next = nextSnapshot(client);
    client.step(1);
    const one = await next;
    expect(interp.sample(performance.now() + 1000, out)).toBe(true);
    expect(out[0]).toBeCloseTo(one.data[0] ?? NaN, 6);
  });

  it('reports a failure inside the running clock instead of dying silently', async () => {
    let calls = 0;
    const { client } = connect({
      now: () => {
        calls++;
        if (calls > 1) throw new Error('clock exploded');
        return 0;
      },
    });
    await client.init(benchmarkConfig(1));
    const failed = nextError(client);
    client.start();
    expect(await failed).toBe('clock exploded');
  });

  it('rejects init when the config is invalid', async () => {
    const { client } = connect();
    const config = benchmarkConfig(1);
    await expect(
      client.init({ ...config, fish: [{ id: 'x', species: 'unknown-fish' }] }),
    ).rejects.toThrow(/unknown species/);
  });
  it('refuses an init without a safe integer request and keeps the current world', async () => {
    const { client, clientPort } = connect();
    const config = benchmarkConfig(1);
    const ready = await client.init(config);
    for (const request of [undefined, '7', 1.5, Number.NaN, 2 ** 53]) {
      const refused = nextError(client);
      clientPort.postMessage({ type: 'init', request, config: benchmarkConfig(2) });
      expect(await refused).toMatch(/"init" needs a safe integer request/);
    }
    const after = nextSnapshot(client);
    client.step(1);
    const snapshot = await after;
    expect(snapshot.epoch).toBe(ready.epoch);
    expect(snapshot.tick).toBe(1);
    expect(snapshot.data.length).toBe(config.fish.length * SNAPSHOT_STRIDE);
  });

  it('adds and removes fish in place under a new epoch, as a local world would', async () => {
    const { client } = connect();
    const config = benchmarkConfig(4);
    const ready = await client.init(config);
    const local = new World(config);
    client.setFood(flakeGrid(30));
    local.setFood(flakeGrid(30));
    await stepCollecting(client, 30, 30);
    for (let t = 0; t < 30; t++) local.step();
    local.takeAteEvents();

    const spawn = { id: 'newcomer', species: 'yellow-tang' };
    const at = { position: [0.3, 0.4, 0.15] as const, heading: 1 };
    const added = nextSnapshot(client);
    const layout = await client.addFish(spawn, at);
    local.addFish(spawn, at);
    expect(layout.epoch).toBe(ready.epoch + 1);
    expect(layout.change).toEqual({ kind: 'add', id: 'newcomer' });
    expect(layout.fishIds).toEqual([...ready.fishIds, 'newcomer']);
    expect(layout.stride).toBe(SNAPSHOT_STRIDE);
    const afterAdd = await added;
    expect(afterAdd.epoch).toBe(layout.epoch);
    expect(afterAdd.tick).toBe(30);
    expect(afterAdd.data.length).toBe(layout.fishIds.length * SNAPSHOT_STRIDE);

    const removed = nextSnapshot(client);
    const second = await client.removeFish('neon-tetra-3');
    local.removeFish('neon-tetra-3');
    expect(second.epoch).toBe(layout.epoch + 1);
    expect(second.change).toEqual({ kind: 'remove', id: 'neon-tetra-3' });
    expect(second.fishIds).toEqual(layout.fishIds.filter((id) => id !== 'neon-tetra-3'));
    expect((await removed).data.length).toBe(second.fishIds.length * SNAPSHOT_STRIDE);

    const { snapshot, ate } = await stepCollecting(client, 60, 90);
    const expected: AteEvent[] = [];
    for (let t = 0; t < 60; t++) {
      local.step();
      expected.push(...local.takeAteEvents());
    }
    expect(snapshot.epoch).toBe(second.epoch);
    expect(expected.length).toBeGreaterThan(0);
    expect(ate.flatMap((a) => a.events)).toEqual(expected);
    const data = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(data);
    expect(Array.from(snapshot.data)).toEqual(Array.from(data));
  });

  it('rejects a bad add or remove with its own error and keeps the world running', async () => {
    const { client } = connect();
    await expect(client.removeFish('ghost')).rejects.toThrow(/"removeFish" before "init"/);
    const ready = await client.init(benchmarkConfig(1));
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const ghost = client.removeFish('ghost');
    const twin = client.addFish({ id: 'neon-tetra-0', species: 'neon-tetra' });
    const fine = client.addFish({ id: 'cory-x', species: 'bronze-corydoras' });
    await expect(ghost).rejects.toThrow(/no fish "ghost"/);
    await expect(twin).rejects.toThrow(/already in the world/);
    const layout = await fine;
    expect(layout.epoch).toBe(ready.epoch + 1);
    expect(layout.fishIds).toEqual([...ready.fishIds, 'cory-x']);
    // Each caller has its error; nothing else is told.
    expect(errors).toEqual([]);
  });

  it('passes on bites across a layout change and drops those from an older epoch', () => {
    const { port, post, sent, ready } = fakeWorker();
    const client = new SimClient(port);
    const ate = (epoch: number, foodId: number): unknown => ({
      type: 'ate',
      epoch,
      tick: 1,
      events: [{ fishId: 'f', foodId, portion: 0.025 }],
    });
    const seen: number[] = [];
    client.onAte((events) => seen.push(...events.map((e) => e.foodId)));
    void client.init(benchmarkConfig(1));
    ready(1, ['f']);

    void client.removeFish('g');
    const request = (sent.at(-1) as { request: number }).request;
    post(ate(1, 1));
    post({
      type: 'layout',
      epoch: 2,
      request,
      fishIds: ['f'],
      stride: SNAPSHOT_STRIDE,
      change: { kind: 'remove', id: 'g' },
    });
    post(ate(1, 2));
    post(ate(2, 3));
    expect(seen).toEqual([1, 3]);
    expect(() =>
      post({
        type: 'layout',
        epoch: 3,
        request: request + 99,
        fishIds: [],
        stride: 11,
        change: {},
      }),
    ).toThrow(/unknown request/);
  });

  it('sends bites taken before a layout change in the old epoch, ahead of the layout', async () => {
    const { client, clientPort } = connect();
    const ready = await client.init(benchmarkConfig(5));
    const seen: { type: string; epoch: number; tick: number }[] = [];
    clientPort.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type: string; epoch: number; tick?: number };
      seen.push({ type: data.type, epoch: data.epoch, tick: data.tick ?? -1 });
    });
    client.setFood(flakeGrid(30));
    client.step(90);
    const layout = await client.removeFish('neon-tetra-0');
    // A fresh meal, so bites in the new epoch do not hinge on the old one having leftovers.
    client.setFood(flakeGrid(30, 1000));
    await stepCollecting(client, 30, 120);

    const at = seen.findIndex((m) => m.type === 'layout');
    expect(at).toBeGreaterThan(0);
    const before = seen.slice(0, at);
    const after = seen.slice(at + 1);
    expect(before.some((m) => m.type === 'ate')).toBe(true);
    expect(before.every((m) => m.epoch === layout.epoch - 1 && m.epoch === ready.epoch)).toBe(true);
    expect(after[0]).toEqual({ type: 'snapshot', epoch: layout.epoch, tick: 90 });
    expect(after.some((m) => m.type === 'ate')).toBe(true);
    expect(after.every((m) => m.epoch === layout.epoch)).toBe(true);
  });

  it('still sends bites stranded by a step that threw in the old epoch, ahead of the layout', async () => {
    const { client, clientPort } = connect();
    const ready = await client.init(benchmarkConfig(5));
    const seen: { type: string; epoch: number }[] = [];
    clientPort.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type: string; epoch: number };
      seen.push({ type: data.type, epoch: data.epoch });
    });
    const step = World.prototype.step;
    let calls = 0;
    const spy = vi.spyOn(World.prototype, 'step').mockImplementation(function (this: World) {
      if (++calls === 90) throw new Error('step exploded');
      step.call(this);
    });
    try {
      client.setFood(flakeGrid(30));
      const failed = nextError(client);
      client.step(90);
      expect(await failed).toBe('step exploded');
    } finally {
      spy.mockRestore();
    }
    // The throw skipped the snapshot that would have carried these bites.
    expect(seen.some((m) => m.type === 'ate')).toBe(false);

    const layout = await client.removeFish('neon-tetra-0');
    const at = seen.findIndex((m) => m.type === 'layout');
    expect(seen.slice(0, at)).toContainEqual({ type: 'ate', epoch: ready.epoch });
    expect(layout.epoch).toBe(ready.epoch + 1);
    expect(seen.slice(at + 1).some((m) => m.type === 'ate')).toBe(false);
  });

  it('never lets an error for an add or remove reject a pending init', async () => {
    const { port, post, ready } = fakeWorker();
    const client = new SimClient(port);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const init = client.init(benchmarkConfig(1));
    post({ type: 'error', message: 'stale remove', request: 41 });
    ready(1);
    await expect(init).resolves.toMatchObject({ type: 'ready', epoch: 1 });
    expect(errors).toEqual(['stale remove']);
  });

  it('rejects pending adds and removes when the client is disposed', async () => {
    const client = new SimClient({
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const pending = client.addFish({ id: 'x', species: 'neon-tetra' });
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('answers canGrazeAt as a local world would, without changing the world', async () => {
    const { client } = connect();
    const config: WorldConfig = {
      seed: 3,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: REEF_DECOR,
      fish: spawnMany(yellowTang.id, 2),
    };
    const local = new World(config);
    await client.init(config);
    const spots: Point3[] = [
      [0.55, 0.15, -0.29],
      [0.55, 0.25, -0.29],
      [0, 0.3, 0],
      [0.55, 0.1, -0.12],
    ];
    for (const species of [yellowTang.id, blueTang.id]) {
      for (const at of spots) {
        expect(await client.canGrazeAt(species, at)).toBe(local.canGrazeAt(species, ...at));
      }
    }
    expect(await client.canGrazeAt(yellowTang.id, [0.55, 0.15, -0.29])).toBe(false);
    expect(await client.canGrazeAt(yellowTang.id, [0.55, 0.25, -0.29])).toBe(true);

    const { snapshot } = await stepCollecting(client, 30, 30);
    for (let t = 0; t < 30; t++) local.step();
    const data = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(data);
    expect(Array.from(snapshot.data)).toEqual(Array.from(data));
  });

  it('rejects a bad canGrazeAt with its own error and keeps answering', async () => {
    const { client } = connect();
    await expect(client.canGrazeAt(yellowTang.id, [0, 0.3, 0])).rejects.toThrow(
      /"canGrazeAt" before "init"/,
    );
    await client.init(benchmarkConfig(1));
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const unknown = client.canGrazeAt('no-such-fish', [0, 0.3, 0]);
    const nan = client.canGrazeAt('neon-tetra', [Number.NaN, 0.3, 0]);
    const fine = client.canGrazeAt('neon-tetra', [0, 0.25, 0]);
    await expect(unknown).rejects.toThrow(/unknown species "no-such-fish"/);
    await expect(nan).rejects.toThrow(/must be finite/);
    await expect(fine).resolves.toBe(true);
    expect(errors).toEqual([]);
  });

  it('rejects pending canGrazeAt queries when the client is disposed', async () => {
    const client = new SimClient({
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const pending = client.canGrazeAt('neon-tetra', [0, 0.3, 0]);
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('answers nestSite and applies brood and stage changes as a local world would', async () => {
    const { client } = connect();
    const config: WorldConfig = {
      seed: 5,
      tank: REEF_TANK,
      species: [...ARCHETYPES, guppy],
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: [
        { id: 'm', species: clownfish.id, sex: 'male' },
        { id: 'f', species: clownfish.id, sex: 'female' },
        { id: 'g', species: guppy.id, sex: 'female' },
        { id: 'fry', species: guppy.id, stage: 'fry', bodyLengthM: 0.007 },
      ],
    };
    const local = new World(config);
    await client.init(config);
    const site = await client.nestSite(['m', 'f']);
    expect(site).toEqual(local.nestSite(['m', 'f']));
    if (site === null) throw new Error('no nest site beside the anemone');
    const brood = {
      clutches: [{ id: 'c', parents: ['m', 'f'], position: site }],
      gravid: [{ fishId: 'g', term: 0.9 }],
    };
    client.setBrood(brood);
    client.setStage('fry', 'juvenile');
    local.setBrood(brood);
    local.setStage('fry', 'juvenile');
    const { snapshot } = await stepCollecting(client, 60, 60);
    for (let t = 0; t < 60; t++) local.step();
    const data = new Float32Array(local.count * SNAPSHOT_STRIDE);
    local.writeSnapshot(data);
    expect(Array.from(snapshot.data)).toEqual(Array.from(data));
  });

  it('rejects a bad nestSite with its own error and keeps answering', async () => {
    const { client } = connect();
    await expect(client.nestSite(['m'])).rejects.toThrow(/"nestSite" before "init"/);
    await client.init({
      seed: 5,
      tank: REEF_TANK,
      species: ARCHETYPES,
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: spawnMany(clownfish.id, 2),
    });
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const unknown = client.nestSite(['ghost']);
    const fine = client.nestSite([`${clownfish.id}-0`]);
    await expect(unknown).rejects.toThrow(/no fish "ghost"/);
    await expect(fine).resolves.toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it('rejects pending nestSite queries when the client is disposed', async () => {
    const client = new SimClient({
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const pending = client.nestSite(['m']);
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('tells the listeners only of errors no request is waiting for', async () => {
    const { port, post, sent, initRequest } = fakeWorker();
    const client = new SimClient(port);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const init = client.init(benchmarkConfig(1));
    post({ type: 'error', message: 'bad config', request: initRequest() });
    await expect(init).rejects.toThrow('bad config');
    const query = client.canGrazeAt('neon-tetra', [0, 0.3, 0]);
    const request = (sent.at(-1) as { request: number }).request;
    post({ type: 'error', message: 'unknown species', request });
    await expect(query).rejects.toThrow('unknown species');
    expect(errors).toEqual([]);
    post({ type: 'error', message: 'clock exploded' });
    expect(errors).toEqual(['clock exploded']);
  });

  for (const [event, failure, expected] of [
    ['error', { message: 'Uncaught SyntaxError' }, 'sim worker failed: Uncaught SyntaxError'],
    ['error', {}, 'sim worker failed'],
    ['messageerror', { data: null }, 'sim: a message from the worker could not be read'],
  ] as const) {
    it(`rejects every pending request and reports a worker ${event} ${JSON.stringify(failure)}`, async () => {
      const { port, emit, ready } = fakeWorker();
      const client = new SimClient(port);
      const errors: string[] = [];
      client.onError((m) => errors.push(m));
      const init = client.init(benchmarkConfig(1));
      ready(1, ['f']);
      await init;
      const reinit = client.init(benchmarkConfig(2));
      const add = client.addFish({ id: 'x', species: 'neon-tetra' });
      const remove = client.removeFish('f');
      const query = client.canGrazeAt('neon-tetra', [0, 0.3, 0]);
      emit(event, failure);
      for (const pending of [reinit, add, remove, query]) {
        await expect(pending).rejects.toThrow(expected);
      }
      expect(errors).toEqual([expected]);
      // Nothing is left pending, so a new init can go out.
      const again = client.init(benchmarkConfig(3));
      ready(2);
      await expect(again).resolves.toMatchObject({ epoch: 2 });
    });
  }

  it('drops late replies to requests a worker failure rejected, keeping the epoch', async () => {
    const { port, post, emit, sent, ready } = fakeWorker();
    const client = new SimClient(port);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const seen: number[] = [];
    client.onAte((events) => seen.push(...events.map((e) => e.foodId)));
    const ate = (epoch: number, foodId: number): unknown => ({
      type: 'ate',
      epoch,
      tick: 1,
      events: [{ fishId: 'f', foodId, portion: 0.025 }],
    });
    void client.init(benchmarkConfig(1));
    ready(1, ['f']);
    const lastRequest = (): number => (sent.at(-1) as { request: number }).request;
    const add = client.addFish({ id: 'x', species: 'neon-tetra' });
    const addRequest = lastRequest();
    const remove = client.removeFish('f');
    const removeRequest = lastRequest();
    const query = client.canGrazeAt('neon-tetra', [0, 0.3, 0]);
    const queryRequest = lastRequest();
    emit('messageerror', { data: null });
    for (const pending of [add, remove, query]) await expect(pending).rejects.toThrow();

    const late = [
      {
        type: 'layout',
        epoch: 2,
        request: addRequest,
        fishIds: ['f', 'x'],
        stride: SNAPSHOT_STRIDE,
        change: { kind: 'add', id: 'x' },
      },
      { type: 'error', message: 'no fish "f"', request: removeRequest },
      { type: 'grazeReach', request: queryRequest, reachable: true },
    ];
    for (const reply of late) expect(() => post(reply)).not.toThrow();
    post(ate(1, 1));
    post(ate(2, 2));
    expect(seen).toEqual([2]);
    expect(errors).toEqual(['sim: a message from the worker could not be read']);

    // Each is dropped once; a second reply to the same request is as wrong as any other.
    expect(() => post(late[0])).toThrow(/layout for unknown request/);
    expect(() => post(late[2])).toThrow(/grazeReach for unknown request/);
    post(late[1]);
    expect(errors.at(-1)).toBe('no fish "f"');
  });

  it('never resolves a newer init with the late ready of one a worker failure rejected', async () => {
    const { port, post, emit, ready, initRequest } = fakeWorker();
    const client = new SimClient(port);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const seen: number[] = [];
    client.onAte((events) => seen.push(...events.map((e) => e.foodId)));
    const ate = (epoch: number, foodId: number): unknown => ({
      type: 'ate',
      epoch,
      tick: 1,
      events: [{ fishId: 'b', foodId, portion: 0.025 }],
    });

    const a = client.init(benchmarkConfig(1));
    const aRequest = initRequest();
    emit('messageerror', { data: null });
    await expect(a).rejects.toThrow(/could not be read/);
    const b = client.init(benchmarkConfig(2));
    let settled = false;
    void b.then(() => (settled = true));

    const staleReady = {
      type: 'ready',
      request: aRequest,
      epoch: 1,
      fishIds: ['a'],
      stride: SNAPSHOT_STRIDE,
      stepHz: STEP_HZ,
    };
    expect(() => post(staleReady)).not.toThrow();
    await Promise.resolve();
    expect(settled).toBe(false);
    post(ate(1, 1));

    ready(2, ['b']);
    await expect(b).resolves.toMatchObject({ epoch: 2, fishIds: ['b'] });
    post(ate(1, 2));
    post(ate(2, 3));
    expect(seen).toEqual([3]);
    expect(() => post(staleReady)).toThrow(/ready for unknown request/);
    expect(errors).toEqual(['sim: a message from the worker could not be read']);
  });

  it('drops the late error of an init a worker failure rejected', async () => {
    const { port, post, emit, ready, initRequest } = fakeWorker();
    const client = new SimClient(port);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const a = client.init(benchmarkConfig(1));
    const aRequest = initRequest();
    emit('error', { message: 'boom' });
    await expect(a).rejects.toThrow('boom');
    const b = client.init(benchmarkConfig(2));
    post({ type: 'error', message: 'bad config', request: aRequest });
    ready(2);
    await expect(b).resolves.toMatchObject({ epoch: 2 });
    expect(errors).toEqual(['sim worker failed: boom']);
  });

  it('leaves a pending init to its own answer when the worker reports an error of its own', async () => {
    const { port, post, ready } = fakeWorker();
    const client = new SimClient(port);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const init = client.init(benchmarkConfig(1));
    post({ type: 'error', message: 'step loop failed' });
    ready(1);
    await expect(init).resolves.toMatchObject({ epoch: 1 });
    expect(errors).toEqual(['step loop failed']);
  });

  it('echoes the init request in ready and in an init error', async () => {
    const { client, clientPort } = connect();
    const seen: unknown[] = [];
    clientPort.addEventListener('message', (event: MessageEvent) => {
      const { type, request } = event.data as { type: string; request?: number };
      if (type === 'ready' || type === 'error') seen.push({ type, request });
    });
    const config = benchmarkConfig(1);
    await expect(
      client.init({ ...config, fish: [{ id: 'x', species: 'unknown-fish' }] }),
    ).rejects.toThrow(/unknown-fish/);
    await client.init(config);
    expect(seen).toEqual([
      { type: 'error', request: expect.any(Number) as number },
      { type: 'ready', request: expect.any(Number) as number },
    ]);
    const [failed, ok] = seen as [{ request: number }, { request: number }];
    expect(ok.request).not.toBe(failed.request);
  });

  it('stops listening to the worker once disposed', () => {
    const { port, emit, listening } = fakeWorker();
    const client = new SimClient(port);
    expect(listening()).toBe(3);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    client.dispose();
    expect(listening()).toBe(0);
    emit('error', { message: 'late' });
    expect(errors).toEqual([]);
  });
});
