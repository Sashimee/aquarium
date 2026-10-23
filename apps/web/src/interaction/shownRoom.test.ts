import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './events';
import { ShownRoom } from './shownRoom';

function setup() {
  const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
  const shown = new ShownRoom(bus);
  const load = (tankId: string, roomId?: InteractionEvents['tank:loaded']['roomId']) =>
    bus.emit('tank:loaded', {
      tankId,
      biome: 'freshwater',
      size: 'standard',
      fish: [],
      decorLayout: [],
      decorEdited: false,
      backgroundId: 'bg-fw-planted-stream',
      ...(roomId === undefined ? {} : { roomId }),
    });
  return { bus, shown, load };
}

describe('ShownRoom', () => {
  it('starts in the living room for the demo tank', () => {
    const { bus, shown } = setup();
    expect(shown.snapshot()).toBe('room-living');
    expect(bus.peek('room:state')).toEqual({ tankId: null, roomId: 'room-living' });
  });

  it('shows the room of the loaded tank, including none', () => {
    const { shown, load, bus } = setup();
    load('a', 'room-office');
    expect(shown.snapshot()).toBe('room-office');
    load('b', null);
    expect(shown.snapshot()).toBeNull();
    expect(bus.peek('room:state')).toEqual({ tankId: 'b', roomId: null });
  });

  it('follows the server for the shown tank and ignores other tanks', () => {
    const { shown, load, bus } = setup();
    load('a', 'room-living');
    bus.emit('tank:room', { tankId: 'a', roomId: 'room-zen' });
    expect(shown.snapshot()).toBe('room-zen');
    bus.emit('tank:room', { tankId: 'other', roomId: 'room-beach' });
    expect(shown.snapshot()).toBe('room-zen');
  });

  it('keeps the room across a reload of the same tank that names none, and defaults for a new one', () => {
    const { shown, load } = setup();
    load('a', 'room-cabin');
    load('a');
    expect(shown.snapshot()).toBe('room-cabin');
    load('b');
    expect(shown.snapshot()).toBe('room-living');
  });

  it('goes back to the living room when no tank is left', () => {
    const { shown, load, bus } = setup();
    load('a', 'room-cabin');
    bus.emit('tank:none', {});
    expect(shown.snapshot()).toBe('room-living');
  });

  it('leaves the community hall when its tank is reset, but not on a switch', () => {
    const { shown, load, bus } = setup();
    load('community', 'room-public-aquarium');
    bus.emit('tank:unloaded', { tankId: 'community', reason: 'switch' });
    expect(shown.snapshot()).toBe('room-public-aquarium');
    bus.emit('tank:unloaded', { tankId: 'community', reason: 'reset' });
    expect(shown.snapshot()).toBe('room-living');
  });

  it('tells subscribers once per change and stops after stop()', () => {
    const { shown, load, bus } = setup();
    const listener = vi.fn();
    shown.subscribe(listener);
    load('a', 'room-zen');
    bus.emit('tank:room', { tankId: 'a', roomId: 'room-zen' });
    expect(listener).toHaveBeenCalledTimes(1);
    shown.stop();
    load('b', 'room-beach');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
