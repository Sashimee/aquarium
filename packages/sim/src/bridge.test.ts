import { afterEach, describe, expect, it } from 'vitest';
import { createSimHost, SimClient, type SimHost } from './bridge.ts';
import { benchmarkConfig } from './fixtures.ts';
import { SNAPSHOT_STRIDE, SnapshotField, type Snapshot } from './snapshot.ts';
import { STEP_HZ, World } from './world.ts';

interface Harness {
  host: SimHost;
  client: SimClient;
  hostPort: MessagePort;
  clientPort: MessagePort;
}

const open: Harness[] = [];

function connect(): Harness {
  const channel = new MessageChannel();
  const host = createSimHost(channel.port1);
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

  it('rejects init when the config is invalid', async () => {
    const { client } = connect();
    const config = benchmarkConfig(1);
    await expect(
      client.init({ ...config, fish: [{ id: 'x', species: 'unknown-fish' }] }),
    ).rejects.toThrow(/unknown species/);
  });
});
