import type { Collider, DecorItem, Plant } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import catalog from '../../../public/assets/index.json';
import { EventBus } from '../../engine/events';
import type { CatalogEntry } from '../../scene/assets';
import type { InteractionEvents } from '../events';
import { FeederLayer } from './feederLayer';
import { flat, item, must } from './fixtures';
import { DecorWorld, type DecorScenePort } from './world';

const preset: DecorItem[] = [item('java-fern', 0.1, 0, { tintSeed: 5 })];

const scene: DecorScenePort = {
  biome: 'freshwater',
  presetHardDecor: preset,
  fixedDecor: [],
  waterTop: 0.5,
  catalogEntries: () => catalog.assets as unknown as CatalogEntry[],
  groundHeight: flat,
  setHardDecor: () => Promise.resolve(),
  moveHardDecor: () => undefined,
};

const plant = (over: Partial<Plant> = {}): Plant => ({
  key: 's5',
  assetId: 'java-fern',
  tintSeed: 5,
  parentKey: null,
  position: null,
  size: 1,
  minSize: 0.4,
  maxSize: 3,
  ...over,
});

const offset = (): Plant => plant({ key: 's5.1', parentKey: 's5', position: [0.3, 0.1] });

function setup(port: DecorScenePort = scene) {
  const bus = new EventBus<InteractionEvents>();
  const emitted: (readonly Collider[])[] = [];
  bus.on('decor:colliders', (e) => emitted.push(e.colliders));
  const world = new DecorWorld(port, bus, new FeederLayer());
  void world.show(world.pieces);
  return { world, emitted };
}

const capsule = (colliders: readonly Collider[] | undefined, id: string) => {
  const found = must(colliders?.find((c) => c.id === id));
  if (found.kind !== 'capsule') throw new Error(`${id} is not a capsule`);
  return found;
};

describe('DecorWorld plant colliders', () => {
  it('reports a grown plant with a larger collider than its layout size', () => {
    const { world, emitted } = setup();
    const placed = capsule(emitted.at(-1), 'decor:p1');
    world.setPlants([plant({ size: 1.8 })]);
    const grown = capsule(emitted.at(-1), 'decor:p1');
    expect(grown.radius).toBeGreaterThan(placed.radius);
    expect(grown.b[1]).toBeGreaterThan(placed.b[1]);
  });

  it('gives an offset a collider where the offset stands', () => {
    const { world, emitted } = setup();
    world.setPlants([plant(), offset()]);
    const offsets = must(emitted.at(-1)).filter((c) => c.id.startsWith('decor:plant:'));
    expect(offsets).toHaveLength(1);
    const found = capsule(offsets, must(offsets[0]).id);
    expect(found.a[0]).toBe(0.3);
    expect(found.a[2]).toBe(0.1);
  });

  it('goes back to the placed capsule when the plant state clears', () => {
    const { world, emitted } = setup();
    const placed = emitted.at(-1);
    world.setPlants([plant({ size: 1.8 }), offset()]);
    world.setPlants(undefined);
    expect(emitted.at(-1)).toEqual(placed);
  });

  it('keeps the grown size when the pieces are shown again', () => {
    const { world, emitted } = setup();
    world.setPlants([plant({ size: 1.8 })]);
    const grown = capsule(emitted.at(-1), 'decor:p1');
    void world.show(world.pieces);
    expect(capsule(emitted.at(-1), 'decor:p1')).toEqual(grown);
  });

  it('reports placed capsules when the scene gives no water line', () => {
    const bare: DecorScenePort = {
      biome: scene.biome,
      presetHardDecor: scene.presetHardDecor,
      fixedDecor: scene.fixedDecor,
      catalogEntries: scene.catalogEntries,
      groundHeight: scene.groundHeight,
      setHardDecor: scene.setHardDecor,
      moveHardDecor: scene.moveHardDecor,
    };
    const { world, emitted } = setup(bare);
    const placed = emitted.at(-1);
    world.setPlants([plant({ size: 1.8 })]);
    expect(emitted.at(-1)).toEqual(placed);
  });
});
