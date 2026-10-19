import type { CareEvent, Fish, Tank } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { FISH_1, FISH_2, FISH_3, TANK_A, TANK_B, fishFixture, tankFixture } from './fixtures';
import { createReplayDirector, rosterAt } from './replayDirector';

const AT = '2026-10-18T10:00:00.000Z';

function ev(n: number, kind: 'born' | 'death' | 'feed', fishId: string): CareEvent {
  const base = {
    id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tankId: TANK_A,
    at: AT,
  };
  if (kind === 'born') {
    return { ...base, kind, payload: { fishId, parentId: FISH_1, species: 'neon-tetra' } };
  }
  if (kind === 'death') return { ...base, kind, payload: { fishId, cause: 'ammonia' } };
  return { ...base, kind, payload: { food: 'flakes', portion: 1 } };
}

const survivor = fishFixture(FISH_1);
const dead = fishFixture(FISH_2, { status: 'dead', health: 0, diedAt: AT, cause: 'ammonia' });
const newborn = fishFixture(FISH_3, { stage: 'fry' });
const events = [ev(1, 'feed', FISH_1), ev(2, 'born', FISH_3), ev(3, 'death', FISH_2)];
const live = [survivor, dead, newborn];

function setup(tank: Tank = tankFixture({ fish: live })) {
  const bus = new EventBus<InteractionEvents>();
  const seen: { type: string; payload: unknown }[] = [];
  for (const type of [
    'tank:loaded',
    'tank:fish-added',
    'tank:fish-died',
    'replay:time-scale',
  ] as const) {
    bus.on(type, (payload) => seen.push({ type, payload }));
  }
  let current = tank;
  const director = createReplayDirector({
    interaction: bus,
    getTank: () => current,
    events,
  });
  return {
    director,
    bus,
    seen,
    setTank(next: Tank) {
      current = next;
    },
  };
}

describe('rosterAt', () => {
  it('starts without newborns and with the fish that will die still alive', () => {
    const start = rosterAt(live, events, 0);
    expect(start.map((f) => f.id)).toEqual([FISH_1, FISH_2]);
    expect(start.find((f) => f.id === FISH_2)).toMatchObject({ status: 'alive', cause: null });
  });

  it('brings in each fish as its event is passed and keeps tank order', () => {
    expect(rosterAt(live, events, 2).map((f) => f.id)).toEqual([FISH_1, FISH_2, FISH_3]);
    const end = rosterAt(live, events, 3);
    expect(end.find((f) => f.id === FISH_2)).toBe(dead);
  });

  it('skips a newborn that has since been netted', () => {
    expect(rosterAt([survivor, dead], events, 3).map((f) => f.id)).toEqual([FISH_1, FISH_2]);
  });
});

describe('ReplayDirector', () => {
  it('sends a non-finite time scale as normal speed', () => {
    const { director, seen } = setup();
    director.run([
      { type: 'time-scale', scale: Number.NaN },
      { type: 'time-scale', scale: Number.POSITIVE_INFINITY },
      { type: 'time-scale', scale: 20 },
    ]);
    expect(seen.map((s) => s.payload)).toEqual([{ scale: 1 }, { scale: 1 }, { scale: 20 }]);
  });

  it('loads the starting roster, then adds and kills fish as their events come up', () => {
    const { director, seen } = setup();
    director.run([
      { type: 'reset-roster', shown: 0 },
      { type: 'time-scale', scale: 20 },
      { type: 'apply', index: 0 },
      { type: 'apply', index: 1 },
      { type: 'apply', index: 2 },
    ]);
    expect(seen.map((s) => s.type)).toEqual([
      'tank:loaded',
      'replay:time-scale',
      'tank:fish-added',
      'tank:fish-died',
    ]);
    const loaded = seen[0]?.payload as InteractionEvents['tank:loaded'];
    expect(loaded.fish.map((f: Fish) => f.id)).toEqual([FISH_1, FISH_2]);
    expect(seen[2]?.payload).toMatchObject({ tankId: TANK_A, acclimate: false });
    expect((seen[2]?.payload as InteractionEvents['tank:fish-added']).fish.id).toBe(FISH_3);
    expect((seen[3]?.payload as InteractionEvents['tank:fish-died']).fish).toBe(dead);
  });

  it('restores exactly the live tank, using its latest snapshot', () => {
    const { director, seen, setTank } = setup();
    director.run([{ type: 'reset-roster', shown: 1 }]);
    const newer = tankFixture({
      fish: [survivor, dead, newborn, fishFixture('10000000-0000-4000-8000-000000000009')],
    });
    setTank(newer);
    director.run([{ type: 'time-scale', scale: 1 }, { type: 'restore' }]);
    const last = seen.at(-1)?.payload as InteractionEvents['tank:loaded'];
    expect(seen.at(-1)?.type).toBe('tank:loaded');
    expect(last.fish).toBe(newer.fish);
    expect(last.decorLayout).toBe(newer.decorLayout);
    expect(last.decorEdited).toBe(newer.decorEdited);
    expect(seen.at(-2)).toEqual({ type: 'replay:time-scale', payload: { scale: 1 } });
  });

  it('carries the tank size in every roster it loads', () => {
    const { director, seen } = setup(tankFixture({ fish: live, size: 'long300' }));
    director.run([{ type: 'reset-roster', shown: 0 }, { type: 'restore' }]);
    const loads = seen.filter((s) => s.type === 'tank:loaded');
    expect(loads).toHaveLength(2);
    for (const load of loads) {
      expect((load.payload as InteractionEvents['tank:loaded']).size).toBe('long300');
    }
  });

  it('leaves the scene alone once the session has loaded another tank, with no setTank', () => {
    const { director, seen, bus } = setup();
    director.run([{ type: 'reset-roster', shown: 0 }]);
    const other = tankFixture({ id: TANK_B, fish: [] });
    bus.emit('tank:loaded', {
      tankId: other.id,
      biome: other.biome,
      size: other.size,
      fish: other.fish,
      decorLayout: other.decorLayout,
      decorEdited: other.decorEdited,
      backgroundId: other.backgroundId,
    });
    const before = seen.length;
    director.run([
      { type: 'reset-roster', shown: 0 },
      { type: 'apply', index: 1 },
      { type: 'time-scale', scale: 1 },
      { type: 'restore' },
    ]);
    director.dispose();
    expect(seen.slice(before)).toEqual([{ type: 'replay:time-scale', payload: { scale: 1 } }]);
  });

  describe('foreign loads of the replayed tank', () => {
    const loadOf = (tank: Tank): InteractionEvents['tank:loaded'] => ({
      tankId: tank.id,
      biome: tank.biome,
      size: tank.size,
      fish: tank.fish,
      decorLayout: tank.decorLayout,
      decorEdited: tank.decorEdited,
      backgroundId: tank.backgroundId,
    });
    const idsOf = (payload: unknown): string[] =>
      (payload as InteractionEvents['tank:loaded']).fish.map((f: Fish) => f.id);

    it('resets the roster before the next event after a batched A, B, A switch', () => {
      const { director, seen, bus } = setup();
      director.run([{ type: 'reset-roster', shown: 1 }]);
      bus.emit('tank:loaded', loadOf(tankFixture({ id: TANK_B, fish: [] })));
      bus.emit('tank:loaded', loadOf(tankFixture({ fish: live })));
      const before = seen.length;
      director.run([{ type: 'apply', index: 1 }]);
      const after = seen.slice(before);
      expect(after.map((s) => s.type)).toEqual(['tank:loaded', 'tank:fish-added']);
      expect(idsOf(after[0]?.payload)).toEqual([FISH_1, FISH_2]);
    });

    it('resets after a single foreign reload of its tank', () => {
      const { director, seen, bus } = setup();
      director.run([{ type: 'reset-roster', shown: 0 }]);
      bus.emit('tank:loaded', loadOf(tankFixture({ fish: live })));
      const before = seen.length;
      director.run([{ type: 'apply', index: 2 }]);
      const after = seen.slice(before);
      expect(after.map((s) => s.type)).toEqual(['tank:loaded', 'tank:fish-died']);
      expect(idsOf(after[0]?.payload)).toEqual([FISH_1, FISH_2]);
    });

    it('does not reset because of its own loads', () => {
      const { director, seen } = setup();
      director.run([
        { type: 'reset-roster', shown: 0 },
        { type: 'apply', index: 1 },
        { type: 'reset-roster', shown: 2 },
        { type: 'apply', index: 2 },
      ]);
      expect(seen.map((s) => s.type)).toEqual([
        'tank:loaded',
        'tank:fish-added',
        'tank:loaded',
        'tank:fish-died',
      ]);
    });
  });
});
