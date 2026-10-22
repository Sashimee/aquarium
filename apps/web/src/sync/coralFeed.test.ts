import { DEFAULT_BACKGROUND_ID, type Coral } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { CoralFeed } from './coralFeed';

const table: Coral = {
  key: 's1',
  assetId: 'acropora-cytherea',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1.4,
  minSize: 0.4,
  maxSize: 2,
  fragMinSize: 1.5,
  bleach: 0.1,
};

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new CoralFeed(bus);
  const seen: (readonly Coral[] | undefined)[] = [];
  const sink = { setCorals: (corals: readonly Coral[] | undefined) => seen.push(corals) };
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', {
      tankId,
      biome: 'reef',
      size: 'nano30',
      fish: [],
      decorLayout: [],
      decorEdited: false,
      backgroundId: DEFAULT_BACKGROUND_ID.reef,
    });
  return { bus, feed, seen, sink, loaded };
}

describe('CoralFeed', () => {
  it('hands a late sink the corals held before it existed', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    feed.attach(sink);
    expect(seen).toEqual([[table]]);
  });

  it('follows the active tank and ignores another tank', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    bus.emit('tank:corals', { tankId: 'b', corals: [] });
    expect(seen).toEqual([undefined, [table]]);
  });

  it('keeps the old corals through a switch, then takes the next tank', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
    loaded('b');
    expect(seen).toEqual([undefined, [table]]);
    bus.emit('tank:corals', { tankId: 'b', corals: [] });
    expect(seen.at(-1)).toEqual([]);
  });

  it('clears on sign out, on no tank and on a public tank', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'reset' });
    expect(seen.at(-1)).toBeUndefined();
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    bus.emit('tank:none', {});
    expect(seen.at(-1)).toBeUndefined();
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    loaded('public:1f');
    expect(seen.at(-1)).toBeUndefined();
  });

  it('feeds every attached sink and stops for a detached or stopped one', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    const other: (readonly Coral[] | undefined)[] = [];
    const detach = feed.attach(sink);
    feed.attach({ setCorals: (corals) => other.push(corals) });
    loaded('a');
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    expect(other.at(-1)).toEqual([table]);
    detach();
    bus.emit('tank:corals', { tankId: 'a', corals: [] });
    expect(seen).toEqual([undefined, [table]]);
    expect(other.at(-1)).toEqual([]);
    feed.stop();
    bus.emit('tank:corals', { tankId: 'a', corals: [table] });
    expect(other.at(-1)).toEqual([]);
  });
});
