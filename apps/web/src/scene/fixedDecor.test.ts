import type { DecorItem } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import { DecorWorld, type DecorScenePort } from '../interaction/decor/world';
import type { InteractionEvents } from '../interaction/events';
import catalogJson from '../../public/assets/index.json';
import { AssetCatalog, type CatalogEntry } from './assets';
import { parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';
import {
  checkBelowSurface,
  fixedDecorOf,
  layoutPlantCollider,
  layoutPlantEntry,
} from './TankScene';

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
