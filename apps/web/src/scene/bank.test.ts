import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import {
  isDecorAssetForBiome,
  presetFit,
  type Biome,
  type DecorItem,
  type TankSize,
} from '@aquarium/shared';
import { TANK_DIMENSIONS, WATER_INSET } from '../engine/tank/dimensions';
import catalog from '../../public/assets/index.json';
import { BANK_CLEARANCE, BANK_RIM_MARGIN, bankAnchors, BANK_TOPS, isPerch } from './bank';
import { decorMatrix } from './hardscape';
import {
  generateMudBank,
  MUD_BANK_FLAT,
  MUD_BANK_ID,
  MUD_BANK_TOP,
  mudBankBounds,
} from './mudBank';
import { fitPresetToTank, type BoundsOf } from './presetFit';
import { loadPreset } from './preset';

type Tank = (typeof TANK_DIMENSIONS)[TankSize];
const standard = TANK_DIMENSIONS.standard;
const waterTop = (d: Tank) => d.height - d.freeboard;
const reach = (d: Tank) => ({
  halfX: d.length / 2 - d.glass - WATER_INSET,
  halfZ: d.depth / 2 - d.glass - WATER_INSET,
});
const stump = (over: Partial<DecorItem>): DecorItem => ({
  assetId: 'mangrove-stump',
  position: [0, 0.06, 0],
  rotationY: 0,
  scale: 1.55,
  ...over,
});

const entries = new Map(catalog.assets.map((a) => [a.id, a]));
const boundsOf: BoundsOf = (assetId) => {
  if (assetId === MUD_BANK_ID) return { bounds: mudBankBounds(), swayReach: null };
  const bounds = entries.get(assetId)?.bounds;
  return bounds ? { bounds, swayReach: null } : null;
};

function fittedBanks(size: TankSize) {
  const d = TANK_DIMENSIONS[size];
  const fitted = fitPresetToTank(loadPreset('mangrove'), size, d, boundsOf, () => 0);
  return { d, fitted, banks: bankAnchors(fitted.decor, waterTop(d), reach(d)) };
}

const isStumpBank = (b: { radius: number }) => b.radius < MUD_BANK_FLAT.z;

describe('bank anchors on the fitted mangrove preset', () => {
  it.each(['standard', 'std200', 'long300'] satisfies TankSize[])(
    '%s keeps the stump perch and the mud bank above the water, under the rim',
    (size) => {
      const { d, banks } = fittedBanks(size);
      expect(banks).toHaveLength(2);
      expect(banks.filter(isStumpBank)).toHaveLength(1);
      for (const bank of banks) {
        expect(bank.kind).toBe('bank');
        expect(bank.position[1]).toBeGreaterThanOrEqual(waterTop(d) + BANK_CLEARANCE);
        expect(bank.position[1]).toBeLessThan(d.height - BANK_RIM_MARGIN);
      }
    },
  );

  it('keeps the ordinary stump under the water in every tank', () => {
    for (const size of ['standard', 'std200', 'long300', 'nano30'] satisfies TankSize[]) {
      const { d, fitted } = fittedBanks(size);
      const peaks = fitted.decor
        .filter((i) => i.assetId === 'mangrove-stump')
        .map((i) => i.position[1] + 0.28 * i.scale)
        .sort((a, b) => a - b);
      expect(peaks.length, size).toBe(2);
      expect(peaks[0], size).toBeLessThan(waterTop(d));
    }
  });

  it('demotes the nano perch to ordinary wood: no flag, held at the minimum decor scale', () => {
    const { fitted } = fittedBanks('nano30');
    const authored = loadPreset('mangrove').decor.find((i) => i.perch);
    const demoted = fitted.decor.filter((i) => i.assetId === 'mangrove-stump' && i.scale < 1);
    expect(authored).toBeDefined();
    expect(demoted).toHaveLength(2);
    for (const item of demoted) expect(item.perch).toBeUndefined();
    const { decorScale } = presetFit('nano30');
    const ordinary = loadPreset('mangrove').decor.find(
      (i) => i.assetId === 'mangrove-stump' && !i.perch,
    );
    const scales = demoted.map((i) => i.scale).sort();
    expect(scales).toContainEqual(expect.closeTo((ordinary?.scale ?? 0) * decorScale, 3));
    expect(Math.max(...scales)).toBeLessThanOrEqual((authored?.scale ?? 0) * decorScale + 1e-9);
    expect(fitted.decor.some((i) => i.perch)).toBe(false);
  });

  it('has no bank in the nano tank because the fitted trunk and mound stay under the water', () => {
    const { d, fitted, banks } = fittedBanks('nano30');
    expect(banks).toEqual([]);
    const mud = fitted.decor.find((i) => i.assetId === MUD_BANK_ID);
    expect(mud?.position[1] ?? Infinity).toBeLessThan(waterTop(d));
    for (const item of fitted.decor.filter((i) => i.assetId === 'mangrove-stump')) {
      expect(item.position[1] + 0.28 * item.scale).toBeLessThan(waterTop(d));
    }
  });
});

describe('bank anchors', () => {
  it.each(['freshwater', 'reef', 'cichlid', 'blackwater'] satisfies Biome[])(
    '%s has no bank',
    (biome) => {
      expect(bankAnchors(loadPreset(biome).decor, waterTop(standard))).toEqual([]);
    },
  );

  it('drops a stump whose point stays under the water, with a footprint given', () => {
    expect(bankAnchors([stump({ scale: 1 })], waterTop(standard), reach(standard))).toEqual([]);
  });

  it('needs the clearance over the water top, and no less', () => {
    const pointHeight = BANK_TOPS['mangrove-stump']?.position[1] ?? 0;
    const point = 0.06 + pointHeight * 1.5;
    const item = stump({ scale: 1.5 });
    const at = (water: number) => bankAnchors([item], water, reach(standard));
    expect(at(point - BANK_CLEARANCE - 1e-9)).toHaveLength(1);
    expect(at(point - BANK_CLEARANCE + 1e-6)).toEqual([]);
    expect(at(point)).toEqual([]);
  });

  it('drops a perch outside the water footprint and keeps ids tied to list order', () => {
    const items = [stump({ position: [0.8, 0.06, 0] }), stump({ position: [0.1, 0.06, 0] })];
    const banks = bankAnchors(items, waterTop(standard), reach(standard));
    expect(banks.map((b) => b.id)).toEqual(['bank-2']);
  });
});

const authoredPerchIndex = loadPreset('mangrove').decor.findIndex(
  (i) => i.assetId === 'mangrove-stump' && isPerch(i),
);

describe('perch fit', () => {
  it.each(['standard', 'std200', 'long300'] satisfies TankSize[])(
    '%s trunk keeps clear of the neighbouring hardscape',
    (size) => {
      const { fitted } = fittedBanks(size);
      const perch = fitted.decor[authoredPerchIndex];
      if (!perch) throw new Error('fitted preset lost the perch');
      const core = 0.06 * perch.scale;
      for (const other of fitted.decor) {
        if (other === perch || other.assetId === MUD_BANK_ID) continue;
        const bounds = entries.get(other.assetId)?.bounds;
        if (!bounds) throw new Error(`${other.assetId} has no bounds`);
        const solid = 0.5 * Math.min(bounds.max[0] ?? 0, bounds.max[2] ?? 0) * other.scale;
        const gap = Math.hypot(
          other.position[0] - perch.position[0],
          other.position[2] - perch.position[2],
        );
        expect(gap, `${size}: ${other.assetId} at ${other.position}`).toBeGreaterThanOrEqual(
          core + solid,
        );
      }
    },
  );

  it('authors one stump perch and one mud bank in the mangrove preset and no perch elsewhere', () => {
    const perches = (biome: Biome) => loadPreset(biome).decor.filter(isPerch);
    expect(
      perches('mangrove')
        .map((i) => i.assetId)
        .sort(),
    ).toEqual(['mangrove-stump', MUD_BANK_ID]);
    const count = (biome: Biome) => perches(biome).length;
    for (const biome of ['freshwater', 'reef', 'cichlid', 'blackwater'] satisfies Biome[]) {
      expect(count(biome), biome).toBe(0);
    }
  });

  it('gives a tank that cannot reach the clearance below the rim no bank', () => {
    const shallow = { ...standard, freeboard: 0.02 };
    const fitted = fitPresetToTank(loadPreset('mangrove'), 'standard', shallow, boundsOf, () => 0);
    expect(bankAnchors(fitted.decor, waterTop(shallow), reach(shallow))).toEqual([]);
  });
});

const mudSizes = ['standard', 'std200', 'long300'] satisfies TankSize[];

function mudBank(size: TankSize) {
  const { d, fitted, banks } = fittedBanks(size);
  const item = fitted.decor.find((i) => i.assetId === MUD_BANK_ID);
  if (!item) throw new Error(`${size}: the fitted mangrove preset has no mud bank`);
  const anchor = banks.find((b) => !isStumpBank(b));
  return { d, item, anchor, matrix: decorMatrix(item) };
}

/** Projected area of the mesh triangles whose corners all lie at or above `floor` and within `flat` of the top. */
function flatAreaAbove(item: DecorItem, floor: number, flat: number): number {
  const mesh = generateMudBank();
  const matrix = decorMatrix(item);
  const corner = (i: number) =>
    new Vector3(
      mesh.positions[i * 3],
      mesh.positions[i * 3 + 1],
      mesh.positions[i * 3 + 2],
    ).applyMatrix4(matrix);
  const top = item.position[1] + MUD_BANK_TOP * item.scale;
  let area = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => corner(mesh.indices[t + k] ?? 0));
    if (!a || !b || !c) continue;
    if (Math.min(a.y, b.y, c.y) < Math.max(floor, top - flat)) continue;
    area += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
  }
  return area;
}

describe('the mangrove mud bank', () => {
  it.each(mudSizes)('%s: the flat top clears the water by at least BANK_CLEARANCE', (size) => {
    const { d, item, anchor } = mudBank(size);
    expect(anchor, 'no bank anchor for the mound').toBeDefined();
    expect(anchor?.position[1]).toBeGreaterThanOrEqual(waterTop(d) + BANK_CLEARANCE);
    expect(item.position[1] + MUD_BANK_TOP * item.scale).toBeCloseTo(anchor?.position[1] ?? 0, 6);
    expect(anchor?.position[1]).toBeLessThan(d.height - BANK_RIM_MARGIN + 1e-9);
  });

  it.each(mudSizes)('%s: a level patch of at least 40 cm2 stands clear of the water', (size) => {
    const { d, item } = mudBank(size);
    const area = flatAreaAbove(item, waterTop(d) + BANK_CLEARANCE, 0.003);
    expect(area).toBeGreaterThanOrEqual(0.004);
  });

  it.each(mudSizes)('%s: the bank radius is the flat that really exists', (size) => {
    const { item, anchor } = mudBank(size);
    expect(anchor?.radius).toBeCloseTo(MUD_BANK_FLAT.z * item.scale, 9);
    const needed = Math.PI * (anchor?.radius ?? 0) ** 2;
    expect(flatAreaAbove(item, -Infinity, 0.003)).toBeGreaterThanOrEqual(needed);
  });

  it.each(mudSizes)('%s: the whole mound stays inside the glass', (size) => {
    const { d, item } = mudBank(size);
    const bounds = mudBankBounds();
    expect(Math.abs(item.position[0]) + (bounds.max[0] ?? 0) * item.scale).toBeLessThan(
      d.length / 2 - d.glass,
    );
    expect(Math.abs(item.position[2]) + (bounds.max[2] ?? 0) * item.scale).toBeLessThan(
      d.depth / 2 - d.glass,
    );
  });

  it('gives no anchor to a mound whose top sinks below the water', () => {
    const { d, item } = mudBank('standard');
    const sunk = {
      ...item,
      position: [item.position[0], 0, item.position[2]] as DecorItem['position'],
    };
    expect(bankAnchors([sunk], waterTop(d), reach(d))).toEqual([]);
  });

  it('keeps its flat top level and the highest point of the mesh', () => {
    const mesh = generateMudBank();
    expect(mesh.bounds.max[1]).toBeCloseTo(MUD_BANK_TOP, 6);
    const level = Math.fround(MUD_BANK_TOP);
    const top = Array.from(mesh.positions).filter((v, k) => k % 3 === 1 && v === level);
    expect(top.length).toBeGreaterThan(60);
  });

  it('is a perch only in the mangrove tank', () => {
    expect(isDecorAssetForBiome('mangrove', MUD_BANK_ID)).toBe(true);
    for (const biome of ['freshwater', 'reef', 'cichlid', 'blackwater'] satisfies Biome[]) {
      expect(isDecorAssetForBiome(biome, MUD_BANK_ID), biome).toBe(false);
    }
  });
});
