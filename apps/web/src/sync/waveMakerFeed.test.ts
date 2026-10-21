import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { WaveMakerFeed } from './waveMakerFeed';

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new WaveMakerFeed(bus);
  const tiers: number[] = [];
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', {
      tankId,
      biome: 'reef',
      size: 'standard',
      fish: [],
      decorLayout: [],
      decorEdited: false,
      backgroundId: 'bg-reef-deep-blue',
    });
  return { bus, feed, tiers, sink: { setWaveMakerTier: (t: number) => tiers.push(t) }, loaded };
}

describe('WaveMakerFeed', () => {
  it('sends nothing but tier 0 to a tank without a wave maker', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 0 });
    expect(tiers).toEqual([0]);
  });

  it('follows a purchase, an upgrade and a removal', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 1 });
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 3 });
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 0 });
    expect(tiers).toEqual([0, 1, 3, 0]);
  });

  it('holds the tier of a tank loaded before the fish are up', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
    feed.attach(sink);
    expect(tiers).toEqual([2]);
  });

  it('removes the wave maker on a tank switch and applies the next tank own tier', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
    loaded('b');
    bus.emit('tank:wave-maker', { tankId: 'b', tier: 0 });
    bus.emit('tank:unloaded', { tankId: 'b', reason: 'switch' });
    loaded('c');
    bus.emit('tank:wave-maker', { tankId: 'c', tier: 1 });
    expect(tiers).toEqual([0, 2, 0, 1]);
  });

  it('ignores a tier for a tank that is not the active one, and clears when no tank is coming', () => {
    const { feed, sink, tiers, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:wave-maker', { tankId: 'other', tier: 3 });
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 1 });
    bus.emit('tank:none', {});
    bus.emit('tank:wave-maker', { tankId: 'a', tier: 2 });
    expect(tiers).toEqual([0, 1, 0]);
  });
});
