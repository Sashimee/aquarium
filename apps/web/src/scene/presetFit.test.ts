import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DECOR_MIN_SCALE,
  keptPresetDecor,
  presetDecorCount,
  presetFit,
  type Biome,
  type DecorItem,
  type PlantPatch,
  type PresetLayout,
} from '@aquarium/shared';
import { AssetCatalog } from './assets';
import { offersShelter } from './caves';
import { loadPreset } from './preset';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { substrateHeight } from '../engine/tank/substrate';
import { TANK_SIZES } from '@aquarium/shared';
import {
  fitDepth,
  fitPresetToTank,
  footprintShare,
  MIN_PLANT_FIT,
  type BoundsOf,
} from './presetFit';

const boundsOf: BoundsOf = () => ({
  bounds: { min: [-0.2, 0, -0.2], max: [0.2, 0.1, 0.2] },
  swayReach: null,
});

describe('fitPresetToTank', () => {
  it('rests an item on the sand at the position the glass clamp moved it to', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      plantPatches: [],
      decor: [
        {
          assetId: 'rock',
          position: [0, substrateHeight(DEFAULT_TANK, 0, 0.2), 0.2],
          rotationY: 0,
          scale: 1,
        },
      ],
    };
    const [item] = fitPresetToTank(preset, 'standard', DEFAULT_TANK, boundsOf, () => 0).decor;
    const [x, y, z] = item?.position ?? [0, 0, 0];
    expect(z).toBeLessThan(0.1);
    expect(y).toBeCloseTo(substrateHeight(DEFAULT_TANK, x, z), 10);
  });

  it('keeps a back-row patch of swaying plants at its authored depth', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      plantPatches: [
        {
          id: 'back',
          assetId: 'weed',
          center: [0.1, -0.15],
          radius: 0.1,
          count: 16,
          scale: [0.6, 0.9],
          seed: 1,
        },
      ],
      decor: [],
    };
    const swaying = (scale: number) => 0.063 + 0.173 * scale;
    const std200 = { ...DEFAULT_TANK, length: 1, depth: 0.4 };
    const [patch] = fitPresetToTank(preset, 'std200', std200, boundsOf, (p) =>
      swaying(p.scale[1]),
    ).plantPatches;
    expect(patch?.center[1]).toBeLessThan(-0.07);
    expect(patch?.center[1]).toBeGreaterThanOrEqual((-0.15 * 0.4) / DEFAULT_TANK.depth);
  });

  describe('a smaller tank', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      decor: [],
      plantPatches: [
        {
          id: 'carpet',
          assetId: 'weed',
          center: [0, 0],
          radius: 0.2,
          count: 70,
          scale: [0.7, 1],
          seed: 1,
        },
      ],
    };
    const nano = { ...DEFAULT_TANK, ...TANK_SIZES.nano30.dimensions };

    it('keeps plants near life size and plants fewer of them, in step with the floor area', () => {
      const [patch] = fitPresetToTank(preset, 'nano30', nano, boundsOf, () => 0).plantPatches;
      expect(footprintShare('nano30')).toBeCloseTo((0.4 / 1.2) * (0.25 / 0.5), 6);
      expect(patch?.scale[0]).toBeGreaterThanOrEqual(0.7 * MIN_PLANT_FIT - 1e-9);
      expect(patch?.scale[1]).toBeGreaterThanOrEqual(MIN_PLANT_FIT - 1e-9);
      const plantScale = Math.max(presetFit('nano30').scale, MIN_PLANT_FIT);
      expect(patch?.count).toBe(Math.round((70 * footprintShare('nano30')) / plantScale ** 2));
    });

    it('keeps the authored coverage when plants shrink with the tank', () => {
      const mid = { ...DEFAULT_TANK, ...TANK_SIZES.std200.dimensions };
      const [patch] = fitPresetToTank(preset, 'std200', mid, boundsOf, () => 0).plantPatches;
      expect(patch?.count).toBe(70);
      expect(patch?.scale[1]).toBeCloseTo(0.8, 6);
    });

    it('shrinks the patch radius with the depth of a shallower tank', () => {
      const long = { ...DEFAULT_TANK, ...TANK_SIZES.long300.dimensions };
      const [patch] = fitPresetToTank(preset, 'long300', long, boundsOf, () => 0).plantPatches;
      expect(patch?.radius).toBeCloseTo(0.2 * Math.sqrt(0.9), 6);
    });

    it('keeps the authored patch on the standard tank and never grows past it', () => {
      const same = fitPresetToTank(preset, 'standard', DEFAULT_TANK, boundsOf, () => 0);
      expect(same.plantPatches).toEqual(preset.plantPatches);
      const long = { ...DEFAULT_TANK, ...TANK_SIZES.long300.dimensions };
      const [patch] = fitPresetToTank(preset, 'long300', long, boundsOf, () => 0).plantPatches;
      expect(patch?.count).toBeLessThanOrEqual(70);
    });
  });
});

describe('the decor a preset keeps on the nano tank', () => {
  const BIOMES: readonly Biome[] = ['freshwater', 'reef', 'cichlid', 'mangrove', 'blackwater'];
  let catalog: AssetCatalog;

  beforeAll(async () => {
    const index = JSON.parse(
      await readFile(join(__dirname, '../../public/assets/index.json'), 'utf8'),
    ) as { assets: ConstructorParameters<typeof AssetCatalog>[0] };
    catalog = new AssetCatalog(index.assets);
  });

  const kindOf = (item: DecorItem) =>
    catalog.has(item.assetId) ? catalog.get(item.assetId).kind : 'coral';
  const kindOfId = (id: string) => (catalog.has(id) ? catalog.get(id).kind : 'coral');
  const genus = (item: DecorItem) => item.assetId.split('-')[0];

  it.each(BIOMES)('%s keeps its anemone and every coral genus', (biome) => {
    const { decor } = loadPreset(biome);
    const kept = keptPresetDecor(decor, 'nano30');
    expect(kept.length).toBe(presetDecorCount(decor.length, 'nano30'));
    const same = (
      pick: (item: DecorItem) => boolean,
      key: (item: DecorItem) => string | undefined,
    ) => new Set(decor.filter(pick).map(key));
    for (const [what, pick, key] of [
      ['anemone', (i: DecorItem) => kindOf(i) === 'anemone', (i: DecorItem) => i.assetId],
      ['coral', (i: DecorItem) => kindOf(i) === 'coral', genus],
    ] as const) {
      const wanted = same(pick, key);
      const keptKinds = new Set(kept.filter(pick).map(key));
      expect([...keptKinds].sort(), `${biome} ${what}`).toEqual([...wanted].sort());
    }
  });

  it('keeps only the shelters a nano fish can still spawn beside', () => {
    const shelters = (biome: Biome) =>
      keptPresetDecor(loadPreset(biome).decor, 'nano30')
        .filter((item) => offersShelter(item.assetId))
        .map((item) => item.assetId);
    expect(new Set(shelters('cichlid'))).toEqual(new Set(['neothauma-shell']));
    expect(shelters('reef')).toEqual([]);
  });

  it('keeps a coral on the reef and a fern on the freshwater tank', () => {
    const keptIds = (biome: Biome) =>
      keptPresetDecor(loadPreset(biome).decor, 'nano30').map((item) => item.assetId);
    expect(keptIds('reef').filter((id) => kindOfId(id) === 'coral').length).toBeGreaterThan(0);
    expect(keptIds('freshwater')).toContain('java-fern');
  });

  it('holds decor at the minimum scale', () => {
    const preset: PresetLayout = {
      id: 'test',
      name: 'test',
      biome: 'freshwater',
      plantPatches: [],
      decor: [{ assetId: 'rock', position: [0, 0, 0], rotationY: 0, scale: 1 }],
    };
    const nano = { ...DEFAULT_TANK, ...TANK_SIZES.nano30.dimensions };
    const small: BoundsOf = () => ({
      bounds: { min: [-0.03, 0, -0.03], max: [0.03, 0.05, 0.03] },
      swayReach: null,
    });
    const [item] = fitPresetToTank(preset, 'nano30', nano, small, () => 0).decor;
    expect(item?.scale).toBeCloseTo(DECOR_MIN_SCALE, 6);
  });
});

describe('fitDepth', () => {
  it('leaves a patch that stays inside the limit alone', () => {
    expect(fitDepth(0.03, 0.04, 0.08)).toEqual({ radius: 0.03, depth: 0.04 });
    expect(fitDepth(0.04, -0.04, 0.08)).toEqual({ radius: 0.04, depth: -0.04 });
  });

  it('shrinks a patch that crosses to the room it has and keeps it inside', () => {
    const { radius, depth } = fitDepth(0.05, 0.05, 0.08);
    expect(radius).toBeCloseTo(0.03, 10);
    expect(depth + radius).toBeLessThanOrEqual(0.08 + 1e-12);
    expect(depth).toBeCloseTo(0.05, 10);
  });

  it('never shrinks below its minimum share, sliding the centre inwards instead', () => {
    const { radius, depth } = fitDepth(0.05, 0.075, 0.08);
    expect(radius).toBeCloseTo(0.05 * 0.45, 10);
    expect(depth).toBeCloseTo(0.08 - radius, 10);
  });

  it('mirrors for the back and is symmetric in sign', () => {
    const front = fitDepth(0.05, 0.075, 0.08);
    const back = fitDepth(0.05, -0.075, 0.08);
    expect(back.radius).toBe(front.radius);
    expect(back.depth).toBe(-front.depth);
  });

  it('centres a patch on the tank middle when even the minimum disc cannot fit', () => {
    const { radius, depth } = fitDepth(0.05, 0.05, 0.01);
    expect(radius).toBeCloseTo(0.05 * 0.45, 10);
    expect(depth).toBe(0);
  });
});

describe('plant patches the glass squeezes', () => {
  const patch = (center: [number, number]): PlantPatch => ({
    id: 'p',
    assetId: 'weed',
    center,
    radius: 0.2,
    count: 40,
    scale: [0.8, 1],
    seed: 1,
  });
  const layout = (center: [number, number]): PresetLayout => ({
    id: 'test',
    name: 'test',
    biome: 'freshwater',
    decor: [],
    plantPatches: [patch(center)],
  });
  const reach = (p: PlantPatch) => 0.01 + 0.2 * p.scale[1];
  const nano = { ...DEFAULT_TANK, ...TANK_SIZES.nano30.dimensions };
  const mid = { ...DEFAULT_TANK, ...TANK_SIZES.std200.dimensions };

  it('shrinks the plants and the disc of a front patch that crosses the nano glass', () => {
    const authored = layout([0, 0.12]);
    const [fitted] = fitPresetToTank(authored, 'nano30', nano, boundsOf, reach).plantPatches;
    const [unfitted] = fitPresetToTank(
      layout([0, 0.0]),
      'nano30',
      nano,
      boundsOf,
      reach,
    ).plantPatches;
    expect(fitted?.scale[0]).toBeLessThan(unfitted?.scale[0] ?? 0);
    expect(fitted?.radius).toBeLessThan(unfitted?.radius ?? 0);
    expect(fitted?.count).toBeLessThan(unfitted?.count ?? 0);
  });

  it('keeps the density of a disc that shrank', () => {
    const [fitted] = fitPresetToTank(
      layout([0, 0.12]),
      'nano30',
      nano,
      boundsOf,
      reach,
    ).plantPatches;
    const [open] = fitPresetToTank(layout([0, 0]), 'nano30', nano, boundsOf, reach).plantPatches;
    const density = (p?: PlantPatch) => (p?.count ?? 0) / (Math.PI * (p?.radius ?? 1) ** 2);
    expect(density(fitted)).toBeGreaterThan(density(open) * 0.6);
    expect(density(fitted)).toBeLessThan(density(open) * 1.6);
  });

  it('lowers the plants of a back patch rather than shrinking its disc', () => {
    const [fitted] = fitPresetToTank(
      layout([0, -0.12]),
      'nano30',
      nano,
      boundsOf,
      reach,
    ).plantPatches;
    const [open] = fitPresetToTank(layout([0, 0]), 'nano30', nano, boundsOf, reach).plantPatches;
    expect(fitted?.scale[0]).toBeLessThan(open?.scale[0] ?? 0);
    expect(fitted?.radius).toBe(open?.radius);
    expect(fitted?.count).toBe(open?.count);
  });

  it('leaves a patch alone that does not cross the nano glass', () => {
    const [fitted] = fitPresetToTank(
      layout([0, 0]),
      'nano30',
      nano,
      boundsOf,
      () => 0.01,
    ).plantPatches;
    const full = Math.max(presetFit('nano30').scale, MIN_PLANT_FIT);
    expect(fitted?.scale[0]).toBeCloseTo(0.8 * full, 10);
    expect(fitted?.center[1]).toBe(0);
  });

  it('does not touch a larger tank that holds no plants above its scale', () => {
    const [fitted] = fitPresetToTank(layout([0, 0.3]), 'std200', mid, boundsOf, reach).plantPatches;
    expect(fitted?.scale[0]).toBeCloseTo(0.8 * presetFit('std200').scale, 10);
    expect(fitted?.radius).toBeCloseTo(
      0.2 * Math.sqrt(Math.min(footprintShare('std200'), presetFit('std200').depthRatio)),
      10,
    );
  });
});
