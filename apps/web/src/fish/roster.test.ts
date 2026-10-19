import { describe, expect, it } from 'vitest';
import type { FishSpawn } from '@aquarium/sim';
import { HUNGER_PER_PORTION } from '@aquarium/sim/lifecycle';
import { FISH_1, FISH_2, FISH_3, TANK_A, TANK_B, fishFixture } from '../sync/fixtures';
import { hashString, TankRoster } from './roster';

const DEMO: readonly FishSpawn[] = [
  { id: 'neon-tetra-0', species: 'neon-tetra', bodyLengthM: 0.03 },
  { id: 'angelfish-0', species: 'angelfish' },
];

function loaded(fish = [fishFixture(FISH_1), fishFixture(FISH_2)]): TankRoster {
  const roster = new TankRoster(DEMO);
  roster.load({
    backgroundId: 'bg-fw-planted-stream',
    tankId: TANK_A,
    biome: 'freshwater',
    decorLayout: [],
    decorEdited: false,
    fish,
  });
  return roster;
}

function simId(roster: TankRoster, serverId: string): string {
  const id = roster.simIdOf(serverId);
  if (id === undefined) throw new Error(`no sim id for ${serverId}`);
  return id;
}

describe('TankRoster', () => {
  it('starts with the demo stock, which has no server ids', () => {
    const roster = new TankRoster(DEMO);
    const fish = [...roster.entries()];
    expect(fish.map((f) => f.key)).toEqual(['neon-tetra-0', 'angelfish-0']);
    expect(fish.every((f) => f.serverId === null && f.phase === 'swimming')).toBe(true);
    expect(fish[0]?.lengthM).toBe(0.03);
    expect(fish.map((f) => f.sex)).toEqual([null, null]);
    expect(roster.tankId).toBeNull();
  });

  it('carries the sex the server stored on every saved fish, however it arrives', () => {
    const roster = loaded([fishFixture(FISH_1, { sex: 'male' }), fishFixture(FISH_2)]);
    roster.add({ tankId: TANK_A, fish: fishFixture(FISH_3, { sex: 'male' }), acclimate: true });
    const sexes = [FISH_1, FISH_2, FISH_3].map((id) => roster.get(simId(roster, id))?.sex);
    expect(sexes).toEqual(['male', 'female', 'male']);
  });

  it('replaces the demo stock with the saved fish on load and maps server ids', () => {
    const roster = loaded([
      fishFixture(FISH_1, { size: 0.025, health: 0.4 }),
      fishFixture(FISH_2, { species: 'betta', status: 'dead', health: 0 }),
    ]);
    expect(roster.size).toBe(2);
    expect(roster.tankId).toBe(TANK_A);
    expect(roster.biome).toBe('freshwater');
    const one = roster.get(simId(roster, FISH_1));
    expect(one).toMatchObject({ serverId: FISH_1, key: FISH_1, lengthM: 0.025, health: 0.4 });
    expect(one?.phase).toBe('swimming');
    expect(roster.get(simId(roster, FISH_2))?.phase).toBe('dead');
    expect(roster.serverIdOf(simId(roster, FISH_2))).toBe(FISH_2);
    expect(roster.swimming().map((f) => f.serverId)).toEqual([FISH_1]);
    expect([...roster.entries()].some((f) => f.serverId === null)).toBe(false);
  });

  it('never reuses a sim id, even when the same fish loads again', () => {
    const roster = loaded();
    const first = simId(roster, FISH_1);
    roster.unload({ tankId: TANK_A, reason: 'switch' });
    roster.load({
      backgroundId: 'bg-fw-planted-stream',
      tankId: TANK_A,
      biome: 'freshwater',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_1)],
    });
    expect(simId(roster, FISH_1)).not.toBe(first);
    expect(roster.get(first)).toBeUndefined();
  });

  it('restores the demo stock on a reset unload and leaves none of the tank behind', () => {
    const roster = loaded();
    const before = roster.revision;
    expect(roster.unload({ tankId: TANK_A, reason: 'reset' })).toBe(true);
    expect(roster.revision).toBeGreaterThan(before);
    expect(roster.tankId).toBeNull();
    expect([...roster.entries()].map((f) => f.key)).toEqual(['neon-tetra-0', 'angelfish-0']);
    expect(roster.simIdOf(FISH_1)).toBeUndefined();
    expect(roster.simIdOf(FISH_2)).toBeUndefined();
    expect(roster.none()).toBe(false);
  });

  it('shows no fish between a switch unload and the next tank', () => {
    const roster = loaded();
    const before = roster.revision;
    expect(roster.unload({ tankId: TANK_A, reason: 'switch' })).toBe(true);
    expect(roster.revision).toBeGreaterThan(before);
    expect(roster.tankId).toBeNull();
    expect(roster.size).toBe(0);
    roster.load({
      backgroundId: 'bg-fw-planted-stream',
      tankId: TANK_B,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_3, { tankId: TANK_B })],
    });
    expect([...roster.entries()].map((f) => f.serverId)).toEqual([FISH_3]);
    expect(roster.none()).toBe(false);
  });

  it('brings the demo stock back once no saved tank follows a switch', () => {
    const roster = loaded();
    roster.unload({ tankId: TANK_A, reason: 'switch' });
    const before = roster.revision;
    expect(roster.none()).toBe(true);
    expect(roster.revision).toBeGreaterThan(before);
    expect([...roster.entries()].map((f) => f.key)).toEqual(['neon-tetra-0', 'angelfish-0']);
    const after = roster.revision;
    expect(roster.none()).toBe(false);
    expect(roster.revision).toBe(after);
    expect(new TankRoster(DEMO).none()).toBe(false);
  });

  it('holds a demo swap made mid-switch until no saved tank follows', () => {
    const roster = loaded();
    roster.unload({ tankId: TANK_A, reason: 'switch' });
    const before = roster.revision;
    expect(roster.setDemo([{ id: 'ocellaris-0', species: 'ocellaris-clownfish' }])).toBe(false);
    expect(roster.revision).toBe(before);
    expect(roster.size).toBe(0);
    roster.none();
    expect([...roster.entries()].map((f) => f.key)).toEqual(['ocellaris-0']);
  });

  it('swaps the demo stock while no saved tank is loaded', () => {
    const roster = new TankRoster(DEMO);
    const before = roster.revision;
    expect(roster.setDemo([{ id: 'ocellaris-0', species: 'ocellaris-clownfish' }])).toBe(true);
    expect(roster.revision).toBeGreaterThan(before);
    expect([...roster.entries()].map((f) => f.key)).toEqual(['ocellaris-0']);
  });

  it('keeps the saved tank when the demo stock is swapped, and shows the new demo on unload', () => {
    const roster = loaded();
    const before = roster.revision;
    expect(roster.setDemo([{ id: 'ocellaris-0', species: 'ocellaris-clownfish' }])).toBe(false);
    expect(roster.revision).toBe(before);
    expect([...roster.entries()].map((f) => f.serverId)).toEqual([FISH_1, FISH_2]);
    roster.unload({ tankId: TANK_A, reason: 'reset' });
    expect([...roster.entries()].map((f) => f.key)).toEqual(['ocellaris-0']);
  });

  it('ignores an unload for a tank that is not the loaded one', () => {
    const roster = loaded();
    const before = roster.revision;
    expect(roster.unload({ tankId: TANK_B, reason: 'switch' })).toBe(false);
    expect(roster.revision).toBe(before);
    expect(roster.size).toBe(2);
    expect(new TankRoster(DEMO).unload({ tankId: TANK_A, reason: 'switch' })).toBe(false);
  });

  it('switching tanks keeps only the new tank, with no demo fish', () => {
    const roster = loaded();
    roster.load({
      backgroundId: 'bg-fw-planted-stream',
      tankId: TANK_B,
      biome: 'reef',
      decorLayout: [],
      decorEdited: false,
      fish: [fishFixture(FISH_3, { tankId: TANK_B, species: 'ocellaris-clownfish' })],
    });
    expect([...roster.entries()].map((f) => f.serverId)).toEqual([FISH_3]);
    expect(roster.simIdOf(FISH_1)).toBeUndefined();
    expect(roster.biome).toBe('reef');
    expect(roster.unload({ tankId: TANK_A, reason: 'switch' })).toBe(false);
    expect(roster.size).toBe(1);
  });

  it('bags an acclimating fish outside the sim until it is released', () => {
    const roster = loaded();
    const before = roster.revision;
    const bagged = roster.add({ tankId: TANK_A, fish: fishFixture(FISH_3), acclimate: true });
    expect(bagged?.phase).toBe('bagged');
    expect(roster.revision).toBe(before);
    expect(roster.swimming().map((f) => f.serverId)).toEqual([FISH_1, FISH_2]);

    expect(roster.release({ tankId: TANK_A, fishId: FISH_3 })?.phase).toBe('swimming');
    expect(roster.revision).toBe(before + 1);
    expect(roster.swimming().map((f) => f.serverId)).toEqual([FISH_1, FISH_2, FISH_3]);
    expect(roster.release({ tankId: TANK_A, fishId: FISH_3 })).toBeNull();
    expect(roster.revision).toBe(before + 1);
  });

  it('adds a fish without a bag straight into the sim, and ignores duplicates and other tanks', () => {
    const roster = loaded([fishFixture(FISH_1)]);
    const before = roster.revision;
    expect(roster.add({ tankId: TANK_A, fish: fishFixture(FISH_2), acclimate: false })?.phase).toBe(
      'swimming',
    );
    expect(roster.revision).toBe(before + 1);
    expect(roster.add({ tankId: TANK_A, fish: fishFixture(FISH_2), acclimate: false })).toBeNull();
    expect(roster.add({ tankId: TANK_B, fish: fishFixture(FISH_3), acclimate: false })).toBeNull();
    expect(roster.release({ tankId: TANK_B, fishId: FISH_2 })).toBeNull();
    expect(roster.size).toBe(2);
    expect(
      new TankRoster(DEMO).add({ tankId: TANK_A, fish: fishFixture(FISH_3), acclimate: false }),
    ).toBeNull();
  });

  it('takes a dying fish out of the sim and keeps it mapped for the net', () => {
    const roster = loaded();
    const before = roster.revision;
    const dead = roster.died({ tankId: TANK_A, fish: fishFixture(FISH_1, { status: 'dead' }) });
    expect(dead).toMatchObject({ phase: 'dead', health: 0 });
    expect(roster.revision).toBe(before + 1);
    expect(roster.simIdOf(FISH_1)).toBeDefined();
    expect(
      roster.died({ tankId: TANK_A, fish: fishFixture(FISH_1, { status: 'dead' }) }),
    ).toBeNull();
    expect(
      roster.died({ tankId: TANK_B, fish: fishFixture(FISH_2, { status: 'dead' }) }),
    ).toBeNull();
  });

  it('adds an unknown fish that died as already dead', () => {
    const roster = loaded([fishFixture(FISH_1)]);
    const before = roster.revision;
    const dead = roster.died({ tankId: TANK_A, fish: fishFixture(FISH_3, { status: 'dead' }) });
    expect(dead).toMatchObject({ serverId: FISH_3, phase: 'dead' });
    expect(roster.revision).toBe(before);
  });

  it('a bagged fish that dies never enters the sim', () => {
    const roster = loaded([fishFixture(FISH_1)]);
    roster.add({ tankId: TANK_A, fish: fishFixture(FISH_2), acclimate: true });
    const before = roster.revision;
    roster.died({ tankId: TANK_A, fish: fishFixture(FISH_2, { status: 'dead' }) });
    expect(roster.revision).toBe(before);
    expect(roster.release({ tankId: TANK_A, fishId: FISH_2 })).toBeNull();
  });

  it('removes a fish and its mapping', () => {
    const roster = loaded();
    roster.died({ tankId: TANK_A, fish: fishFixture(FISH_2, { status: 'dead' }) });
    const gone = simId(roster, FISH_2);
    const before = roster.revision;
    expect(roster.removed({ tankId: TANK_A, fishId: FISH_2, reason: 'netted' })).not.toBeNull();
    expect(roster.revision).toBe(before);
    expect(roster.get(gone)).toBeUndefined();
    expect(roster.simIdOf(FISH_2)).toBeUndefined();
    expect(roster.removed({ tankId: TANK_A, fishId: FISH_2, reason: 'netted' })).toBeNull();

    roster.removed({ tankId: TANK_A, fishId: FISH_1, reason: 'gone' });
    expect(roster.revision).toBe(before + 1);
    expect(roster.size).toBe(0);
  });

  describe('swimmingSpecies', () => {
    it('lists the demo species, sorted and once each', () => {
      const roster = new TankRoster([
        ...DEMO,
        { id: 'neon-tetra-1', species: 'neon-tetra' },
        { id: 'corydoras-0', species: 'corydoras' },
      ]);
      expect(roster.swimmingSpecies()).toEqual(['angelfish', 'corydoras', 'neon-tetra']);
    });

    it('leaves out bagged and dead fish until they swim', () => {
      const roster = loaded([
        fishFixture(FISH_1, { species: 'neon-tetra' }),
        fishFixture(FISH_2, { species: 'betta', status: 'dead', health: 0 }),
      ]);
      roster.add({
        tankId: TANK_A,
        fish: fishFixture(FISH_3, { species: 'guppy' }),
        acclimate: true,
      });
      expect(roster.swimmingSpecies()).toEqual(['neon-tetra']);
      roster.release({ tankId: TANK_A, fishId: FISH_3 });
      expect(roster.swimmingSpecies()).toEqual(['guppy', 'neon-tetra']);
    });

    it('follows a demo swap, a load, a switch and no next tank', () => {
      const roster = new TankRoster(DEMO);
      roster.setDemo([{ id: 'clownfish-0', species: 'clownfish' }]);
      expect(roster.swimmingSpecies()).toEqual(['clownfish']);
      roster.load({
        backgroundId: 'bg-fw-planted-stream',
        tankId: TANK_A,
        biome: 'freshwater',
        decorLayout: [],
        decorEdited: false,
        fish: [fishFixture(FISH_1, { species: 'betta' })],
      });
      expect(roster.swimmingSpecies()).toEqual(['betta']);
      roster.unload({ tankId: TANK_A, reason: 'switch' });
      expect(roster.swimmingSpecies()).toEqual([]);
      roster.none();
      expect(roster.swimmingSpecies()).toEqual(['clownfish']);
    });

    it('is empty when nothing swims', () => {
      expect(new TankRoster([]).swimmingSpecies()).toEqual([]);
      expect(loaded([]).swimmingSpecies()).toEqual([]);
    });

    it('hands out the same array until the swimming set changes', () => {
      const roster = loaded([fishFixture(FISH_1, { species: 'neon-tetra' })]);
      const first = roster.swimmingSpecies();
      roster.updated({
        tankId: TANK_A,
        fish: [fishFixture(FISH_1, { species: 'neon-tetra', hunger: 0.9 })],
      });
      expect(roster.swimmingSpecies()).toBe(first);
      roster.died({ tankId: TANK_A, fish: fishFixture(FISH_1, { status: 'dead', health: 0 }) });
      const after = roster.swimmingSpecies();
      expect(after).not.toBe(first);
      expect(after).toEqual([]);
    });
  });

  describe('updated', () => {
    it('follows the server hunger and health of a living fish', () => {
      const roster = loaded([fishFixture(FISH_1, { hunger: 0.1, health: 1 })]);
      const changed = roster.updated({
        tankId: TANK_A,
        fish: [fishFixture(FISH_1, { hunger: 0.7, health: 0.4 })],
      });
      const entry = roster.get(simId(roster, FISH_1));
      expect(entry?.hunger).toBe(0.7);
      expect(entry?.health).toBe(0.4);
      expect(changed).toEqual([entry]);
    });

    it('follows a disease from its onset through its cure', () => {
      const ich = {
        kind: 'ich',
        since: '2026-10-16T08:00:00.000Z',
        severity: 0.3,
        treatedUntil: null,
      } as const;
      const roster = loaded([fishFixture(FISH_1, { disease: ich })]);
      const entry = roster.get(simId(roster, FISH_1));
      expect(entry?.disease).toEqual(ich);
      const worse = { ...ich, severity: 0.8 };
      roster.updated({ tankId: TANK_A, fish: [fishFixture(FISH_1, { disease: worse })] });
      expect(entry?.disease).toEqual(worse);
      roster.updated({ tankId: TANK_A, fish: [fishFixture(FISH_1, { disease: null })] });
      expect(entry?.disease).toBeNull();
      expect(new TankRoster(DEMO).swimming().every((f) => f.disease === null)).toBe(true);
    });

    it('leaves the swimming set alone, so no new world is built', () => {
      const roster = loaded([fishFixture(FISH_1)]);
      const revision = roster.revision;
      roster.updated({ tankId: TANK_A, fish: [fishFixture(FISH_1, { health: 0.3 })] });
      expect(roster.revision).toBe(revision);
    });

    it('ignores dead fish, unknown fish and another tank', () => {
      const roster = loaded([fishFixture(FISH_1), fishFixture(FISH_2)]);
      roster.died({ tankId: TANK_A, fish: fishFixture(FISH_2, { status: 'dead' }) });
      expect(
        roster.updated({
          tankId: TANK_A,
          fish: [fishFixture(FISH_2, { health: 0.5 }), fishFixture(FISH_3, { health: 0.5 })],
        }),
      ).toEqual([]);
      expect(
        roster.updated({ tankId: TANK_B, fish: [fishFixture(FISH_1, { health: 0.5 })] }),
      ).toEqual([]);
      expect(roster.get(simId(roster, FISH_2))?.health).toBe(0);
      expect(roster.get(simId(roster, FISH_1))?.health).toBe(1);
    });
  });

  describe('translateAte', () => {
    it('reports bites under server ids while a saved tank is loaded', () => {
      const roster = loaded();
      const bites = roster.translateAte([
        { fishId: simId(roster, FISH_1), foodId: 3, portion: 0.1 },
        { fishId: simId(roster, FISH_2), foodId: 4, portion: 0.2 },
      ]);
      expect(bites).toEqual([
        { fishId: FISH_1, foodId: 3, portion: 0.1 },
        { fishId: FISH_2, foodId: 4, portion: 0.2 },
      ]);
    });

    it('drops bites from dead, bagged and unknown fish', () => {
      const roster = loaded();
      roster.add({ tankId: TANK_A, fish: fishFixture(FISH_3), acclimate: true });
      roster.died({ tankId: TANK_A, fish: fishFixture(FISH_2, { status: 'dead' }) });
      const bites = roster.translateAte([
        { fishId: simId(roster, FISH_2), foodId: 1, portion: 0.1 },
        { fishId: simId(roster, FISH_3), foodId: 2, portion: 0.1 },
        { fishId: 'fish-999', foodId: 3, portion: 0.1 },
        { fishId: FISH_1, foodId: 4, portion: 0.1 },
      ]);
      expect(bites).toEqual([]);
    });

    it('drops bites from the previous tank after a switch', () => {
      const roster = loaded();
      const stale = simId(roster, FISH_1);
      roster.load({
        backgroundId: 'bg-fw-planted-stream',
        tankId: TANK_B,
        biome: 'freshwater',
        decorLayout: [],
        decorEdited: false,
        fish: [fishFixture(FISH_3)],
      });
      expect(roster.translateAte([{ fishId: stale, foodId: 1, portion: 0.1 }])).toEqual([]);
    });

    it('takes what each fish ate off its hunger as the server does, never below zero', () => {
      const roster = loaded([
        fishFixture(FISH_1, { hunger: 0.7 }),
        fishFixture(FISH_2, { hunger: 0.1 }),
      ]);
      roster.translateAte([
        { fishId: simId(roster, FISH_1), foodId: 1, portion: 0.25 },
        { fishId: simId(roster, FISH_1), foodId: 2, portion: 0.25 },
        { fishId: simId(roster, FISH_2), foodId: 3, portion: 0.5 },
      ]);
      expect(roster.get(simId(roster, FISH_1))?.hunger).toBeCloseTo(0.7 - 0.5 * HUNGER_PER_PORTION);
      expect(roster.get(simId(roster, FISH_2))?.hunger).toBe(0);
    });

    it('leaves the hunger of fish whose bites it drops alone', () => {
      const roster = loaded([fishFixture(FISH_1, { hunger: 0.7 })]);
      roster.add({ tankId: TANK_A, fish: fishFixture(FISH_3, { hunger: 0.6 }), acclimate: true });
      roster.translateAte([{ fishId: simId(roster, FISH_3), foodId: 1, portion: 0.5 }]);
      expect(roster.get(simId(roster, FISH_3))?.hunger).toBe(0.6);
    });

    it('passes demo bites on under the demo ids', () => {
      const roster = new TankRoster(DEMO);
      const [neon] = roster.swimming();
      if (neon === undefined) throw new Error('demo stock is empty');
      expect(roster.translateAte([{ fishId: neon.simId, foodId: 1, portion: 0.1 }])).toEqual([
        { fishId: 'neon-tetra-0', foodId: 1, portion: 0.1 },
      ]);
    });
  });
});

describe('hashString', () => {
  it('is stable and spreads nearby keys', () => {
    expect(hashString(FISH_1)).toBe(hashString(FISH_1));
    expect(hashString(FISH_1)).not.toBe(hashString(FISH_2));
    expect(hashString('')).toBe(0x811c9dc5);
    expect(Number.isInteger(hashString('neon-tetra-0'))).toBe(true);
    expect(hashString('neon-tetra-0')).toBeGreaterThanOrEqual(0);
  });
});
