import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  plantContentSchema,
  type Equipment,
  type Water,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  PLANT_START_SIZE,
  reconcilePlants,
  stepPlants,
  TANK_BIOLOAD_CAPACITY,
  trimPlant,
  type CatchUpPlants,
  type LayoutPlant,
  type LifecycleState,
  type PlantState,
  type PlantTable,
  type TankEnvironment,
} from './index.ts';

const content = plantContentSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/plants.json'), 'utf8')),
);
const table: PlantTable = {
  params: content.params,
  species: new Map(content.plants.map((p) => [p.id, p])),
};
const bounds = { halfX: 0.59, halfZ: 0.24 };
const env: TankEnvironment = {
  biome: 'freshwater',
  litres: 300,
  bioloadCapacity: TANK_BIOLOAD_CAPACITY,
  equipment: DEFAULT_EQUIPMENT,
  species: new Map(),
  speciesChemistry: new Map(),
  params: DEFAULT_WATER_PARAMETERS,
  chemistryParams: chemistryParametersSchema.parse(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/chemistry.json'), 'utf8')),
  ),
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);

const layoutOf = (assetId: string, n: number): LayoutPlant[] =>
  Array.from({ length: n }, (_, i) => ({
    assetId,
    position: [-0.4 + i * 0.05, 0.1, -0.1 + (i % 3) * 0.05],
    tintSeed: 1000 + i,
  }));
const plantsOf = (assetId: string, n: number): PlantState[] =>
  reconcilePlants(layoutOf(assetId, n), [], table);

function tank(water: Partial<Water>): LifecycleState {
  return {
    water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0, ...water },
    chemistry: newTankChemistry('freshwater'),
    fish: [],
    medicine: null,
  };
}

interface RunOptions {
  equipment?: Equipment;
  from?: number;
  days?: number;
  litres?: number;
}

function run(
  state: LifecycleState,
  plants: readonly PlantState[] | null,
  { equipment = DEFAULT_EQUIPMENT, from = T0, days = 10, litres = 300 }: RunOptions = {},
) {
  const withPlants: CatchUpPlants | undefined = plants
    ? { table, state: plants, bounds }
    : undefined;
  return catchUp({
    ...env,
    equipment,
    litres,
    state,
    fromMs: from,
    toMs: from + days * DAY,
    graceEndsAtMs: from,
    vacationFeeder: true,
    breeding: new Map(),
    breedingEnvironment: {
      hasCave: false,
      maxAnimals: 60,
      bioloadCapacity: TANK_BIOLOAD_CAPACITY,
      newId: () => {
        throw new Error('no births expected');
      },
    },
    ...(withPlants ? { plants: withPlants } : {}),
  });
}

const totalSize = (plants: readonly PlantState[]) => plants.reduce((sum, p) => sum + p.size, 0);

describe('plant growth in the offline catch-up', () => {
  it('grows with light and nutrients, takes nitrate up, and stays under the species cap', () => {
    const start = plantsOf('universal-plant', 3);
    const result = run(tank({ nitrate: 40 }), start, { days: 20 });
    for (const p of result.plants) {
      expect(p.size).toBeGreaterThan(PLANT_START_SIZE);
      expect(p.size).toBeLessThanOrEqual(2.4);
    }
    expect(result.state.water.nitrate).toBeLessThan(40);
    expect(result.state.water.nitrate).toBeGreaterThanOrEqual(0);
  });

  it('takes up exactly the nitrate the growth is worth', () => {
    const start = plantsOf('universal-plant', 2);
    const water: Water = { ammonia: 0, nitrate: 30, algae: 0, uneatenFood: 0 };
    const out = stepPlants(start, water, {
      nowMs: T0 + 12 * HOUR,
      dtHours: 1,
      litres: 300,
      equipment: DEFAULT_EQUIPMENT,
      table,
      bounds,
    });
    const grown = totalSize(out.plants) - totalSize(start);
    expect(grown).toBeGreaterThan(0);
    expect(water.nitrate - out.water.nitrate).toBeCloseTo(grown * 1.5, 9);
  });

  it('never grows a plant on nitrate that is not there', () => {
    const hungry: PlantTable = {
      params: table.params,
      species: new Map(
        [...table.species].map(([id, spec]) => [id, { ...spec, nitratePerSize: 1_000_000 }]),
      ),
    };
    const start = plantsOf('universal-plant', 1);
    const water: Water = { ammonia: 0, nitrate: 2, algae: 0, uneatenFood: 0 };
    const out = stepPlants(start, water, {
      nowMs: T0 + 12 * HOUR,
      dtHours: 1,
      litres: 300,
      equipment: DEFAULT_EQUIPMENT,
      table: hungry,
      bounds,
    });
    const grown = totalSize(out.plants) - totalSize(start);
    expect(grown * 1_000_000).toBeLessThanOrEqual(water.nitrate + 1e-9);
    expect(out.water.nitrate).toBeGreaterThanOrEqual(0);
  });

  it('slows toward the max size instead of racing there', () => {
    const stepGrowth = (size: number) => {
      const start = plantsOf('universal-plant', 1).map((p) => ({ ...p, size }));
      const out = stepPlants(
        start,
        { ammonia: 0, nitrate: 1000, algae: 0, uneatenFood: 0 },
        {
          nowMs: T0 + 12 * HOUR,
          dtHours: 1 / 6,
          litres: 300,
          equipment: DEFAULT_EQUIPMENT,
          table,
          bounds,
        },
      );
      return ((out.plants[0]?.size ?? size) - size) / size;
    };
    const max = table.species.get('universal-plant')?.maxSize ?? 0;
    expect(stepGrowth(max * 0.98)).toBeLessThan(stepGrowth(1) * 0.2);
  });

  it('grows nothing without light', () => {
    const start = plantsOf('universal-plant', 3);
    const dark: Equipment = {
      ...DEFAULT_EQUIPMENT,
      light: { ...DEFAULT_EQUIPMENT.light, tier: 0 },
    };
    const result = run(tank({ nitrate: 40 }), start, { equipment: dark });
    expect(result.plants.map((p) => p.size)).toEqual(start.map((p) => p.size));
    expect(result.state.water.nitrate).toBe(40);
  });

  it('grows only while the lamp is on', () => {
    const start = plantsOf('universal-plant', 1);
    const night = run(tank({ nitrate: 40 }), start, { from: T0 + 20 * HOUR, days: 0.4 });
    const noon = run(tank({ nitrate: 40 }), start, { from: T0 + 8 * HOUR, days: 0.4 });
    expect(night.plants[0]?.size).toBe(1);
    expect(noon.plants[0]?.size).toBeGreaterThan(1);
  });

  it('grows nothing without nitrate, and stays still instead of shrinking', () => {
    const start = plantsOf('universal-plant', 3);
    const result = run(tank({ nitrate: 0 }), start);
    expect(result.plants.map((p) => p.size)).toEqual(start.map((p) => p.size));
    expect(result.state.water.nitrate).toBe(0);
  });

  it('grows faster with CO2 for a plant that takes it up', () => {
    const start = plantsOf('universal-plant', 1);
    const co2: Equipment = { ...DEFAULT_EQUIPMENT, co2: { tier: 2 } };
    const plain = run(tank({ nitrate: 500 }), start, { days: 3 });
    const gassed = run(tank({ nitrate: 500 }), start, { equipment: co2, days: 3 });
    expect(gassed.plants[0]?.size).toBeGreaterThan((plain.plants[0]?.size ?? 0) + 0.01);
  });

  it('stops at the max size however long the absence', () => {
    const start = plantsOf('pond-weed', 2);
    const bright: Equipment = {
      ...DEFAULT_EQUIPMENT,
      light: { ...DEFAULT_EQUIPMENT.light, tier: 3 },
    };
    const result = run(tank({ nitrate: 100_000 }), start, { equipment: bright, days: 60 });
    for (const p of result.plants) {
      expect(p.size).toBeLessThanOrEqual(2.5);
      expect(p.size).toBeGreaterThan(2.4);
    }
  });

  it('lets a trimmed plant grow back', () => {
    const start = plantsOf('universal-plant', 1);
    const trimmed = trimPlant(start, 's1000', 0.5, table);
    if (!trimmed.ok) throw new Error('trim refused');
    const result = run(tank({ nitrate: 100 }), trimmed.plants, { days: 5 });
    expect(result.plants[0]?.size).toBeGreaterThan(0.5);
  });
});

describe('plants against algae', () => {
  const algaeAfter = (plants: readonly PlantState[] | null, nitrate: number) =>
    run(tank({ algae: 0.2, nitrate }), plants, { days: 14 }).state.water.algae;

  it('hold back algae in a tank with nutrients', () => {
    const bare = algaeAfter(null, 30);
    const planted = algaeAfter(plantsOf('universal-plant', 12), 30);
    expect(bare).toBeGreaterThan(0.8);
    expect(planted).toBeLessThan(bare * 0.6);
  });

  it('do not, once nothing is left for them to take', () => {
    expect(algaeAfter(plantsOf('universal-plant', 12), 0)).toBe(algaeAfter(null, 0));
  });

  it('do not, in the dark', () => {
    const dark: Equipment = {
      ...DEFAULT_EQUIPMENT,
      light: { ...DEFAULT_EQUIPMENT.light, tier: 0 },
    };
    const start = tank({ algae: 0.2, nitrate: 30 });
    const bare = run(start, null, { equipment: dark, days: 5 });
    const planted = run(start, plantsOf('universal-plant', 12), { equipment: dark, days: 5 });
    expect(planted.state.water.algae).toBe(bare.state.water.algae);
  });

  it('count for more in a small tank', () => {
    const big = run(tank({ algae: 0.2, nitrate: 30 }), plantsOf('universal-plant', 6), { days: 7 });
    const nano = run(tank({ algae: 0.2, nitrate: 30 }), plantsOf('universal-plant', 6), {
      days: 7,
      litres: 30,
    });
    expect(nano.state.water.nitrate).toBeLessThan(big.state.water.nitrate);
  });
});

describe('plant spread', () => {
  const rich = tank({ nitrate: 100_000 });
  const bright: Equipment = {
    ...DEFAULT_EQUIPMENT,
    light: { ...DEFAULT_EQUIPMENT.light, tier: 3 },
  };

  it('roots runner offsets inside the substrate at deterministic positions', () => {
    const start = plantsOf('vallisneria', 4);
    const a = run(rich, start, { equipment: bright, days: 30 });
    const b = run(rich, start, { equipment: bright, days: 30 });
    const offsets = a.plants.filter((p) => p.parentKey !== null);
    expect(offsets.length).toBeGreaterThan(4);
    expect(b.plants).toEqual(a.plants);
    for (const o of offsets) {
      const [x, z] = o.position ?? [Infinity, Infinity];
      expect(Math.abs(x)).toBeLessThanOrEqual(bounds.halfX - content.params.edgeMarginM + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(bounds.halfZ - content.params.edgeMarginM + 1e-9);
    }
  });

  it('keeps offsets of a plant at the glass inside the substrate', () => {
    const edge = plantsOf('vallisneria', 1).map((p) => ({
      ...p,
      position: [bounds.halfX - 0.01, bounds.halfZ - 0.01] as [number, number],
    }));
    const out = run(rich, edge, { equipment: bright, days: 60 });
    const offsets = out.plants.filter((p) => p.parentKey !== null);
    expect(offsets.length).toBeGreaterThan(3);
    for (const o of offsets) {
      const [x, z] = o.position ?? [Infinity, Infinity];
      expect(Math.abs(x)).toBeLessThanOrEqual(bounds.halfX - content.params.edgeMarginM + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(bounds.halfZ - content.params.edgeMarginM + 1e-9);
    }
  });

  const toCap = () => {
    const first = run(rich, plantsOf('staurogyne-repens', 2), { equipment: bright, days: 60 });
    return run(first.state, first.plants, {
      equipment: bright,
      from: first.advancedToMs,
      days: 60,
    });
  };
  const offsetsPerParent = (plants: readonly PlantState[]) => {
    const perParent = new Map<string, number>();
    for (const p of plants) {
      if (p.parentKey) perParent.set(p.parentKey, (perParent.get(p.parentKey) ?? 0) + 1);
    }
    return [...perParent.values()];
  };

  it('puts out no more offsets than the cap, however long the absence', () => {
    const result = toCap();
    expect(offsetsPerParent(result.plants)).toEqual([6, 6]);
    expect(
      result.plants.filter((p) => p.parentKey === null).every((p) => p.spreadProgress === 1),
    ).toBe(true);
  });

  it('keeps a plant at the cap from spawning after the cap is reached', () => {
    const capped = toCap();
    const later = run(capped.state, capped.plants, {
      equipment: bright,
      from: capped.advancedToMs,
      days: 20,
    });
    expect(later.plants.map((p) => p.key)).toEqual(capped.plants.map((p) => p.key));
  });

  it('stops at the tank-wide offset limit', () => {
    const crowded: CatchUpPlants = {
      table: { ...table, params: { ...table.params, maxOffsetsPerTank: 3 } },
      state: plantsOf('vallisneria', 4),
      bounds,
    };
    const result = catchUp({
      ...env,
      equipment: bright,
      state: rich,
      fromMs: T0,
      toMs: T0 + 40 * DAY,
      graceEndsAtMs: T0,
      vacationFeeder: true,
      breeding: new Map(),
      breedingEnvironment: {
        hasCave: false,
        maxAnimals: 60,
        bioloadCapacity: TANK_BIOLOAD_CAPACITY,
        newId: () => 'x',
      },
      plants: crowded,
    });
    expect(result.plants.filter((p) => p.parentKey !== null)).toHaveLength(3);
  });

  it('does not spread without light or nutrients', () => {
    const dark: Equipment = {
      ...DEFAULT_EQUIPMENT,
      light: { ...DEFAULT_EQUIPMENT.light, tier: 0 },
    };
    const start = plantsOf('vallisneria', 2);
    expect(run(rich, start, { equipment: dark, days: 30 }).plants).toHaveLength(2);
    expect(run(tank({ nitrate: 0 }), start, { equipment: bright, days: 30 }).plants).toHaveLength(
      2,
    );
  });

  it('never spreads a plant that does not spread', () => {
    const result = run(rich, plantsOf('universal-plant', 3), { equipment: bright, days: 40 });
    expect(result.plants).toHaveLength(3);
  });

  it('waits for a trimmed parent to regrow before spreading again', () => {
    const start = plantsOf('vallisneria', 1).map((p) => ({ ...p, size: 0.45 }));
    const result = run(rich, start, { equipment: bright, days: 1 });
    expect(result.plants).toHaveLength(1);
    expect(result.plants[0]?.spreadProgress).toBe(0);
    expect(result.plants[0]?.size).toBeLessThan(0.8);
  });
});

describe('catch-up invariants', () => {
  const bright: Equipment = {
    ...DEFAULT_EQUIPMENT,
    light: { ...DEFAULT_EQUIPMENT.light, tier: 2 },
  };
  const mixed = [
    ...layoutOf('vallisneria', 3),
    ...layoutOf('staurogyne-repens', 3).map((p, i) => ({ ...p, tintSeed: 2000 + i })),
    ...layoutOf('universal-plant', 3).map((p, i) => ({ ...p, tintSeed: 3000 + i })),
  ];

  it('gives the same result in two halves as in one whole', () => {
    const start = reconcilePlants(mixed, [], table);
    const whole = run(tank({ nitrate: 200, algae: 0.3 }), start, { equipment: bright, days: 30 });
    const first = run(tank({ nitrate: 200, algae: 0.3 }), start, { equipment: bright, days: 13 });
    const second = run(first.state, first.plants, {
      equipment: bright,
      from: first.advancedToMs,
      days: 17,
    });
    expect(second.plants).toEqual(whole.plants);
    expect(second.state).toEqual(whole.state);
  });

  it('simulates 60 days of a 30-plant tank well within a request', () => {
    const start = reconcilePlants(
      Array.from({ length: 30 }, (_, i) => ({
        assetId: i % 2 === 0 ? 'vallisneria' : 'staurogyne-repens',
        position: [-0.5 + i * 0.03, 0.1, ((i % 5) - 2) * 0.08] as const,
        tintSeed: 9000 + i,
      })),
      [],
      table,
    );
    const t0 = performance.now();
    const result = run(tank({ nitrate: 100_000 }), start, { equipment: bright, days: 60 });
    const elapsed = performance.now() - t0;
    expect(result.steps).toBe(8640);
    expect(result.plants.length).toBeGreaterThan(30);
    expect(elapsed).toBeLessThan(3000);
  });

  it('is unchanged when no plants are passed', () => {
    const plain = run(tank({ nitrate: 30, algae: 0.2 }), null, { days: 5 });
    expect(plain.plants).toEqual([]);
    const empty = run(tank({ nitrate: 30, algae: 0.2 }), [], { days: 5 });
    expect(empty.state).toEqual(plain.state);
  });
});

describe('reconcile and trim', () => {
  it('starts a new layout plant at size 1 and keeps a grown one when it moves', () => {
    const grown = plantsOf('vallisneria', 1).map((p) => ({ ...p, size: 1.7 }));
    const moved = reconcilePlants(
      [{ assetId: 'vallisneria', position: [0.3, 0.1, 0.1], tintSeed: 1000 }],
      grown,
      table,
    );
    expect(moved[0]).toMatchObject({ key: 's1000', size: 1.7, position: [0.3, 0.1] });
    const added = reconcilePlants(
      [
        { assetId: 'vallisneria', position: [0.3, 0.1, 0.1], tintSeed: 1000 },
        { assetId: 'water-plant', position: [0, 0.1, 0], tintSeed: 7 },
      ],
      grown,
      table,
    );
    expect(added.map((p) => [p.key, p.size])).toEqual([
      ['s1000', 1.7],
      ['s7', 1],
    ]);
  });

  it('ignores decor that is not a plant, and drops the offsets of a removed plant', () => {
    const withOffset: PlantState[] = [
      ...plantsOf('vallisneria', 1),
      {
        key: 's1000.1',
        assetId: 'vallisneria',
        parentKey: 's1000',
        position: [0, 0],
        size: 0.5,
        spreadProgress: 0,
        spawned: 0,
      },
    ];
    expect(
      reconcilePlants(
        [{ assetId: 'boulder-01', position: [0, 0, 0], tintSeed: 5 }],
        withOffset,
        table,
      ),
    ).toEqual([]);
  });

  it('keys two pieces with the same seed apart', () => {
    const twins = reconcilePlants(
      [
        { assetId: 'vallisneria', position: [0, 0, 0], tintSeed: 4 },
        { assetId: 'vallisneria', position: [0.1, 0, 0], tintSeed: 4 },
      ],
      [],
      table,
    );
    expect(twins.map((p) => p.key)).toEqual(['s4', 's4-2']);
  });

  it('trims to a size, refuses below the minimum, and refuses a plant that is not that big', () => {
    const grown = plantsOf('universal-plant', 1).map((p) => ({ ...p, size: 1.8 }));
    const cut = trimPlant(grown, 's1000', 0.6, table);
    expect(cut.ok && cut.plants[0]?.size).toBe(0.6);
    expect(trimPlant(grown, 's1000', 0.39, table)).toEqual({ ok: false, reason: 'below_minimum' });
    expect(trimPlant(grown, 's1000', 1.8, table)).toEqual({ ok: false, reason: 'not_grown' });
    expect(trimPlant(grown, 'nope', 0.6, table)).toEqual({ ok: false, reason: 'unknown' });
  });

  const seeded = (assetId: string, tintSeed: number): LayoutPlant[] => [
    { assetId, position: [0, 0.1, 0], tintSeed },
  ];
  const spreading = tank({ nitrate: 100_000 });
  const lit: Equipment = { ...DEFAULT_EQUIPMENT, light: { ...DEFAULT_EQUIPMENT.light, tier: 3 } };
  const keysOf = (plants: readonly PlantState[]) => plants.map((p) => p.key);

  it('does not carry the offsets of a replaced plant over, so keys stay unique', () => {
    const first = reconcilePlants(seeded('vallisneria', 5), [], table);
    const grown = run(spreading, first, { equipment: lit, days: 40 });
    expect(grown.plants.some((p) => p.parentKey === 's5')).toBe(true);

    const swapped = reconcilePlants(seeded('staurogyne-repens', 5), grown.plants, table);
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toMatchObject({ key: 's5', assetId: 'staurogyne-repens', size: 1 });

    const regrown = run(spreading, swapped, { equipment: lit, from: T0 + 40 * DAY, days: 40 });
    expect(
      regrown.plants.every((p) => p.parentKey === null || p.assetId === 'staurogyne-repens'),
    ).toBe(true);
    expect(new Set(keysOf(regrown.plants)).size).toBe(regrown.plants.length);
  });

  it('keeps unique keys through any sequence of swaps, moves, removals and growth', () => {
    const assets = ['vallisneria', 'staurogyne-repens', 'java-fern', 'water-plant'];
    let plants: PlantState[] = [];
    let from = T0;
    for (let round = 0; round < 24; round++) {
      const pick = (n: number) => assets[(round * 7 + n * 3) % assets.length] ?? 'vallisneria';
      const layout: LayoutPlant[] = [
        { assetId: pick(0), position: [-0.2 + round * 0.01, 0.1, 0], tintSeed: round % 3 },
        { assetId: pick(1), position: [0.2, 0.1, 0.05], tintSeed: round % 3 },
        ...(round % 4 === 0
          ? []
          : [{ assetId: pick(2), position: [0, 0.1, -0.1], tintSeed: 2 } as LayoutPlant]),
      ];
      plants = reconcilePlants(layout, plants, table);
      expect(new Set(keysOf(plants)).size).toBe(plants.length);
      plants = [...run(spreading, plants, { equipment: lit, from, days: 9 }).plants];
      from += 9 * DAY;
      expect(new Set(keysOf(plants)).size).toBe(plants.length);
    }
  });

  it('starts every offset at no less than its species minimum trim size', () => {
    for (const spec of content.plants) {
      expect(content.params.offsetStartSize).toBeGreaterThanOrEqual(spec.minSize);
    }
    const spreaders = content.plants.filter((spec) => spec.spread !== null);
    expect(spreaders.length).toBeGreaterThan(0);
    for (const spec of spreaders) {
      let plants = plantsOf(spec.id, 4);
      const born: PlantState[] = [];
      for (let hour = 0; hour < 40 * 24; hour++) {
        const known = new Set(plants.map((p) => p.key));
        plants = [
          ...run(spreading, plants, { equipment: lit, from: T0 + hour * HOUR, days: 1 / 24 })
            .plants,
        ];
        born.push(...plants.filter((p) => !known.has(p.key)));
      }
      expect(born.length).toBeGreaterThan(0);
      for (const offset of born) {
        expect(offset.size).toBeGreaterThanOrEqual(spec.minSize);
      }
    }
  });
});
