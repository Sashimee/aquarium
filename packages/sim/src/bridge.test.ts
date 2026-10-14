import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Anchor } from './behaviour.ts';
import {
  createSimHost,
  SimClient,
  type SimAte,
  type SimHost,
  type SimHostOptions,
} from './bridge.ts';
import type { Collider } from '@aquarium/shared';
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
    let deliver: ((event: MessageEvent) => void) | null = null;
    const client = new SimClient({
      postMessage: () => undefined,
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: () => undefined,
    });
    const post = (data: unknown): void => deliver?.({ data } as MessageEvent);
    const ready = (epoch: number): unknown => ({
      type: 'ready',
      epoch,
      fishIds: [],
      stride: SNAPSHOT_STRIDE,
      stepHz: STEP_HZ,
    });
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
    post(ready(1));
    await first;
    post(ate(1, 2));
    const second = client.init(benchmarkConfig(1));
    post(ate(1, 3));
    post(ready(2));
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
    expect(errors).toHaveLength(2);
  });

  it('passes on bites across a layout change and drops those from an older epoch', () => {
    let deliver: ((event: MessageEvent) => void) | null = null;
    const sent: unknown[] = [];
    const client = new SimClient({
      postMessage: (message) => sent.push(message),
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: () => undefined,
    });
    const post = (data: unknown): void => deliver?.({ data } as MessageEvent);
    const ate = (epoch: number, foodId: number): unknown => ({
      type: 'ate',
      epoch,
      tick: 1,
      events: [{ fishId: 'f', foodId, portion: 0.025 }],
    });
    const seen: number[] = [];
    client.onAte((events) => seen.push(...events.map((e) => e.foodId)));
    post({ type: 'ready', epoch: 1, fishIds: ['f'], stride: SNAPSHOT_STRIDE, stepHz: STEP_HZ });

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
    let deliver: ((event: MessageEvent) => void) | null = null;
    const client = new SimClient({
      postMessage: () => undefined,
      addEventListener: (_type, listener) => {
        deliver = listener;
      },
      removeEventListener: () => undefined,
    });
    const post = (data: unknown): void => deliver?.({ data } as MessageEvent);
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    const init = client.init(benchmarkConfig(1));
    post({ type: 'error', message: 'stale remove', request: 41 });
    post({ type: 'ready', epoch: 1, fishIds: [], stride: SNAPSHOT_STRIDE, stepHz: STEP_HZ });
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
});
