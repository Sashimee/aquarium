import { afterEach, describe, expect, it } from 'vitest';
import {
  createSimHost,
  SimClient,
  SNAPSHOT_STRIDE,
  SnapshotField,
  STEP_DT,
  type SimHost,
  type Snapshot,
} from '@aquarium/sim';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank } from './demoStock';
import { TankRoster } from './roster';
import { SimStream } from './simStream';
import { SimWorldSpec } from './simWorld';

const STEP_MS = STEP_DT * 1000;

/** One record per fish: x carries the value, the quaternion is identity. */
function snapshot(epoch: number, tick: number, xs: readonly number[]): Snapshot {
  const data = new Float32Array(xs.length * SNAPSHOT_STRIDE);
  xs.forEach((x, i) => {
    data[i * SNAPSHOT_STRIDE + SnapshotField.PosX] = x;
    data[i * SNAPSHOT_STRIDE + SnapshotField.QuatW] = 1;
  });
  return { epoch, tick, time: tick * STEP_DT, data };
}

function setup(): { stream: SimStream; recycled: Snapshot[] } {
  const recycled: Snapshot[] = [];
  return { stream: new SimStream(STEP_DT, (s) => recycled.push(s)), recycled };
}

/** The x of every fish in the stream's layout at `nowMs`, by id. */
function xs(stream: SimStream, nowMs: number): Record<string, number> {
  const frame = stream.sample(nowMs);
  const layout = stream.layout;
  if (frame === null || layout === null) throw new Error('nothing to sample');
  const out: Record<string, number> = {};
  for (const [id, o] of layout.offsets) out[id] = frame[o + SnapshotField.PosX] ?? NaN;
  return out;
}

/** A world of a, b, c streaming x = 1, 2, 3 at tick 0 and moving +1 per tick; sampled mid-step. */
function running(): { stream: SimStream; recycled: Snapshot[]; now: number } {
  const { stream, recycled } = setup();
  stream.begin(1, ['a', 'b', 'c']);
  stream.push(snapshot(1, 0, [1, 2, 3]), 0);
  stream.push(snapshot(1, 1, [2, 3, 4]), STEP_MS);
  return { stream, recycled, now: STEP_MS * 1.5 };
}

describe('SimStream', () => {
  it('shows nothing until the announced world sends its first snapshot', () => {
    const { stream, recycled } = setup();
    const early = snapshot(1, 0, [1]);
    stream.push(early, 0);
    expect(stream.sample(0)).toBeNull();
    expect(recycled).toEqual([early]);

    stream.begin(1, ['a']);
    stream.push(snapshot(1, 1, [5]), 0);
    expect(xs(stream, 0)).toEqual({ a: 5 });
  });

  it('keeps every other fish continuous when one is added', () => {
    const { stream, now } = running();
    const before = xs(stream, now);
    expect(before).toEqual({ a: 1.5, b: 2.5, c: 3.5 });

    stream.change(2, ['a', 'b', 'c', 'd']);
    stream.push(snapshot(2, 1, [2, 3, 4, 9]), now);
    expect(stream.layout?.offsets.get('d')).toBe(3 * SNAPSHOT_STRIDE);
    expect(xs(stream, now)).toEqual({ ...before, d: 9 });

    stream.push(snapshot(2, 2, [3, 4, 5, 10]), STEP_MS * 2);
    expect(xs(stream, STEP_MS * 2.5)).toEqual({ a: 2.5, b: 3.5, c: 4.5, d: 9.5 });
  });

  it('leaves the render clock where it was, mid-slew, when a fish is added', () => {
    const { stream } = running();
    stream.push(snapshot(1, 2, [3, 4, 5]), STEP_MS * 2 - 15);
    const now = STEP_MS * 2 + 15;
    const before = xs(stream, now);

    stream.change(2, ['a', 'b', 'c', 'd']);
    stream.push(snapshot(2, 2, [3, 4, 5, 9]), now);
    const { a, b, c } = xs(stream, now);
    expect({ a, b, c }).toEqual(before);
  });

  it('keeps every other fish continuous when one is removed, records shifted down', () => {
    const { stream, now } = running();
    const before = xs(stream, now);

    stream.change(2, ['b', 'c']);
    stream.push(snapshot(2, 1, [3, 4]), now);
    expect(stream.layout?.offsets.get('b')).toBe(0);
    expect(stream.layout?.offsets.get('c')).toBe(SNAPSHOT_STRIDE);
    expect(stream.layout?.offsets.has('a')).toBe(false);
    expect(xs(stream, now)).toEqual({ b: before.b, c: before.c });

    stream.push(snapshot(2, 2, [4, 5]), STEP_MS * 2);
    expect(xs(stream, STEP_MS * 2.5)).toEqual({ b: 3.5, c: 4.5 });
  });

  it('reads old-epoch snapshots in the old layout until the new one arrives', () => {
    const { stream } = running();
    stream.change(2, ['b', 'c']);
    stream.push(snapshot(1, 2, [3, 4, 5]), STEP_MS * 2);
    expect(stream.layout?.epoch).toBe(1);
    expect(xs(stream, STEP_MS * 3)).toEqual({ a: 3, b: 4, c: 5 });

    stream.push(snapshot(2, 2, [4, 5]), STEP_MS * 3);
    expect(xs(stream, STEP_MS * 3)).toEqual({ b: 4, c: 5 });
  });

  it('never reads a stale or unannounced epoch into the current layout', () => {
    const { stream, recycled, now } = running();
    stream.change(2, ['b', 'c']);
    stream.push(snapshot(2, 1, [3, 4]), now);
    const shown = xs(stream, now);

    const late = snapshot(1, 2, [100, 200, 300]);
    stream.push(late, now);
    const unknown = snapshot(5, 2, [100, 200]);
    stream.push(unknown, now);
    expect(xs(stream, now)).toEqual(shown);
    expect(stream.layout?.epoch).toBe(2);
    expect(recycled).toContain(late);
    expect(recycled).toContain(unknown);
  });

  it('never falls back to an older epoch announced after a newer one took over', () => {
    const { stream, recycled, now } = running();
    stream.change(3, ['b', 'c']);
    stream.push(snapshot(3, 1, [3, 4]), now);
    const shown = xs(stream, now);

    stream.change(2, ['a', 'b', 'c', 'd']);
    const stale = snapshot(2, 2, [100, 200, 300, 400]);
    stream.push(stale, now);
    expect(stream.layout?.epoch).toBe(3);
    expect(xs(stream, now)).toEqual(shown);
    expect(recycled).toContain(stale);
  });

  it('starts a new world afresh, carrying nothing over', () => {
    const { stream, now } = running();
    stream.reset();
    expect(stream.sample(now)).toBeNull();
    stream.begin(3, ['a', 'b', 'c']);
    stream.push(snapshot(3, 0, [7, 8, 9]), now);
    expect(xs(stream, now)).toEqual({ a: 7, b: 8, c: 9 });
  });

  it('ignores a change that was in flight when the world was dropped', () => {
    const { stream, now } = running();
    stream.reset();
    stream.change(2, ['a', 'b']);
    stream.push(snapshot(2, 1, [2, 3]), now);
    expect(stream.layout).toBeNull();
    expect(stream.sample(now)).toBeNull();
  });

  it('hands every snapshot it lets go of back for recycling, once', () => {
    const { stream, recycled, now } = running();
    stream.change(2, ['a', 'c']);
    const fresh = snapshot(2, 1, [2, 4]);
    stream.push(fresh, now);
    stream.push(snapshot(2, 2, [3, 5]), STEP_MS * 2);
    stream.push(snapshot(2, 3, [4, 6]), STEP_MS * 3);
    expect(recycled).toContain(fresh);
    expect(new Set(recycled).size).toBe(recycled.length);
    expect(recycled.filter((s) => s.epoch === 1)).toHaveLength(2);
  });

  it('rejects a snapshot whose size does not fit its layout, and recycles it', () => {
    const { stream, recycled } = setup();
    stream.begin(1, ['a', 'b']);
    const misfit = snapshot(1, 0, [1]);
    expect(() => stream.push(misfit, 0)).toThrow(new RegExp(`needs ${2 * SNAPSHOT_STRIDE}\\b`));
    expect(recycled).toEqual([misfit]);
  });
});

describe('SimStream over a real sim worker port', () => {
  const hosts: SimHost[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
  });

  function nextSnapshot(client: SimClient, tick: number): Promise<void> {
    return new Promise((resolve) => {
      const off = client.onSnapshot((s) => {
        if (s.tick < tick) return;
        off();
        resolve();
      });
    });
  }

  it('moves the other fish on without a jump across an add and a remove', async () => {
    const demo = demoTank(DEFAULT_TANK, 7, 'freshwater');
    const roster = new TankRoster(demo.config.fish);
    const config = new SimWorldSpec(demo, 7).config(roster.swimming());
    if (config === null) throw new Error('the freshwater demo stock has no world');

    const channel = new MessageChannel();
    hosts.push(createSimHost(channel.port1));
    const client = new SimClient(channel.port2);
    const stream = new SimStream(STEP_DT, (s) => client.recycle(s));
    let clock = 0;
    client.onSnapshot((s) => stream.push(s, clock));

    const ready = await client.init(config);
    stream.begin(ready.epoch, ready.fishIds);
    for (let tick = 1; tick <= 3; tick++) {
      clock = tick * STEP_MS;
      client.step(1);
      await nextSnapshot(client, tick);
    }

    const poses = (): Map<string, number[]> => {
      const frame = stream.sample(clock + STEP_MS / 2);
      const layout = stream.layout;
      if (frame === null || layout === null) throw new Error('nothing to sample');
      return new Map(
        [...layout.offsets].map(([id, o]) => [id, [...frame.subarray(o, o + SNAPSHOT_STRIDE)]]),
      );
    };

    const beforeAdd = poses();
    const add = await client.addFish({ id: 'newcomer', species: 'neon-tetra' });
    stream.change(add.epoch, add.fishIds);
    await nextSnapshot(client, 3);
    const afterAdd = poses();
    expect(stream.layout?.epoch).toBe(add.epoch);
    expect(afterAdd.has('newcomer')).toBe(true);
    for (const [id, pose] of beforeAdd) expect(afterAdd.get(id), id).toEqual(pose);

    const gone = ready.fishIds[0] ?? '';
    const remove = await client.removeFish(gone);
    stream.change(remove.epoch, remove.fishIds);
    await nextSnapshot(client, 3);
    const afterRemove = poses();
    expect(afterRemove.has(gone)).toBe(false);
    expect(afterRemove.size).toBe(afterAdd.size - 1);
    for (const [id, pose] of afterRemove) expect(pose, id).toEqual(afterAdd.get(id));

    client.dispose();
    channel.port1.close();
    channel.port2.close();
  });
});
