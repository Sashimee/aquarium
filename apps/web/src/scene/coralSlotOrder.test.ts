import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Coral, DecorItem } from '@aquarium/shared';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { AssetCatalog } from './assets';
import {
  coralScaleCap,
  coralSlotOrder,
  type ScaleCap,
  placeFragments,
  grownEuphylliaCapsule,
  grownCoralItem,
  matchLayoutCorals,
} from './coralGrowth';
import {
  euphylliaCapsule,
  euphylliaCollider,
  generateEuphyllia,
  parseEuphylliaId,
} from './euphyllia';
import { routeDecor } from './decorRouting';
import { loadPreset } from './preset';
import { reachCurrent } from './current';
import { maxScaleAt } from './presetFit';
import { DEFAULT_CURRENT, fitPresetToCatalog } from './TankScene';

let catalog: AssetCatalog;

beforeAll(async () => {
  const index = JSON.parse(
    await readFile(join(__dirname, '../../public/assets/index.json'), 'utf8'),
  ) as { assets: ConstructorParameters<typeof AssetCatalog>[0] };
  catalog = new AssetCatalog(index.assets);
});

const isEuphyllia = (assetId: string) => parseEuphylliaId(assetId) !== null;
const kindOf = (assetId: string) => catalog.get(assetId).kind;

const orderOf = (decor: readonly DecorItem[], edited = decor) => {
  const { hardItems, euphylliaItems } = routeDecor(edited, kindOf);
  return coralSlotOrder(
    decor,
    kindOf,
    hardItems,
    euphylliaItems.map((entry) => entry.item),
  );
};

const isHardCoral = (assetId: string) => !isEuphyllia(assetId) && kindOf(assetId) === 'coral';

const reef = () =>
  fitPresetToCatalog(loadPreset('reef'), 'standard', TANK_DIMENSIONS.standard, catalog);

describe('coralSlotOrder', () => {
  it('follows the preset order across hard corals, repeated assets and euphyllia', () => {
    const decor = reef().decor;
    const slots = orderOf(decor);
    const expected = decor.filter((item) => isEuphyllia(item.assetId) || isHardCoral(item.assetId));
    expect(slots.map((s) => s.item)).toEqual(expected);
    expect(slots.filter((s) => s.assetId === 'brain-coral')).toHaveLength(3);
    expect(slots.filter((s) => 'euphyllia' in s.origin)).toHaveLength(2);
  });

  it('points each origin at the list entry the scene renders for that slot', () => {
    const decor = reef().decor;
    const { hardItems, euphylliaItems } = routeDecor(decor, kindOf);
    const euphyllias = euphylliaItems.map((entry) => entry.item);
    for (const slot of orderOf(decor)) {
      const source =
        'hard' in slot.origin
          ? hardItems[slot.origin.hard]?.item
          : euphyllias[slot.origin.euphyllia];
      expect(source).toBe(slot.item);
    }
  });

  it('puts an extra hard coral after the preset ones and an edited piece in place', () => {
    const decor = reef().decor;
    const first = decor.findIndex((d) => isHardCoral(d.assetId));
    const original = decor[first] as DecorItem;
    const moved: DecorItem = { ...original, position: [0.2, 0.1, 0.1] };
    const extra: DecorItem = { ...original, tintSeed: 77 };
    const edited = decor.map((d, i) => (i === first ? moved : d));
    const slots = orderOf(decor, [...edited, extra]);
    expect(slots.slice(0, -1).map((s) => s.assetId)).toEqual(orderOf(decor).map((s) => s.assetId));
    expect(slots.at(-1)?.item).toBe(extra);
    expect(slots.some((s) => s.item === moved)).toBe(true);
  });

  it('numbers repeated tint seeds in this order for matchLayoutCorals', () => {
    const decor = reef().decor.map((d) => (isHardCoral(d.assetId) ? { ...d, tintSeed: 5 } : d));
    const slots = orderOf(decor);
    const hardSlots = slots.map((s, i) => [s, i] as const).filter(([s]) => 'hard' in s.origin);
    const corals: Coral[] = hardSlots.map(([s], n) => ({
      key: n === 0 ? 's5' : `s5-${n + 1}`,
      assetId: s.assetId,
      tintSeed: 5,
      parentKey: null,
      position: null,
      size: 1 + n / 10,
      minSize: 0.3,
      maxSize: 2.5,
      fragMinSize: 1.5,
      bleach: 0,
    }));
    const matched = matchLayoutCorals(slots, corals);
    expect(matched.size).toBe(corals.length);
    hardSlots.forEach(([, slotIndex], n) => {
      expect(matched.get(slotIndex)?.key).toBe(corals[n]?.key);
    });
  });
});

const capOf = (scale: number, sways: boolean): ScaleCap =>
  Object.assign(() => scale, { sways: () => sways });

describe('euphyllia capsule', () => {
  const mesh = generateEuphyllia('hammer', 3, 1);
  const item: DecorItem = {
    assetId: 'euphyllia-hammer-3',
    position: [0.1, 0.07, 0.05],
    rotationY: 0.4,
    scale: 1,
  };
  const coral = (size: number): Coral => ({
    key: 's1',
    assetId: item.assetId,
    tintSeed: 1,
    parentKey: null,
    position: null,
    size,
    minSize: 0.3,
    maxSize: 2.5,
    fragMinSize: 1.5,
    bleach: 0,
  });

  it('grows with the colony', () => {
    const placed = euphylliaCapsule(mesh.bounds, item);
    const grown = grownEuphylliaCapsule(mesh.bounds, item, coral(2), capOf(Infinity, false));
    expect(grown.radius).toBeCloseTo(placed.radius * 2);
    expect(grown.height).toBeCloseTo(placed.height * 2, 6);
    expect(Math.hypot(...grown.lean)).toBeCloseTo(Math.hypot(...placed.lean) * 2, 6);
  });

  it('is held to the scale cap and unchanged without coral state', () => {
    expect(
      grownEuphylliaCapsule(mesh.bounds, item, coral(2), capOf(1.25, false)).radius,
    ).toBeCloseTo(euphylliaCapsule(mesh.bounds, { ...item, scale: 1.25 }).radius);
    expect(grownEuphylliaCapsule(mesh.bounds, item, undefined, capOf(1.25, false))).toEqual(
      euphylliaCapsule(mesh.bounds, item),
    );
  });

  it('leans by the mesh offset, turned with the item', () => {
    const bounds = {
      min: [0, 0, -0.01] as [number, number, number],
      max: [0.04, 0.1, 0.01] as [number, number, number],
    };
    const flat = euphylliaCapsule(bounds, { ...item, rotationY: 0, scale: 1 });
    expect(flat.lean[0]).toBeCloseTo(0.02);
    expect(flat.lean[1]).toBeCloseTo(0);
    const turned = euphylliaCapsule(bounds, { ...item, rotationY: Math.PI / 2, scale: 1 });
    expect(turned.lean[0]).toBeCloseTo(0);
    expect(turned.lean[1]).toBeCloseTo(-0.02);
  });

  it('is the capsule the scene collider is built from', () => {
    const capsule = euphylliaCapsule(mesh.bounds, item);
    const collider = euphylliaCollider(mesh.bounds, item);
    expect(collider.b[0] - collider.a[0]).toBeCloseTo(capsule.lean[0]);
    expect(collider.b[2] - collider.a[2]).toBeCloseTo(capsule.lean[1]);
    expect(collider.b[1] - collider.a[1]).toBeCloseTo(capsule.height);
    expect((collider.a[1] + collider.b[1]) / 2).toBeCloseTo(capsule.centre[1]);
    expect(collider.radius).toBe(capsule.radius);
  });
});

describe('grown euphyllia capsule near the glass', () => {
  const dimensions = TANK_DIMENSIONS.standard;
  const current = () => reachCurrent(loadPreset('reef').current ?? DEFAULT_CURRENT, 'reef');
  const mesh = generateEuphyllia('hammer', 3, 2);
  const nearGlass: DecorItem = {
    assetId: 'euphyllia-hammer-3',
    position: [dimensions.length / 2 - dimensions.glass - 0.25, 0.07, 0],
    rotationY: 0.4,
    scale: 1,
  };
  const grownColony: Coral = {
    key: 's1',
    assetId: nearGlass.assetId,
    tintSeed: 1,
    parentKey: null,
    position: null,
    size: 2.5,
    minSize: 0.3,
    maxSize: 2.5,
    fragMinSize: 1.5,
    bleach: 0,
  };

  it('gives a capsule matching the collider built from the same shared cap', () => {
    const cap = coralScaleCap(catalog, dimensions, current());
    const capsule = grownEuphylliaCapsule(mesh.bounds, nearGlass, grownColony, cap);
    const collider = euphylliaCollider(mesh.bounds, grownCoralItem(nearGlass, grownColony, cap));
    expect(capsule.radius).toBe(collider.radius);
    expect(capsule.centre[0] - capsule.lean[0] / 2).toBeCloseTo(collider.a[0]);
    expect(capsule.centre[0] + capsule.lean[0] / 2).toBeCloseTo(collider.b[0]);
    expect(capsule.centre[1] + capsule.height / 2).toBeCloseTo(collider.b[1]);
  });

  it('is held back by the colony sway reach, which a rigid cap would ignore', () => {
    const cap = coralScaleCap(catalog, dimensions, current());
    const capped = grownCoralItem(nearGlass, grownColony, cap).scale;
    const rigid = maxScaleAt(nearGlass, dimensions, { bounds: mesh.bounds, swayReach: null });
    expect(capped).toBeGreaterThan(nearGlass.scale);
    expect(capped).toBeLessThan(grownColony.size * nearGlass.scale);
    expect(capped).toBeLessThan(rigid);
  });

  it('flags a euphyllia as swaying and a hard coral as rigid', () => {
    const cap = coralScaleCap(catalog, dimensions, current());
    expect(cap.sways(nearGlass)).toBe(true);
    expect(cap.sways({ ...nearGlass, assetId: 'brain-coral' })).toBe(false);
  });

  describe.each([0.005, 0.01])('a fragment %s m from the glass', (gap) => {
    const floor = 0.25 * nearGlass.scale;
    const place = (assetId: string) => {
      const cap = coralScaleCap(catalog, dimensions, current());
      const root = { ...nearGlass, assetId, tintSeed: 1 };
      const colony = { ...grownColony, assetId, size: 1 };
      const fragment: Coral = {
        ...grownColony,
        assetId,
        key: 's1.1',
        parentKey: 's1',
        position: [dimensions.length / 2 - dimensions.glass - gap, 0.05],
        size: 1,
        minSize: 1,
      };
      const [placed] = placeFragments(
        [{ assetId, item: root }],
        [colony, fragment],
        () => 0.07,
        cap,
      );
      return { placed, capAt: placed ? cap(placed.item) : NaN };
    };

    it('floors a euphyllia fragment with the real cap', () => {
      const sway = place(nearGlass.assetId);
      expect(sway.capAt).toBeLessThan(floor);
      expect(sway.placed?.item.scale).toBeCloseTo(floor);
    });

    it('holds a hard coral fragment to its cap, below the floor', () => {
      const rigid = place('brain-coral');
      expect(rigid.capAt).toBeLessThan(floor);
      expect(rigid.capAt).toBeGreaterThanOrEqual(0);
      expect(rigid.placed?.item.scale).toBeCloseTo(rigid.capAt);
    });
  });
});
