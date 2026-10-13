import { afterEach, describe, expect, it } from 'vitest';
import type { Anchor } from './behaviour.ts';
import {
  createSimHost,
  SimClient,
  type SimAte,
  type SimHost,
  type SimHostOptions,
} from './bridge.ts';
import type { DecorCollider } from './decor.ts';
import { benchmarkConfig, REEF_ANCHORS, REEF_DECOR } from './fixtures.ts';
import { FOOD_STRIDE, FOOD_TYPES, type AteEvent } from './food.ts';
import { SNAPSHOT_STRIDE, SnapshotField, SnapshotInterpolator, type Snapshot } from './snapshot.ts';
import { STEP_HZ, World } from './world.ts';

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

function flakeGrid(count: number): Float32Array {
  const records = new Float32Array(count * FOOD_STRIDE);
  for (let k = 0; k < count; k++) {
    records.set(
      [
        k + 1,
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

  it('reports scene commands before init and invalid scene values as errors', async () => {
    const { client } = connect();
    const early = nextError(client);
    client.setLight(1);
    expect(await early).toMatch(/"light" before "init"/);

    await client.init(benchmarkConfig(1));
    const dark = nextError(client);
    client.setLight(2);
    expect(await dark).toMatch(/light level/);
    const tap = nextError(client);
    client.startle({ position: [0, 0.2, 0], intensity: 3 });
    expect(await tap).toMatch(/intensity/);
    const twins = nextError(client);
    client.setDecor([...REEF_DECOR, ...REEF_DECOR.slice(0, 1)]);
    expect(await twins).toMatch(/unique/);
    const cone = nextError(client);
    const forgedDecor = { id: 'cone', solid: true, shape: { kind: 'cone' } } as unknown;
    client.setDecor([forgedDecor as DecorCollider]);
    expect(await cone).toMatch(/decor "cone": unknown shape kind/);
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
});
