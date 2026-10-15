import type { DecorItem } from '@aquarium/shared';
import { BoxGeometry, MeshStandardMaterial, Matrix4, Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import { DecorWorld, type DecorScenePort } from '../interaction/decor/world';
import type { InteractionEvents } from '../interaction/events';
import catalogJson from '../../public/assets/index.json';
import { AssetCatalog, type CatalogEntry, type LoadedModel } from './assets';
import { parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';
import {
  checkBelowSurface,
  fixedDecorOf,
  layoutPlantCollider,
  layoutPlantEntry,
  locateMovable,
  movableColliders,
} from './TankScene';
import { CurrentField } from './current';
import { PlantGroup } from './plants';

const entries = catalogJson.assets as unknown as CatalogEntry[];
const catalog = new AssetCatalog(entries);
const reef = loadPreset('reef');

describe('fixedDecorOf', () => {
  it('resolves the reef preset, keeping procedural corals as fixed decor', () => {
    const fixed = fixedDecorOf(reef.decor, catalog);
    const procedural = reef.decor.filter((i) => parseEuphylliaId(i.assetId));
    expect(procedural.length).toBeGreaterThan(0);
    for (const coral of procedural) expect(fixed).toContain(coral);
  });

  it('still throws on an unknown asset id', () => {
    const bogus = { ...(reef.decor[0] as DecorItem), assetId: 'no-such-asset' };
    expect(() => fixedDecorOf([bogus], catalog)).toThrow(/Unknown asset "no-such-asset"/);
  });

  it('lets the decorate world build over the reef preset', () => {
    const fixed = fixedDecorOf(reef.decor, catalog);
    const scene: DecorScenePort = {
      biome: 'reef',
      presetHardDecor: reef.decor.filter((i) => !fixed.includes(i)),
      fixedDecor: fixed,
      catalogEntries: () => entries,
      groundHeight: () => 0.06,
      setHardDecor: () => Promise.resolve(),
      moveHardDecor: vi.fn(),
    };
    const world = new DecorWorld(scene, new EventBus<InteractionEvents>(), {
      sync: vi.fn(),
      dispose: vi.fn(),
    });
    expect(world.layout()).toHaveLength(reef.decor.length);
  });

  it('never asks the model catalogue for a procedural coral, in any preset', () => {
    const lookups: string[] = [];
    const spy = { get: (id: string) => (lookups.push(id), catalog.get(id)) };
    for (const biome of ['freshwater', 'reef'] as const) {
      const preset = loadPreset(biome);
      fixedDecorOf(preset.decor, spy);
      for (const item of preset.decor) {
        if (parseEuphylliaId(item.assetId)) expect(lookups).not.toContain(item.assetId);
        else expect(() => catalog.get(item.assetId)).not.toThrow();
      }
    }
  });

  it('keeps corals through a saved reef layout without an API', async () => {
    const fixed = fixedDecorOf(reef.decor, catalog);
    const hard = reef.decor.filter((i) => !fixed.includes(i));
    const setHardDecor = vi.fn(() => Promise.resolve());
    const world = new DecorWorld(
      {
        biome: 'reef',
        presetHardDecor: hard,
        fixedDecor: fixed,
        catalogEntries: () => entries,
        groundHeight: () => 0.06,
        setHardDecor,
        moveHardDecor: vi.fn(),
      },
      new EventBus<InteractionEvents>(),
      { sync: vi.fn(), dispose: vi.fn() },
    );
    await world.showSaved(reef.decor);
    expect(setHardDecor).toHaveBeenCalledWith(hard);
    expect(world.layout()).toHaveLength(reef.decor.length);
  });
});

describe('movable plants', () => {
  const freshwater = loadPreset('freshwater');
  const plants = freshwater.decor.filter((i) => catalog.get(i.assetId).kind === 'plant');

  it('keeps layout plants fixed by default and frees them on request', () => {
    expect(plants.length).toBeGreaterThan(0);
    const fixed = fixedDecorOf(freshwater.decor, catalog);
    for (const plant of plants) expect(fixed).toContain(plant);
    const movable = fixedDecorOf(freshwater.decor, catalog, true);
    for (const plant of plants) expect(movable).not.toContain(plant);
    expect(movable).toHaveLength(fixed.length - plants.length);
  });

  it('never frees anemones or procedural corals', () => {
    const fixed = fixedDecorOf(reef.decor, catalog, true);
    expect(fixed.some((i) => catalog.get(i.assetId)?.kind === 'anemone')).toBe(true);
    expect(fixed.some((i) => parseEuphylliaId(i.assetId))).toBe(true);
  });

  it('draws a moved plant and its capsule at the new position', () => {
    const plant = { ...(plants[0] as DecorItem), scale: 8 };
    const entry = catalog.get(plant.assetId);
    const moved: DecorItem = { ...plant, position: [0.2, 0.06, -0.1] };
    expect(layoutPlantEntry(moved)).toMatchObject({ x: 0.2, y: 0.06, z: -0.1, rank: -1 });
    const before = layoutPlantCollider(entry, plant);
    const after = layoutPlantCollider(entry, moved);
    if (!before || !after) throw new Error('a scaled plant should be tall enough to collide');
    expect(after.hard).toBe(false);
    expect(after.a[0]).toBeCloseTo(0.2);
    expect(after.a[2]).toBeCloseTo(-0.1);
    expect(after.a[0]).not.toBeCloseTo(before.a[0]);
  });

  it('refuses a plant that would break the surface', () => {
    const plant = plants[0] as DecorItem;
    const entry = catalog.get(plant.assetId);
    expect(() => checkBelowSurface(entry, plant, 10)).not.toThrow();
    expect(() => checkBelowSurface(entry, { ...plant, position: [0, 0.4, 0] }, 0.4)).toThrow(
      /above the water line/,
    );
  });
});

describe('moveHardDecor index mapping', () => {
  const rock = freshwaterItem('boulder-01', [0, 0.05, 0]);
  const wood = freshwaterItem('driftwood-branch', [0.3, 0.05, 0]);
  const fernA = freshwaterItem('java-fern', [-0.2, 0.06, 0.1]);
  const fernB = freshwaterItem('java-fern', [-0.4, 0.06, 0.1]);
  const kinds = new Map([
    ['boulder-01', 'rock'],
    ['driftwood-branch', 'driftwood'],
    ['java-fern', 'plant'],
  ]);
  const movable = [rock, fernA, wood, fernB].map((item) => ({
    item,
    kind: kinds.get(item.assetId) as string,
  }));

  function freshwaterItem(assetId: string, position: [number, number, number]): DecorItem {
    return { assetId, position, rotationY: 0, scale: 8 };
  }

  it('counts hardscape slots without plants and plant ordinals per species', () => {
    expect(locateMovable(movable, 0)).toEqual({ kind: 'hardscape', index: 0 });
    expect(locateMovable(movable, 1)).toEqual({ kind: 'plant', assetId: 'java-fern', ordinal: 0 });
    expect(locateMovable(movable, 2)).toEqual({ kind: 'hardscape', index: 1 });
    expect(locateMovable(movable, 3)).toEqual({ kind: 'plant', assetId: 'java-fern', ordinal: 1 });
    expect(locateMovable(movable, 4)).toBeNull();
  });

  it('points each plant at its own collider among the rock and wood hulls', async () => {
    const library = {
      catalog,
      collisionGeometry: () => Promise.resolve([new BoxGeometry(0.1, 0.1, 0.1)]),
    };
    const { colliders, plantSlots } = await movableColliders(library, movable, 10);
    expect([...plantSlots.keys()]).toEqual([1, 3]);
    for (const [index, colliderIndex] of plantSlots) {
      const collider = colliders[colliderIndex];
      const item = (movable[index] as { item: DecorItem }).item;
      if (collider?.kind !== 'capsule') throw new Error('expected a plant capsule');
      expect(collider.hard).toBe(false);
      expect(collider.a[0]).toBeCloseTo(item.position[0]);
    }
    expect(colliders.filter((c) => c.hard).length).toBeGreaterThan(0);
  });

  it('rewrites the instance at the ordinal, ahead of the thinned patch plants', () => {
    const geometry = new BoxGeometry(0.1, 0.3, 0.1);
    const model: LoadedModel = { primitives: [{ geometry, material: new MeshStandardMaterial() }] };
    const patch = { ...layoutPlantEntry(fernA), x: 0.9, rank: 0.5 };
    const entries = [layoutPlantEntry(fernA), layoutPlantEntry(fernB), patch];
    const group = new PlantGroup('java-fern', model, entries, new CurrentField());
    const target = locateMovable(movable, 3);
    if (target?.kind !== 'plant') throw new Error('expected a plant target');
    group.setEntry(target.ordinal, layoutPlantEntry({ ...fernB, position: [0.5, 0.06, 0.2] }));
    const mesh = group.object.children[0] as unknown as {
      getMatrixAt(i: number, m: Matrix4): void;
    };
    const at = (i: number) => {
      const m = new Matrix4();
      mesh.getMatrixAt(i, m);
      return new Vector3().setFromMatrixPosition(m);
    };
    expect(at(0).x).toBeCloseTo(-0.2);
    expect(at(1).x).toBeCloseTo(0.5);
    expect(at(2).x).toBeCloseTo(0.9);
  });
});
