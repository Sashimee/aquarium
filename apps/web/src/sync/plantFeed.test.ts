import { DEFAULT_BACKGROUND_ID, type Plant } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { PlantFeed } from './plantFeed';

const fern: Plant = {
  key: 's1',
  assetId: 'plant-fern',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1.5,
  minSize: 0.4,
  maxSize: 2,
};

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new PlantFeed(bus);
  const seen: (readonly Plant[] | undefined)[] = [];
  const sink = { setPlants: (plants: readonly Plant[] | undefined) => seen.push(plants) };
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', {
      tankId,
      biome: 'freshwater',
      size: 'nano30',
      fish: [],
      decorLayout: [],
      decorEdited: false,
      backgroundId: DEFAULT_BACKGROUND_ID.freshwater,
    });
  return { bus, feed, seen, sink, loaded };
}

describe('PlantFeed', () => {
  it('hands the scene the plants held before it existed', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    feed.attach(sink);
    expect(seen).toEqual([[fern]]);
  });

  it('follows the active tank and ignores another tank', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    bus.emit('tank:plants', { tankId: 'b', plants: [] });
    expect(seen).toEqual([undefined, [fern]]);
  });

  it('keeps the old plants through a switch, then takes the next tank', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
    loaded('b');
    expect(seen).toEqual([undefined, [fern]]);
    bus.emit('tank:plants', { tankId: 'a', plants: [] });
    expect(seen).toHaveLength(2);
    bus.emit('tank:plants', { tankId: 'b', plants: [] });
    expect(seen.at(-1)).toEqual([]);
  });

  it('clears on sign out, on no tank and on a public tank', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'reset' });
    expect(seen.at(-1)).toBeUndefined();
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    bus.emit('tank:none', {});
    expect(seen.at(-1)).toBeUndefined();
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    loaded('public:1f');
    expect(seen.at(-1)).toBeUndefined();
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    expect(seen.at(-1)).toBeUndefined();
  });

  it('stops talking to a detached or stopped scene', () => {
    const { bus, feed, sink, seen, loaded } = setup();
    const detach = feed.attach(sink);
    detach();
    loaded('a');
    bus.emit('tank:plants', { tankId: 'a', plants: [fern] });
    expect(seen).toEqual([undefined]);
    feed.attach(sink);
    expect(seen.at(-1)).toEqual([fern]);
    feed.stop();
    bus.emit('tank:plants', { tankId: 'a', plants: [] });
    expect(seen).toHaveLength(2);
  });
});
