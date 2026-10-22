import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  coralContentSchema,
  coralSpeciesId,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  type Chemistry,
  type Equipment,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  blocked,
  catchUp,
  coralStress,
  DEFAULT_WATER_PARAMETERS,
  fragCoral,
  reconcileCorals,
  stepCorals,
  TANK_BIOLOAD_CAPACITY,
  type CatchUpCorals,
  type CoralState,
  type CoralTable,
  type LayoutPlant,
  type LifecycleState,
  type Obstacle,
  type TankEnvironment,
} from './index.ts';

const content = coralContentSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/corals.json'), 'utf8')),
);
const table: CoralTable = {
  params: content.params,
  species: new Map(content.corals.map((c) => [c.id, c])),
};
const bounds = { halfX: 0.59, halfZ: 0.24 };
const env: TankEnvironment = {
  biome: 'reef',
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

const reefEquipment = (light: { tier: number; intensity: number }, waveMaker = 2): Equipment => ({
  ...DEFAULT_EQUIPMENT,
  light: { ...DEFAULT_EQUIPMENT.light, ...light },
  waveMaker: { tier: waveMaker },
});
const GOOD = reefEquipment({ tier: 2, intensity: 1 });

const layoutOf = (assetId: string, n: number): LayoutPlant[] =>
  Array.from({ length: n }, (_, i) => ({
    assetId,
    position: [-0.4 + i * 0.05, 0.1, -0.1 + (i % 3) * 0.05],
    tintSeed: 2000 + i,
  }));
const coralsOf = (assetId: string, n: number): CoralState[] =>
  reconcileCorals(layoutOf(assetId, n), [], table);

function tank(chemistry: Partial<Chemistry> = {}): LifecycleState {
  return {
    water: { ammonia: 0, nitrate: 5, algae: 0, uneatenFood: 0 },
    chemistry: { ...newTankChemistry('reef'), ...chemistry },
    fish: [],
    medicine: null,
  };
}

interface RunOptions {
  equipment?: Equipment;
  from?: number;
  days?: number;
  steps?: number;
}

function run(
  state: LifecycleState,
  corals: readonly CoralState[] | null,
  { equipment = GOOD, from = T0, days = 10, steps }: RunOptions = {},
) {
  const withCorals: CatchUpCorals | undefined = corals ? { table, state: corals } : undefined;
  return catchUp({
    ...env,
    equipment,
    state,
    fromMs: from,
    toMs: steps === undefined ? from + days * DAY : from + steps * 600_000,
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
    ...(withCorals ? { corals: withCorals } : {}),
  });
}

const stepCtx = (equipment: Equipment, dtHours = 1 / 6, nowMs = T0 + 12 * HOUR) => ({
  nowMs,
  dtHours,
  equipment,
  table,
});

function hold(
  start: readonly CoralState[],
  chemistry: Chemistry,
  hours: number,
  equipment = GOOD,
): CoralState[] {
  let corals = [...start];
  for (let h = 0; h < hours * 6; h++) {
    corals = stepCorals(corals, chemistry, stepCtx(equipment, 1 / 6, T0 + 12 * HOUR + h * 600_000));
  }
  return corals;
}

describe('coral growth in the offline catch-up', () => {
  it('grows in light and flow, and stays under the species cap', () => {
    const result = run(tank(), coralsOf('acropora-cytherea', 3), { days: 60 });
    for (const c of result.corals) {
      expect(c.size).toBeGreaterThan(1.5);
      expect(c.size).toBeLessThanOrEqual(2.5);
      expect(c.bleach).toBeLessThan(0.01);
    }
  });

  it('grows nothing without light', () => {
    const start = coralsOf('brain-coral', 3);
    const dark = reefEquipment({ tier: 0, intensity: 1 });
    const result = run(tank(), start, { equipment: dark });
    expect(result.corals.map((c) => c.size)).toEqual(start.map((c) => c.size));
  });

  it('grows only while the lamp is on', () => {
    const start = coralsOf('brain-coral', 1);
    const night = run(tank(), start, { from: T0 + 20 * HOUR, days: 0.4 });
    const noon = run(tank(), start, { from: T0 + 8 * HOUR, days: 0.4 });
    expect(night.corals[0]?.size).toBe(1);
    expect(noon.corals[0]?.size).toBeGreaterThan(1);
  });

  it('grows faster in more flow, and slowly even with no wave maker', () => {
    const start = coralsOf('acropora-palmata', 1);
    const still = run(tank(), start, { equipment: reefEquipment({ tier: 2, intensity: 1 }, 0) });
    const strong = run(tank(), start, { equipment: reefEquipment({ tier: 2, intensity: 1 }, 3) });
    expect(still.corals[0]?.size).toBeGreaterThan(1);
    expect(strong.corals[0]?.size).toBeGreaterThan((still.corals[0]?.size ?? 0) + 0.02);
  });

  it('slows toward the max size instead of racing there', () => {
    const stepGrowth = (size: number) => {
      const start = coralsOf('brain-coral', 1).map((c) => ({ ...c, size }));
      const out = stepCorals(start, newTankChemistry('reef'), stepCtx(GOOD));
      return ((out[0]?.size ?? size) - size) / size;
    };
    const max = table.species.get('brain-coral')?.maxSize ?? 0;
    expect(stepGrowth(max * 0.98)).toBeLessThan(stepGrowth(1) * 0.2);
  });

  it('never passes the max size, whatever the step', () => {
    const start = coralsOf('acropora-cytherea', 1).map((c) => ({ ...c, size: 2.4 }));
    const out = stepCorals(start, newTankChemistry('reef'), stepCtx(GOOD, 5000));
    expect(out[0]?.size).toBeLessThanOrEqual(2.5);
  });

  it('is unchanged when no corals are passed', () => {
    const plain = run(tank(), null, { days: 5 });
    expect(plain.corals).toEqual([]);
    expect(run(tank(), [], { days: 5 }).state).toEqual(plain.state);
  });

  it('does not touch the water', () => {
    const without = run(tank(), null, { days: 5 });
    const with4 = run(tank(), coralsOf('brain-coral', 4), { days: 5 });
    expect(with4.state).toEqual(without.state);
  });
});

describe('bleaching and recovery', () => {
  const hot = { ...newTankChemistry('reef'), temperatureC: 33 };

  it('bleaches in hot water, faster the hotter, and stops growing', () => {
    const start = coralsOf('acropora-cytherea', 1);
    const warm = hold(start, { ...hot, temperatureC: 29.5 }, 24 * 5);
    const scorching = hold(start, hot, 24 * 5);
    expect(warm[0]?.bleach).toBeGreaterThan(0.2);
    expect(scorching[0]?.bleach).toBeGreaterThan(0.95);
    expect(scorching[0]?.bleach).toBeGreaterThan(warm[0]?.bleach ?? 1);
    expect(scorching[0]?.size).toBe(1);
  });

  it('recovers, slowly, once the water is right again', () => {
    const bleached = hold(coralsOf('brain-coral', 1), hot, 24 * 5);
    expect(bleached[0]?.bleach).toBeGreaterThan(0.9);
    const week = hold(bleached, newTankChemistry('reef'), 24 * 7);
    expect(week[0]?.bleach).toBeLessThan(bleached[0]?.bleach ?? 0);
    expect(week[0]?.bleach).toBeGreaterThan(0.2);
    const months = hold(bleached, newTankChemistry('reef'), 24 * 45);
    expect(months[0]?.bleach).toBeLessThan(0.02);
  });

  it('grows again after it has recovered', () => {
    const recovered = hold(
      hold(coralsOf('brain-coral', 1), hot, 24 * 5),
      newTankChemistry('reef'),
      24 * 60,
    );
    const later = run(tank(), recovered, { days: 10 });
    expect(later.corals[0]?.size).toBeGreaterThan(1);
  });

  it('bleaches from too much light and recovers when the light is turned down', () => {
    const blazing = reefEquipment({ tier: 3, intensity: 1 });
    const first = run(tank(), coralsOf('acropora-cytherea', 1), { equipment: blazing, days: 6 });
    expect(first.corals[0]?.bleach).toBeGreaterThan(0.9);
    const second = run(first.state, first.corals, {
      from: first.advancedToMs,
      days: 60,
    });
    expect(second.corals[0]?.bleach).toBeLessThan(0.05);
  });

  it('does not bleach from light a coral takes, however long', () => {
    const result = run(tank(), coralsOf('acropora-cytherea', 1), { days: 60 });
    expect(result.corals[0]?.bleach).toBeLessThan(0.001);
  });

  it('judges each factor on its own: salinity, hardness, pH', () => {
    const spec = table.species.get('brain-coral');
    if (!spec) throw new Error('no brain coral');
    const base = newTankChemistry('reef');
    expect(coralStress(spec, base, GOOD)).toBe(0);
    expect(coralStress(spec, { ...base, salinity: 25 }, GOOD)).toBeGreaterThan(0.5);
    expect(coralStress(spec, { ...base, kh: 3 }, GOOD)).toBeGreaterThan(0.5);
    expect(coralStress(spec, { ...base, ph: 7.2 }, GOOD)).toBeGreaterThan(0.5);
    expect(coralStress(spec, { ...base, temperatureC: 20 }, GOOD)).toBeGreaterThan(0.5);
    expect(coralStress(spec, { ...base, temperatureC: 100 }, GOOD)).toBe(1);
  });
});

describe('chunk invariance and cost', () => {
  const blazing = reefEquipment({ tier: 3, intensity: 1 });

  it('gives the same corals however the absence is split', () => {
    const start = coralsOf('acropora-cytherea', 3).map((c, i) => ({ ...c, bleach: i * 0.3 }));
    const whole = run(tank(), start, { equipment: blazing, steps: 4320 });
    let state = tank();
    let corals: readonly CoralState[] = start;
    let from = T0;
    for (const steps of [1, 144, 1000, 3, 2000, 1172]) {
      const part = run(state, corals, { equipment: blazing, from, steps });
      state = part.state;
      corals = part.corals;
      from = part.advancedToMs;
    }
    expect(corals).toEqual(whole.corals);
  });

  it('is the same on a rerun', () => {
    const start = coralsOf('euphyllia-torch-5', 2);
    expect(run(tank(), start, { days: 20 }).corals).toEqual(
      run(tank(), start, { days: 20 }).corals,
    );
  });

  it('steps 60 days of a full reef in a few seconds', () => {
    const start = [
      ...coralsOf('acropora-cytherea', 20),
      ...coralsOf('brain-coral', 20).map((c) => ({ ...c, key: `${c.key}b` })),
      ...coralsOf('euphyllia-hammer-3', 20).map((c) => ({ ...c, key: `${c.key}e` })),
    ];
    const t0 = performance.now();
    const result = run(tank(), start, { days: 60 });
    const elapsed = performance.now() - t0;
    expect(result.steps).toBe(8640);
    expect(result.corals).toHaveLength(60);
    expect(elapsed).toBeLessThan(3000);
  });

  it('simulates only the last 60 days of a longer absence', () => {
    const result = run(tank(), coralsOf('brain-coral', 1), { days: 200 });
    expect(result.capped).toBe(true);
    expect(result.steps).toBe(8640);
  });
});

describe('fragging', () => {
  const grown = (assetId: string, size: number, bleach = 0) =>
    coralsOf(assetId, 1).map((c) => ({ ...c, size, bleach }));
  const minimum = (id: string) => table.species.get(id)?.fragMinSize ?? 0;

  it('cuts a fragment off a grown colony and the colony gives up its size', () => {
    const start = grown('acropora-cytherea', 2);
    const cut = fragCoral(start, 's2000', table, bounds);
    if (!cut.ok) throw new Error(cut.reason);
    expect(cut.fragKey).toBe('s2000.1');
    const [parent, frag] = cut.corals;
    expect(parent?.size).toBeCloseTo(2 - content.params.fragStartSize, 9);
    expect(parent?.spawned).toBe(1);
    expect(frag).toMatchObject({
      key: 's2000.1',
      parentKey: 's2000',
      assetId: 'acropora-cytherea',
      size: content.params.fragStartSize,
      bleach: 0,
    });
    const [x, z] = frag?.position ?? [Infinity, Infinity];
    expect(Math.abs(x)).toBeLessThanOrEqual(bounds.halfX - content.params.edgeMarginM + 1e-9);
    expect(Math.abs(z)).toBeLessThanOrEqual(bounds.halfZ - content.params.edgeMarginM + 1e-9);
  });

  it('allows exactly the minimum size and refuses just below it', () => {
    const min = minimum('acropora-cytherea');
    expect(fragCoral(grown('acropora-cytherea', min), 's2000', table, bounds).ok).toBe(true);
    const under = fragCoral(grown('acropora-cytherea', min - 0.001), 's2000', table, bounds);
    expect(under).toEqual({ ok: false, reason: 'not_grown' });
  });

  it('refuses a coral that is too bleached, and allows one that has nearly recovered', () => {
    const limit = content.params.fragMaxBleach;
    expect(fragCoral(grown('brain-coral', 2, limit + 0.01), 's2000', table, bounds)).toEqual({
      ok: false,
      reason: 'bleached',
    });
    expect(fragCoral(grown('brain-coral', 2, limit), 's2000', table, bounds).ok).toBe(true);
  });

  it('refuses an unknown coral', () => {
    expect(fragCoral(grown('brain-coral', 2), 'nope', table, bounds)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('refuses once the tank holds the most fragments', () => {
    let corals = grown('acropora-cytherea', 2.5);
    for (let i = 0; i < content.params.maxFragsPerTank; i++) {
      const cut = fragCoral(corals, 's2000', table, bounds);
      if (!cut.ok) throw new Error(`cut ${i}: ${cut.reason}`);
      corals = cut.corals.map((c) => (c.key === 's2000' ? { ...c, size: 2.5 } : c));
    }
    expect(fragCoral(corals, 's2000', table, bounds)).toEqual({ ok: false, reason: 'limit' });
  });

  it('numbers fragments of fragments from the root and keeps them in the layout', () => {
    const start = grown('acropora-cytherea', 2);
    const first = fragCoral(start, 's2000', table, bounds);
    if (!first.ok) throw new Error(first.reason);
    const bigFrag = first.corals.map((c) => (c.key === 's2000.1' ? { ...c, size: 2 } : c));
    const second = fragCoral(bigFrag, 's2000.1', table, bounds);
    if (!second.ok) throw new Error(second.reason);
    expect(second.fragKey).toBe('s2000.2');
    expect(second.corals.find((c) => c.key === 's2000.2')?.parentKey).toBe('s2000.1');
    expect(second.corals.find((c) => c.key === 's2000')?.spawned).toBe(2);
    expect(second.corals.find((c) => c.key === 's2000.1')?.size).toBeCloseTo(
      2 - content.params.fragStartSize,
      9,
    );
    const reconciled = reconcileCorals(layoutOf('acropora-cytherea', 1), second.corals, table);
    expect(reconciled.map((c) => c.key)).toEqual(['s2000', 's2000.1', 's2000.2']);
  });

  it('puts successive fragments of one colony in different places', () => {
    const first = fragCoral(grown('brain-coral', 2.4), 's2000', table, bounds);
    if (!first.ok) throw new Error(first.reason);
    const second = fragCoral(first.corals, 's2000', table, bounds);
    if (!second.ok) throw new Error(second.reason);
    expect(second.corals[2]?.position).not.toEqual(second.corals[1]?.position);
  });

  it('spreads the fragments of colonies standing together', () => {
    const [a, b] = coralsOf('brain-coral', 2).map((c) => ({
      ...c,
      size: 2,
      position: [0, 0] as [number, number],
    }));
    if (!a || !b) throw new Error('no corals');
    const fromA = fragCoral([a], a.key, table, bounds);
    const fromB = fragCoral([b], b.key, table, bounds);
    if (!fromA.ok || !fromB.ok) throw new Error('refused');
    expect(fromA.corals[1]?.position).not.toEqual(fromB.corals[1]?.position);
  });

  it('starts a fragment healthy even when the colony is a little bleached', () => {
    const limit = content.params.fragMaxBleach;
    const cut = fragCoral(grown('brain-coral', 2, limit), 's2000', table, bounds);
    if (!cut.ok) throw new Error(cut.reason);
    expect(cut.corals[1]?.bleach).toBe(0);
    expect(cut.corals[0]?.bleach).toBe(limit);
  });

  it('puts fragments at deterministic places', () => {
    const a = fragCoral(grown('brain-coral', 2), 's2000', table, bounds);
    const b = fragCoral(grown('brain-coral', 2), 's2000', table, bounds);
    expect(a).toEqual(b);
  });

  it('keeps a fragment inside the glass beside the edge', () => {
    const edge = grown('brain-coral', 2).map((c) => ({
      ...c,
      position: [bounds.halfX - 0.01, bounds.halfZ - 0.01] as [number, number],
    }));
    const cut = fragCoral(edge, 's2000', table, bounds);
    if (!cut.ok) throw new Error(cut.reason);
    const [x, z] = cut.corals[1]?.position ?? [Infinity, Infinity];
    expect(Math.abs(x)).toBeLessThanOrEqual(bounds.halfX - content.params.edgeMarginM + 1e-9);
    expect(Math.abs(z)).toBeLessThanOrEqual(bounds.halfZ - content.params.edgeMarginM + 1e-9);
  });

  describe('around rock and wood', () => {
    const rock = (x: number, z: number, half: number): Obstacle => ({
      x,
      z,
      rotationY: 0,
      scale: 1,
      halfX: half,
      halfZ: half,
    });
    const colony = grown('brain-coral', 2);

    it('never roots a fragment inside an obstacle', () => {
      const rocks = [rock(0.07, 0, 0.09), rock(-0.05, 0.08, 0.05)];
      for (let spawned = 0; spawned < 12; spawned++) {
        const start = colony.map((c) => ({ ...c, spawned }));
        const cut = fragCoral(start, 's2000', table, bounds, rocks);
        if (!cut.ok) throw new Error(cut.reason);
        const [x, z] = cut.corals[1]?.position ?? [0, 0];
        expect(blocked(x, z, rocks, 0)).toBe(false);
      }
    });

    it('moves a fragment that would have landed in rock', () => {
      const free = fragCoral(colony, 's2000', table, bounds);
      if (!free.ok) throw new Error(free.reason);
      const [fx, fz] = free.corals[1]?.position ?? [0, 0];
      const rocks = [rock(fx, fz, 0.02)];
      const moved = fragCoral(colony, 's2000', table, bounds, rocks);
      if (!moved.ok) throw new Error(moved.reason);
      expect(moved.corals[1]?.position).not.toEqual([fx, fz]);
    });

    it('refuses when rock covers everything within reach', () => {
      const cut = fragCoral(colony, 's2000', table, bounds, [rock(0, 0, 0.5)]);
      expect(cut).toEqual({ ok: false, reason: 'no_room' });
    });
  });

  it('lets a fragment grow on its own', () => {
    const cut = fragCoral(grown('acropora-cytherea', 2), 's2000', table, bounds);
    if (!cut.ok) throw new Error(cut.reason);
    const result = run(tank(), cut.corals, { days: 20 });
    expect(result.corals[1]?.size).toBeGreaterThan(content.params.fragStartSize);
  });
});

describe('reconciling with the layout', () => {
  it('starts a new layout coral at size 1, keeps a grown one when it moves, drops what left', () => {
    const grown = coralsOf('brain-coral', 2).map((c) => ({ ...c, size: 1.6, bleach: 0.4 }));
    const swapped = reconcileCorals(
      [
        { assetId: 'brain-coral', position: [0.3, 0.1, 0.1], tintSeed: 2000 },
        { assetId: 'brain-coral', position: [0, 0.1, 0], tintSeed: 2002 },
      ],
      grown,
      table,
    );
    expect(swapped.map((c) => c.key)).toEqual(['s2000', 's2002']);
    expect(swapped[0]).toMatchObject({ size: 1.6, bleach: 0.4, position: [0.3, 0.1] });
    expect(swapped[1]).toMatchObject({ size: 1, bleach: 0 });
  });

  it('takes fragments with a coral that left the layout', () => {
    const cut = fragCoral(
      coralsOf('brain-coral', 1).map((c) => ({ ...c, size: 2 })),
      's2000',
      table,
      bounds,
    );
    if (!cut.ok) throw new Error(cut.reason);
    expect(reconcileCorals([], cut.corals, table)).toEqual([]);
  });

  it('ignores what is not a coral and knows the euphyllia kinds', () => {
    const layout = [
      ...layoutOf('boulder-01', 2),
      ...layoutOf('host-anemone', 1),
      ...layoutOf('euphyllia-hammer-77', 1),
    ];
    const corals = reconcileCorals(layout, [], table);
    expect(corals.map((c) => c.assetId)).toEqual(['euphyllia-hammer-77']);
    expect(coralSpeciesId('euphyllia-torch-5')).toBe('euphyllia-torch');
    expect(coralSpeciesId('euphyllia-torch-05')).toBe('euphyllia-torch-05');
    expect(coralSpeciesId('brain-coral')).toBe('brain-coral');
  });

  it('refuses a coral with no content, naming the file to add it to', () => {
    const stray = coralsOf('brain-coral', 1).map((c) => ({ ...c, assetId: 'mystery-coral' }));
    expect(() => stepCorals(stray, newTankChemistry('reef'), stepCtx(GOOD))).toThrow(
      /content\/corals\.json/,
    );
  });
});
