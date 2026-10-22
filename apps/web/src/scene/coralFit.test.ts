import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { coralContentSchema, type Coral, type DecorItem } from '@aquarium/shared';
import { TANK_DIMENSIONS } from '../engine/tank/dimensions';
import { AssetCatalog } from './assets';
import { grownCoralItem, placeFragments } from './coralGrowth';
import { SURFACE_MARGIN } from './plants';
import { boundsFromCatalog, fitPresetToTank, maxScaleAt, type FitModel } from './presetFit';
import { euphylliaId, parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';
import { reachCurrent } from './current';
import { DEFAULT_CURRENT, fitPresetToCatalog } from './TankScene';

const dimensions = TANK_DIMENSIONS.standard;
const halfL = dimensions.length / 2 - dimensions.glass;
const halfD = dimensions.depth / 2 - dimensions.glass;
const waterTop = dimensions.height - dimensions.freeboard;

let catalog: AssetCatalog;
let maxSizeOf: (assetId: string) => number;
let modelOf: (assetId: string) => FitModel | null;

beforeAll(async () => {
  const publicDir = join(__dirname, '../../public');
  const index = JSON.parse(await readFile(join(publicDir, 'assets/index.json'), 'utf8')) as {
    assets: ConstructorParameters<typeof AssetCatalog>[0];
  };
  catalog = new AssetCatalog(index.assets);
  const content = coralContentSchema.parse(
    JSON.parse(await readFile(join(__dirname, '../../../../content/corals.json'), 'utf8')),
  );
  const sizes = new Map(content.corals.map((c) => [c.id, c.maxSize]));
  maxSizeOf = (assetId) => sizes.get(assetId) ?? 2.5;
  modelOf = boundsFromCatalog(
    catalog,
    reachCurrent(loadPreset('reef').current ?? DEFAULT_CURRENT, 'reef'),
  );
});

const coralAt = (item: DecorItem, size: number): Coral => ({
  key: 's1',
  assetId: item.assetId,
  tintSeed: item.tintSeed ?? 1,
  parentKey: null,
  position: null,
  size,
  minSize: 0.3,
  maxSize: maxSizeOf(item.assetId),
  fragMinSize: 1.5,
  bleach: 0,
});

const isCoral = (item: DecorItem) =>
  parseEuphylliaId(item.assetId) !== null || catalog.get(item.assetId).kind === 'coral';

function reefCorals(): DecorItem[] {
  const fitted = fitPresetToCatalog(loadPreset('reef'), dimensions, catalog);
  return fitted.decor.filter((item) => isCoral(item));
}

function extentOf(item: DecorItem) {
  const model = modelOf(item.assetId);
  if (!model) throw new Error(`no bounds for ${item.assetId}`);
  const [x0 = 0, , z0 = 0] = model.bounds.min;
  const [x1 = 0, , z1 = 0] = model.bounds.max;
  const cos = Math.cos(item.rotationY);
  const sin = Math.sin(item.rotationY);
  const corners: [number, number][] = [
    [x0, z0],
    [x0, z1],
    [x1, z0],
    [x1, z1],
  ];
  return {
    x: Math.max(...corners.map(([x, z]) => Math.abs(x * cos + z * sin))) * item.scale,
    z: Math.max(...corners.map(([x, z]) => Math.abs(-x * sin + z * cos))) * item.scale,
    top: (model.bounds.max[1] ?? 0) * item.scale,
  };
}

const cap = (item: DecorItem) => maxScaleAt(item, dimensions, modelOf(item.assetId));

describe('the default reef at full growth', () => {
  it('has the corals the review measured', () => {
    const ids = new Set(reefCorals().map((i) => i.assetId));
    expect(ids).toContain('acropora-cytherea');
    expect(ids).toContain('acropora-palmata');
    expect(ids).toContain('brain-coral');
  });

  it('keeps every colony inside the glass and under the surface at its maximum size', () => {
    for (const item of reefCorals()) {
      const grown = grownCoralItem(item, coralAt(item, maxSizeOf(item.assetId)), cap);
      const { x, z, top } = extentOf(grown);
      expect(Math.abs(grown.position[0]) + x, item.assetId).toBeLessThanOrEqual(halfL);
      expect(Math.abs(grown.position[2]) + z, item.assetId).toBeLessThanOrEqual(halfD);
      expect(grown.position[1] + top, item.assetId).toBeLessThanOrEqual(
        waterTop - SURFACE_MARGIN + 1e-9,
      );
    }
  });

  it('stops the acroporas short of their species maximum where the glass is closer', () => {
    const limited = reefCorals().filter((item) => {
      const grown = grownCoralItem(item, coralAt(item, maxSizeOf(item.assetId)), cap);
      return grown.scale < item.scale * maxSizeOf(item.assetId) - 1e-9;
    });
    const ids = new Set(limited.map((i) => i.assetId));
    expect(ids).toContain('acropora-cytherea');
    expect(ids).toContain('acropora-palmata');
  });

  it('never shrinks a colony placed at its limit, nor grows it past the cap', () => {
    for (const item of reefCorals()) {
      const grown = grownCoralItem(item, coralAt(item, 1.5), cap);
      expect(grown.scale).toBeGreaterThanOrEqual(item.scale);
      expect(grown.scale).toBeLessThanOrEqual(Math.max(item.scale, cap(item)) + 1e-9);
    }
  });

  it('lets a fragged colony shrink below the cap', () => {
    const [item] = reefCorals();
    if (!item) throw new Error('no reef coral');
    expect(grownCoralItem(item, coralAt(item, 0.5), cap).scale).toBeCloseTo(item.scale * 0.5);
  });

  it('keeps a fragment beside the glass inside it as it grows', () => {
    const [root] = reefCorals().filter((i) => i.assetId === 'acropora-cytherea');
    if (!root) throw new Error('no cytherea');
    const colony = coralAt(root, 1);
    const frag: Coral = {
      ...colony,
      key: 's1.1',
      parentKey: 's1',
      position: [0, halfD - 0.03],
      size: 2.5,
    };
    const [placed] = placeFragments(
      [{ assetId: root.assetId, item: { ...root, tintSeed: 1 } }],
      [colony, frag],
      () => 0.05,
      cap,
    );
    if (!placed) throw new Error('fragment not placed');
    expect(Math.abs(placed.item.position[2]) + extentOf(placed.item).z).toBeLessThanOrEqual(halfD);
  });
});

describe('a fragment beside the glass', () => {
  it('stays inside it for a scale-1 root at the server edge margin', () => {
    const [template] = reefCorals().filter((i) => i.assetId === 'acropora-cytherea');
    if (!template) throw new Error('no cytherea');
    const root: DecorItem = { ...template, scale: 1, rotationY: 0, tintSeed: 1 };
    const colony = coralAt(root, 1);
    const frag: Coral = {
      ...colony,
      key: 's1.1',
      parentKey: 's1',
      position: [0, halfD - 0.03],
      size: 0.3,
    };
    const [placed] = placeFragments(
      [{ assetId: root.assetId, item: root }],
      [colony, frag],
      () => 0.05,
      cap,
    );
    if (!placed) throw new Error('fragment not placed');
    expect(placed.item.scale).toBeGreaterThan(0);
    expect(Math.abs(placed.item.position[2]) + extentOf(placed.item).z).toBeLessThanOrEqual(halfD);
  });
});

describe('a swaying fragment beside the glass', () => {
  it('is no smaller 7 cm from the glass than at the server edge margin', () => {
    const assetId = euphylliaId('hammer', 3);
    const root: DecorItem = {
      assetId,
      position: [0, 0.05, 0],
      rotationY: 0,
      scale: 1,
      tintSeed: 1,
    };
    const colony: Coral = { ...coralAt(root, 1), assetId };
    const scaleAt = (offGlass: number) => {
      const frag: Coral = {
        ...colony,
        key: 's1.1',
        parentKey: 's1',
        position: [0, halfD - offGlass],
        size: 0.3,
      };
      const [placed] = placeFragments([{ assetId, item: root }], [colony, frag], () => 0.05, cap);
      if (!placed) throw new Error('fragment not placed');
      return placed.item.scale;
    };
    expect(scaleAt(0.07)).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(scaleAt(0.07)).toBeGreaterThanOrEqual(scaleAt(0.03));
  });
});

describe('maxScaleAt', () => {
  it('is unbounded for an item with no model', () => {
    const [item] = reefCorals();
    if (!item) throw new Error('no reef coral');
    expect(maxScaleAt(item, dimensions, null)).toBe(Infinity);
  });

  it('is zero for an item already outside the glass', () => {
    const [item] = reefCorals();
    if (!item) throw new Error('no reef coral');
    const outside: DecorItem = { ...item, position: [10, item.position[1], 0] };
    expect(maxScaleAt(outside, dimensions, modelOf(item.assetId))).toBe(0);
  });

  it('agrees with the fit: a fitted preset item sits at or under its cap', () => {
    const fitted = fitPresetToTank(loadPreset('reef'), dimensions, modelOf, () => 0);
    for (const item of fitted.decor.filter((i) => isCoral(i))) {
      expect(cap(item)).toBeGreaterThanOrEqual(item.scale - 1e-6);
    }
  });
});
