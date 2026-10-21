import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { publicTankId } from './share';
import { NO_TANK_SEED, RoomSeedFeed, tankSeed } from './roomSeed';

const serverSeed = (id: string): number =>
  createHash('sha256').update(`tank:${id}`).digest().readUInt32BE(0);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new RoomSeedFeed(bus);
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', { tankId } as unknown as InteractionEvents['tank:loaded']);
  return { bus, feed, loaded };
}

describe('tankSeed', () => {
  it('matches the seed the server derives for an owned tank', async () => {
    for (const id of ['a', '3f2c9a10-77b1-4a55-8d6e-0c2e51a9d0aa', 'tank 🐟']) {
      expect(await tankSeed(id)).toBe(serverSeed(id));
    }
  });

  it('reads a visitor tank seed from its id', async () => {
    const seed = 0xdeadbeef;
    const id = publicTankId({ seed });
    expect(await tankSeed(id)).toBe(seed);
  });
});

describe('RoomSeedFeed', () => {
  it('starts without a tank seed', () => {
    expect(setup().feed.current()).toBe(NO_TANK_SEED);
  });

  it('takes the seed of the loaded tank and tells subscribers', async () => {
    const { feed, loaded } = setup();
    const listener = vi.fn();
    feed.subscribe(listener);
    loaded('tank-a');
    await flush();
    expect(feed.current()).toBe(serverSeed('tank-a'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('follows a tank switch and returns to the default when there is none', async () => {
    const { feed, loaded, bus } = setup();
    loaded('tank-a');
    await flush();
    loaded('tank-b');
    await flush();
    expect(feed.current()).toBe(serverSeed('tank-b'));
    bus.emit('tank:none', {});
    expect(feed.current()).toBe(NO_TANK_SEED);
  });

  it('lets the last loaded tank win when seeds resolve late', async () => {
    const { feed, loaded } = setup();
    loaded('tank-a');
    loaded('tank-b');
    await flush();
    expect(feed.current()).toBe(serverSeed('tank-b'));
  });

  it('gives visitors the seed in their tank id', async () => {
    const { feed, loaded } = setup();
    loaded(publicTankId({ seed: 1234567 }));
    await flush();
    expect(feed.current()).toBe(1234567);
  });

  it('stops listening after stop', async () => {
    const { feed, loaded } = setup();
    feed.stop();
    loaded('tank-a');
    await flush();
    expect(feed.current()).toBe(NO_TANK_SEED);
  });
});
