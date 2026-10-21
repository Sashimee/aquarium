import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { publicTankId } from './share';
import { NO_TANK_SEED, RoomSeedFeed, tankSeed } from './roomSeed';

const serverSeed = (id: string): number =>
  createHash('sha256').update(`tank:${id}`).digest().readUInt32BE(0);

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new RoomSeedFeed(bus);
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', { tankId } as unknown as InteractionEvents['tank:loaded']);
  return { bus, feed, loaded };
}

describe('tankSeed', () => {
  it('matches the seed the server derives for an owned tank', () => {
    for (const id of ['a', '3f2c9a10-77b1-4a55-8d6e-0c2e51a9d0aa', 'tank 🐟']) {
      expect(tankSeed(id)).toBe(serverSeed(id));
    }
  });

  it('reads a visitor tank seed from its id', () => {
    const seed = 0xdeadbeef;
    const id = publicTankId({ seed });
    expect(tankSeed(id)).toBe(seed);
  });
});

describe('RoomSeedFeed', () => {
  it('starts without a tank seed', () => {
    expect(setup().feed.current()).toBe(NO_TANK_SEED);
  });

  it('takes the seed of the loaded tank and tells subscribers', () => {
    const { feed, loaded } = setup();
    const listener = vi.fn();
    feed.subscribe(listener);
    loaded('tank-a');
    expect(feed.current()).toBe(serverSeed('tank-a'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('follows a tank switch and returns to the default when there is none', () => {
    const { feed, loaded, bus } = setup();
    loaded('tank-a');
    expect(feed.current()).toBe(serverSeed('tank-a'));
    loaded('tank-b');
    expect(feed.current()).toBe(serverSeed('tank-b'));
    bus.emit('tank:none', {});
    expect(feed.current()).toBe(NO_TANK_SEED);
  });

  it('drops the seed when the tank is unloaded', () => {
    const { feed, loaded, bus } = setup();
    const listener = vi.fn();
    loaded('tank-a');
    feed.subscribe(listener);
    bus.emit('tank:unloaded', { tankId: 'tank-a', reason: 'switch' });
    expect(feed.current()).toBe(NO_TANK_SEED);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('gives visitors the seed in their tank id', () => {
    const { feed, loaded } = setup();
    loaded(publicTankId({ seed: 1234567 }));
    expect(feed.current()).toBe(1234567);
  });

  it('stops listening after stop', () => {
    const bus = new EventBus<InteractionEvents>();
    const stopped = new RoomSeedFeed(bus);
    const control = new RoomSeedFeed(bus);
    stopped.stop();
    bus.emit('tank:loaded', { tankId: 'tank-a' } as unknown as InteractionEvents['tank:loaded']);
    expect(control.current()).toBe(serverSeed('tank-a'));
    expect(stopped.current()).toBe(NO_TANK_SEED);
  });
});
