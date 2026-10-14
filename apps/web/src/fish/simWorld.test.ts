import { describe, expect, it } from 'vitest';
import { World } from '@aquarium/sim';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import type { SceneAnchor } from '../scene/anemone';
import { FISH_1, FISH_2, TANK_A, fishFixture } from '../sync/fixtures';
import { demoTank, sceneAnchorsToSim } from './demoStock';
import { TankRoster } from './roster';
import { allSpeciesInputs } from './species';
import { layoutChanges, SimWorldSpec } from './simWorld';

const DEMO = demoTank(DEFAULT_TANK, 7, 'reef');
const ANEMONE: SceneAnchor = {
  id: 'anemone-1',
  kind: 'anemone',
  position: [0.15, 0.22, -0.05],
  radius: 0.06,
};
const MOVED: SceneAnchor = { ...ANEMONE, position: [-0.2, 0.2, 0.05] };
const CLOWN = { species: 'ocellaris-clownfish' } as const;

function setup(): { spec: SimWorldSpec; roster: TankRoster } {
  return { spec: new SimWorldSpec(DEMO, 7), roster: new TankRoster(DEMO.config.fish) };
}

function anchorsOf(spec: SimWorldSpec, roster: TankRoster): unknown {
  return spec.config(roster.swimming())?.anchors;
}

describe('SimWorldSpec', () => {
  it('starts a world without homes until the scene sends them', () => {
    const { spec, roster } = setup();
    expect(anchorsOf(spec, roster)).toEqual([]);
  });

  it('hands the latest colliders to every new world, which the sim accepts', () => {
    const { spec, roster } = setup();
    expect(spec.config(roster.swimming())?.decor).toEqual([]);
    spec.decor = [
      { id: 'scene:0', kind: 'sphere', hard: true, center: [0, 0.25, 0], radius: 0.05 },
    ];
    const config = spec.config(roster.swimming());
    expect(config?.decor).toBe(spec.decor);
    if (config === null) throw new Error('the demo has no world');
    expect(() => new World(config)).not.toThrow();
  });

  it('hands the scene anchors, in the sim frame, to every world after them', () => {
    const { spec, roster } = setup();
    const sim = spec.setAnchors([ANEMONE]);
    expect(sim).toEqual(sceneAnchorsToSim([ANEMONE], DEMO));
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      fish: [fishFixture(FISH_1, CLOWN)],
    });
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.add({ tankId: TANK_A, fish: fishFixture(FISH_2, CLOWN), acclimate: true });
    roster.release({ tankId: TANK_A, fishId: FISH_2 });
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.died({ tankId: TANK_A, fish: fishFixture(FISH_1, { ...CLOWN, status: 'dead' }) });
    expect(anchorsOf(spec, roster)).toEqual(sim);

    roster.unload({ tankId: TANK_A, reason: 'switch' });
    expect(anchorsOf(spec, roster)).toEqual(sim);
  });

  it('uses the latest anchors once the scene moves them', () => {
    const { spec, roster } = setup();
    spec.setAnchors([ANEMONE]);
    const moved = spec.setAnchors([MOVED]);
    expect(anchorsOf(spec, roster)).toEqual(moved);
    expect(moved).not.toEqual(sceneAnchorsToSim([ANEMONE], DEMO));
  });

  it('builds a world the sim accepts, homes included', () => {
    const { spec, roster } = setup();
    spec.setAnchors([ANEMONE]);
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the reef demo stock has no world');
    expect(config.fish.map((f) => f.species)).toContain('ocellaris-clownfish');
    expect(() => new World(config)).not.toThrow();
  });

  it('spawns saved fish under their sim ids and sizes, skipping species with no content', () => {
    const { spec, roster } = setup();
    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      fish: [
        fishFixture(FISH_1, { ...CLOWN, size: 0.07 }),
        fishFixture(FISH_2, { species: 'coelacanth' }),
      ],
    });
    const config = spec.config(roster.swimming());
    expect(config?.fish).toEqual([
      { id: roster.simIdOf(FISH_1), species: 'ocellaris-clownfish', bodyLengthM: 0.07 },
    ]);
    expect(config?.species).toBe(allSpeciesInputs());
    expect(config?.seed).toBe(7);
    expect(config?.space).toBe(DEMO.config.space);
  });

  it('builds a world that can take in a fish of a species it started without', () => {
    const { spec, roster } = setup();
    roster.load({
      tankId: TANK_A,
      biome: 'reef',
      decorLayout: [],
      fish: [fishFixture(FISH_1, CLOWN)],
    });
    const config = spec.config(roster.swimming());
    if (config === null) throw new Error('the clownfish tank has no world');
    const world = new World(config);
    expect(() => world.addFish({ id: 'tang', species: 'blue-tang' })).not.toThrow();
    expect(world.fishIds).toEqual([roster.simIdOf(FISH_1), 'tang']);
  });

  it('has no world to run when nothing swims', () => {
    const { spec, roster } = setup();
    roster.load({ tankId: TANK_A, biome: 'reef', decorLayout: [], fish: [] });
    expect(spec.config(roster.swimming())).toBeNull();
  });
});

describe('layoutChanges', () => {
  const spawn = (id: string) => ({ id, species: 'neon-tetra' });

  it('adds the newcomers and removes the leavers, leaving the rest alone', () => {
    const { remove, add } = layoutChanges(['a', 'b', 'c'], [spawn('a'), spawn('c'), spawn('d')]);
    expect(remove).toEqual(['b']);
    expect(add).toEqual([spawn('d')]);
  });

  it('changes nothing when the world already holds the wanted fish', () => {
    expect(layoutChanges(new Set(['a', 'b']), [spawn('b'), spawn('a')])).toEqual({
      remove: [],
      add: [],
    });
  });

  it('fills an empty world and empties a full one', () => {
    expect(layoutChanges([], [spawn('a')])).toEqual({ remove: [], add: [spawn('a')] });
    expect(layoutChanges(['a'], [])).toEqual({ remove: ['a'], add: [] });
  });
});
