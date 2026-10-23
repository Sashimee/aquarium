import type { Collider, DecorItem, Plant } from '@aquarium/shared';
import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import catalog from '../../../public/assets/index.json';
import { EventBus } from '../../engine/events';
import type { CatalogEntry } from '../../scene/assets';
import { grownItem, offsetEntries, type GrowthContext } from '../../scene/plantGrowth';
import { layoutPlantCollider } from '../../scene/TankScene';
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

const fern = must((catalog.assets as unknown as CatalogEntry[]).find((a) => a.id === 'java-fern'));
const fernBox = must(fern.bounds);

const context = (plants: Plant[]): GrowthContext => ({
  plants: new Map(plants.map((p) => [p.key, p])),
  ground: flat,
  waterTop: scene.waterTop ?? 0,
});

const ref = {
  key: 's5',
  item: must(preset[0]),
  height: fernBox.max[1],
  halfWidth: Math.max(fernBox.max[0], fernBox.max[2]),
};

describe('DecorWorld plant colliders', () => {
  it('matches the scene capsule for the grown plant', () => {
    const { world, emitted } = setup();
    const plants = [plant({ size: 1.8 })];
    world.setPlants(plants);
    const grownScale = grownItem(ref, context(plants));
    expect(grownScale.scale).toBeGreaterThan(1);
    const expected = must(layoutPlantCollider(fern, grownScale));
    const found = capsule(emitted.at(-1), 'decor:p1');
    expect(found.radius).toBeCloseTo(expected.radius, 9);
    found.a.forEach((v, k) => expect(v).toBeCloseTo(must(expected.a[k]), 9));
    found.b.forEach((v, k) => expect(v).toBeCloseTo(must(expected.b[k]), 9));
  });

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
    expect(found.a[0]).toBeCloseTo(0.3, 2);
    expect(found.a[2]).toBeCloseTo(0.1, 2);
  });

  it('keys an offset collider by its plant key, so removing another offset leaves it alone', () => {
    const { world, emitted } = setup();
    const second = plant({ key: 's5.2', parentKey: 's5', position: [-0.3, 0.05] });
    world.setPlants([plant(), offset(), second]);
    const ids = (list: readonly Collider[] | undefined) =>
      must(list)
        .filter((c) => c.id.startsWith('decor:plant:'))
        .map((c) => c.id);
    expect(ids(emitted.at(-1)).sort()).toEqual(['decor:plant:s5.1', 'decor:plant:s5.2']);
    const before = capsule(emitted.at(-1), 'decor:plant:s5.2');
    world.setPlants([plant(), second]);
    expect(ids(emitted.at(-1))).toEqual(['decor:plant:s5.2']);
    expect(capsule(emitted.at(-1), 'decor:plant:s5.2')).toEqual(before);
  });

  it('sizes an offset capsule as the scene sizes the offset', () => {
    const { world, emitted } = setup();
    const plants = [plant(), plant({ ...offset(), size: 1.5 })];
    world.setPlants(plants);
    const entry = must(offsetEntries([ref], context(plants)).get('java-fern')?.[0]);
    expect(entry.scale).toBeGreaterThan(1);
    const expected = must(
      layoutPlantCollider(fern, {
        assetId: 'java-fern',
        position: [entry.x, entry.y, entry.z],
        rotationY: 0,
        scale: entry.scale,
      }),
    );
    const found = capsule(emitted.at(-1), 'decor:plant:s5.1');
    expect(found.radius).toBeCloseTo(expected.radius, 9);
    expect(Math.hypot(...found.b.map((v, k) => v - must(found.a[k])))).toBeCloseTo(
      Math.hypot(...expected.b.map((v, k) => v - must(expected.a[k]))),
      9,
    );
  });

  it('tilts an offset capsule the way the scene draws the offset', () => {
    const { world, emitted } = setup();
    const plants = [plant(), offset()];
    world.setPlants(plants);
    const entry = must(offsetEntries([ref], context(plants)).get('java-fern')?.[0]);
    expect(Math.abs(entry.tiltX) + Math.abs(entry.tiltZ)).toBeGreaterThan(0.01);
    const found = capsule(emitted.at(-1), 'decor:plant:s5.1');
    const axis = found.b.map((v, k) => v - must(found.a[k]));
    const length = Math.hypot(...axis);
    const up = axis.map((v) => v / length);
    const object = new Object3D();
    object.rotation.set(entry.tiltX, entry.yaw, entry.tiltZ, 'YXZ');
    const drawn = new Vector3(0, 1, 0).applyQuaternion(object.quaternion);
    expect(up[0]).toBeCloseTo(drawn.x, 9);
    expect(up[1]).toBeCloseTo(drawn.y, 9);
    expect(up[2]).toBeCloseTo(drawn.z, 9);
    expect(Math.abs(must(up[0])) + Math.abs(must(up[2]))).toBeGreaterThan(0.001);
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
