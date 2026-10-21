import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSimHost,
  FishState,
  SimClient,
  SNAPSHOT_STRIDE,
  SnapshotField,
  STEP_HZ,
  type SimHost,
  type SimHostOptions,
  type Snapshot,
} from '@aquarium/sim';
import { DaylightAnnouncer } from '../engine/daylight';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank } from './demoStock';
import { sendLight } from './simWorld';

const FRAME_MS = 1000 / 60;
const HIDDEN_MS = 30 * 60 * 1000;

interface Tank {
  host: SimHost;
  client: SimClient;
  channel: MessageChannel;
}

const open: Tank[] = [];

function snapshot(client: SimClient): Promise<Snapshot> {
  return new Promise((resolve) => {
    const off = client.onSnapshot((s) => {
      off();
      resolve(s);
    });
  });
}

/** A demo tank in full daylight that has run long enough for its fish to adapt to it. */
async function adaptedTank(options?: SimHostOptions): Promise<SimClient> {
  const channel = new MessageChannel();
  const tank = {
    host: createSimHost(channel.port1, options),
    client: new SimClient(channel.port2),
    channel,
  };
  open.push(tank);
  const { config } = demoTank(DEFAULT_TANK, 11, 'freshwater');
  await tank.client.init({ ...config, light: 1 });
  const settled = snapshot(tank.client);
  tank.client.step(30 * STEP_HZ);
  await settled;
  return tank.client;
}

/** Fish seen in the startle state in any of the next `steps` steps. */
async function startledOver(client: SimClient, steps: number): Promise<number> {
  const startled = new Set<number>();
  for (let s = 0; s < steps; s++) {
    const next = snapshot(client);
    client.step(1);
    const { data } = await next;
    for (let i = 0; i * SNAPSHOT_STRIDE < data.length; i++) {
      if (data[i * SNAPSHOT_STRIDE + SnapshotField.State] === FishState.Startle) startled.add(i);
    }
  }
  return startled.size;
}

/** Lets queued port messages through, then moves the frozen timers on by `ms`. */
async function workerTurn(ms: number): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(ms);
}

function lampOnAnnouncer(): DaylightAnnouncer {
  const announcer = new DaylightAnnouncer();
  expect(announcer.next(1)?.settled).toBe(true);
  return announcer;
}

beforeEach(() => {
  // The worker loop's timer stays frozen, so `step` alone moves the world.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  for (const { host, client, channel } of open.splice(0)) {
    client.dispose();
    host.dispose();
    channel.port1.close();
    channel.port2.close();
  }
  vi.useRealTimers();
});

describe('hood light after a hidden tab', { timeout: 30_000 }, () => {
  it('a lamp switch seen frame by frame startles the fish', async () => {
    const client = await adaptedTank();
    const announcer = lampOnAnnouncer();
    announcer.frame(FRAME_MS);
    const change = announcer.next(0);
    expect(change).toEqual({ level: 0, settled: false });
    if (change === null) return;
    sendLight(client, change);
    expect(await startledOver(client, STEP_HZ)).toBeGreaterThanOrEqual(5);
  });

  it('the same jump on return from a hidden tab startles nobody', async () => {
    const client = await adaptedTank();
    const announcer = lampOnAnnouncer();
    announcer.frame(HIDDEN_MS);
    const change = announcer.next(0);
    expect(change).toEqual({ level: 0, settled: true });
    if (change === null) return;
    sendLight(client, change);
    expect(await startledOver(client, STEP_HZ)).toBe(0);
  });

  it('leaves a world the host halted after an error halted', async () => {
    let clockReads = 0;
    const client = await adaptedTank({
      now: () => {
        clockReads++;
        if (clockReads === 2) throw new Error('clock exploded');
        return clockReads * 1000;
      },
    });
    const errors: string[] = [];
    client.onError((message) => errors.push(message));
    client.start();
    while (errors.length === 0) await workerTurn(100);
    const ticks: number[] = [];
    client.onSnapshot((s) => ticks.push(s.tick));

    const announcer = lampOnAnnouncer();
    announcer.frame(HIDDEN_MS);
    const change = announcer.next(0);
    expect(change?.settled).toBe(true);
    if (change === null) return;
    sendLight(client, change);
    const flushed = snapshot(client);
    client.step(1);
    const last = (await flushed).tick;
    for (let i = 0; i < 10; i++) await workerTurn(100);
    const after = snapshot(client);
    client.step(1);
    expect((await after).tick).toBe(last + 1);

    expect(ticks).toEqual([last, last + 1]);
    expect(errors).toEqual(['clock exploded']);
    expect(clockReads).toBe(2);
  });
});
