import type { Collider, Coral, DecorItem } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import catalog from '../../../public/assets/index.json';
import { TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import { EventBus } from '../../engine/events';
import type { CatalogEntry } from '../../scene/assets';
import type { InteractionEvents } from '../events';
import { FeederLayer } from './feederLayer';
import { flat, item, must } from './fixtures';
import { DecorWorld, type DecorScenePort } from './world';

const preset: DecorItem[] = [
  item('boulder-01', -0.3, 0),
  item('acropora-cytherea', 0.1, 0, { tintSeed: 7 }),
];

const scene: DecorScenePort = {
  biome: 'reef',
  presetHardDecor: preset,
  fixedDecor: [],
  catalogEntries: () => catalog.assets as unknown as CatalogEntry[],
  groundHeight: flat,
  setHardDecor: () => Promise.resolve(),
  moveHardDecor: () => undefined,
};

const coral = (over: Partial<Coral> = {}): Coral => ({
  key: 's7',
  assetId: 'acropora-cytherea',
  tintSeed: 7,
  parentKey: null,
  position: null,
  size: 1,
  minSize: 0.4,
  maxSize: 3,
  fragMinSize: 1.5,
  bleach: 0,
  ...over,
});

function setup(withEnv = true) {
  const bus = new EventBus<InteractionEvents>();
  const emitted: (readonly Collider[])[] = [];
  bus.on('decor:colliders', (e) => emitted.push(e.colliders));
  const world = new DecorWorld(
    scene,
    bus,
    new FeederLayer(),
    withEnv
      ? { dimensions: () => TANK_DIMENSIONS.standard, proceduralBounds: () => null }
      : undefined,
  );
  return { world, emitted };
}

const widthOf = (colliders: readonly Collider[] | undefined, id: string): number => {
  const box = must(colliders?.find((c) => c.id === id));
  if (box.kind !== 'box') throw new Error(`${id} is not a box`);
  return box.halfExtents[0];
};

describe('DecorWorld coral colliders', () => {
  it('re-reports the colliders when a coral grows, wider each time', () => {
    const { world, emitted } = setup();
    void world.show(world.pieces);
    const placed = widthOf(emitted.at(-1), 'decor:p2');
    world.setCorals([coral({ size: 1.3 })]);
    const mid = widthOf(emitted.at(-1), 'decor:p2');
    world.setCorals([coral({ size: 1.8 })]);
    const full = widthOf(emitted.at(-1), 'decor:p2');
    expect(mid).toBeGreaterThan(placed);
    expect(full).toBeGreaterThan(mid);
  });

  it('shrinks the collider again when the colony is fragged and adds the fragment', () => {
    const { world, emitted } = setup();
    world.setCorals([coral({ size: 1.8 })]);
    const big = widthOf(emitted.at(-1), 'decor:p2');
    world.setCorals([
      coral({ size: 1.5 }),
      coral({ key: 's7.1', parentKey: 's7', position: [0.3, 0.1], size: 0.3 }),
    ]);
    expect(widthOf(emitted.at(-1), 'decor:p2')).toBeLessThan(big);
    expect(emitted.at(-1)?.some((c) => c.id === 'decor:coral:s7.1')).toBe(true);
  });

  it('goes back to the placed boxes when the coral state clears', () => {
    const { world, emitted } = setup();
    world.setCorals([coral({ size: 1.8 })]);
    world.setCorals(undefined);
    expect(emitted.at(-1)?.map((c) => c.id)).toEqual(['decor:p1', 'decor:p2']);
    const placed = emitted.at(-1);
    world.setCorals([]);
    expect(emitted.at(-1)).toEqual(placed);
  });

  it('keeps reporting grown colliders when the pieces are shown again', () => {
    const { world, emitted } = setup();
    world.setCorals([coral({ size: 1.8 })]);
    const grown = widthOf(emitted.at(-1), 'decor:p2');
    void world.show(world.pieces);
    expect(widthOf(emitted.at(-1), 'decor:p2')).toBe(grown);
  });

  it('reports placed boxes when the world has no tank to size growth by', () => {
    const { world, emitted } = setup(false);
    world.setCorals([coral({ size: 1.8 })]);
    expect(emitted.at(-1)?.map((c) => c.id)).toEqual(['decor:p1', 'decor:p2']);
  });
});
