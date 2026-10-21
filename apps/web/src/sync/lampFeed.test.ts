import { lampIsOn } from '@aquarium/sim/lifecycle';
import { describe, expect, it } from 'vitest';
import { lampPhotoperiod, type LampHours } from '../engine/daylight';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { LampFeed } from './lampFeed';

function setup() {
  const bus = new EventBus<InteractionEvents>();
  const feed = new LampFeed(bus);
  const seen: LampHours[] = [];
  const loaded = (tankId: string) =>
    bus.emit('tank:loaded', { tankId } as unknown as InteractionEvents['tank:loaded']);
  return { bus, feed, seen, sink: { setLampSchedule: (h: LampHours) => seen.push(h) }, loaded };
}

describe('LampFeed', () => {
  it('starts on the default schedule', () => {
    const { feed, sink, seen } = setup();
    feed.attach(sink);
    expect(seen).toEqual([{ onHour: 8, offHour: 20 }]);
  });

  it('follows the loaded tank and a tank switch', () => {
    const { feed, sink, seen, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:lamp', { tankId: 'a', onHour: 6, offHour: 18 });
    loaded('b');
    bus.emit('tank:lamp', { tankId: 'b', onHour: 14, offHour: 2 });
    expect(seen).toEqual([
      { onHour: 8, offHour: 20 },
      { onHour: 6, offHour: 18 },
      { onHour: 8, offHour: 20 },
      { onHour: 14, offHour: 2 },
    ]);
  });

  it('follows a schedule change and ignores one for another tank', () => {
    const { feed, sink, seen, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:lamp', { tankId: 'a', onHour: 9, offHour: 21 });
    bus.emit('tank:lamp', { tankId: 'other', onHour: 1, offHour: 2 });
    expect(seen).toEqual([
      { onHour: 8, offHour: 20 },
      { onHour: 9, offHour: 21 },
    ]);
  });

  it('holds the hours of a tank loaded before the engine is up', () => {
    const { feed, sink, seen, loaded, bus } = setup();
    loaded('a');
    bus.emit('tank:lamp', { tankId: 'a', onHour: 14, offHour: 2 });
    feed.attach(sink);
    expect(seen).toEqual([{ onHour: 14, offHour: 2 }]);
  });

  it('returns to the default on sign-out and with no tank', () => {
    const { feed, sink, seen, loaded, bus } = setup();
    feed.attach(sink);
    loaded('a');
    bus.emit('tank:lamp', { tankId: 'a', onHour: 14, offHour: 2 });
    bus.emit('tank:unloaded', { tankId: 'a', reason: 'reset' });
    expect(seen.at(-1)).toEqual({ onHour: 8, offHour: 20 });
    loaded('a');
    bus.emit('tank:lamp', { tankId: 'a', onHour: 14, offHour: 2 });
    bus.emit('tank:none', {});
    expect(seen.at(-1)).toEqual({ onHour: 8, offHour: 20 });
  });

  it('stops listening after stop', () => {
    const { feed, sink, seen, loaded } = setup();
    feed.attach(sink);
    feed.stop();
    loaded('a');
    expect(seen).toHaveLength(1);
  });
});

describe('the hood photoperiod for a wrapping schedule', () => {
  it('lights the hood in the same hours as the sim lamp', () => {
    for (const [on, off] of [
      [14, 2],
      [22, 6],
      [8, 20],
    ] as const) {
      const p = lampPhotoperiod({ onHour: on, offHour: off });
      for (let hour = 0; hour < 24; hour++) {
        const lit = (hour * 60 + 30 - p.onAt + 1440) % 1440 < ((off - on + 24) % 24) * 60;
        expect(lit).toBe(lampIsOn(Date.UTC(2026, 0, 1, hour, 30), 0, on, off));
      }
    }
  });
});
