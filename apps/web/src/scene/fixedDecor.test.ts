import type { DecorItem } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import { DecorWorld, type DecorScenePort } from '../interaction/decor/world';
import type { InteractionEvents } from '../interaction/events';
import catalogJson from '../../public/assets/index.json';
import { AssetCatalog, type CatalogEntry } from './assets';
import { parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';
import { fixedDecorOf } from './TankScene';

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
});
