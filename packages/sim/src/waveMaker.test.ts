import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  cherryShrimp,
  clownfish,
  guppy,
  royalGramma,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import {
  checkWaveMaker,
  FlowField,
  WAVE_MAKER,
  waveMakerForTier,
  type FlowBounds,
  type WaveMakerSettings,
} from './waveMaker.ts';
import { STEP_DT, World, type WorldConfig } from './world.ts';

const SPECIES = [...ARCHETYPES, guppy, cherryShrimp];

const BOUNDS: FlowBounds = { minX: -0.9, maxX: 0.9, minZ: -0.3, maxZ: 0.3, minY: 0, maxY: 0.6 };

const MAX: WaveMakerSettings = {
  direction: [1, 0],
  speedMps: WAVE_MAKER.maxSpeedMps,
  mode: 'steady',
  periodS: WAVE_MAKER.pulsePeriodS,
};

function reef(seed: number, fish: WorldConfig['fish'], waveMaker?: WaveMakerSettings | null) {
  return new World({
    seed,
    tank: REEF_TANK,
    species: SPECIES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish,
    ...(waveMaker === undefined ? {} : { waveMaker }),
  });
}

function run(w: World, steps: number): World {
  for (let t = 0; t < steps; t++) w.step();
  return w;
}

/** FNV-1a over the raw bits, so the pin catches a change in the last place of any coordinate. */
function bitDigest(values: Float64Array): string {
  let h = 0x811c9dc5;
  for (const word of new Uint32Array(values.buffer, values.byteOffset, values.length * 2)) {
    h = Math.imul(h ^ word, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function localSpeed(w: World, i: number): number {
  const o = i * 3;
  const f = w.currents.flow;
  return Math.hypot(f[o] ?? 0, f[o + 1] ?? 0, f[o + 2] ?? 0);
}

const community = [
  ...spawnMany('neon-tetra', 10),
  ...spawnMany('ocellaris-clownfish', 2),
  ...spawnMany('yellow-tang', 1),
  ...spawnMany('royal-gramma', 1),
  ...spawnMany('bronze-corydoras', 3),
  ...spawnMany('cherry-shrimp', 3),
];

describe('waveMakerForTier', () => {
  it('gives no wave maker at tier 0 and climbing flow and pattern above it', () => {
    expect(waveMakerForTier(0)).toBeNull();
    const tiers = [1, 2, 3].map((t) => waveMakerForTier(t));
    expect(tiers.map((s) => s?.speedMps)).toEqual([0.06, 0.12, 0.18]);
    expect(tiers.map((s) => s?.mode)).toEqual(['steady', 'pulse', 'alternating']);
    expect(tiers[2]?.periodS).toBe(WAVE_MAKER.alternatingPeriodS);
    for (const s of tiers) expect(s?.direction).toEqual([1, 0]);
  });

  it('normalises a given direction', () => {
    expect(waveMakerForTier(2, [0, -5])?.direction).toEqual([0, -1]);
  });

  it.each([-1, 4, 1.5, Number.NaN])('rejects tier %s', (tier) => {
    expect(() => waveMakerForTier(tier)).toThrow(RangeError);
  });
});

describe('checkWaveMaker', () => {
  it('returns a non-unit direction as a unit one', () => {
    expect(checkWaveMaker({ ...MAX, direction: [3, 4] }).direction).toEqual([0.6, 0.8]);
  });

  it('accepts zero strength and the maximum', () => {
    expect(checkWaveMaker({ ...MAX, speedMps: 0 }).speedMps).toBe(0);
    expect(checkWaveMaker(MAX).speedMps).toBe(WAVE_MAKER.maxSpeedMps);
  });

  it.each<[string, Partial<WaveMakerSettings>]>([
    ['zero direction', { direction: [0, 0] }],
    ['NaN direction', { direction: [Number.NaN, 1] }],
    ['infinite direction', { direction: [Number.POSITIVE_INFINITY, 0] }],
    ['negative speed', { speedMps: -0.01 }],
    ['speed past the maximum', { speedMps: WAVE_MAKER.maxSpeedMps + 0.01 }],
    ['NaN speed', { speedMps: Number.NaN }],
    ['zero period', { periodS: 0 }],
    ['infinite period', { periodS: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_, change) => {
    expect(() => checkWaveMaker({ ...MAX, ...change })).toThrow(RangeError);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a string speed', { speedMps: '0.1' }],
    ['a string zero speed', { speedMps: '0' }],
    ['a string period', { periodS: '8' }],
    ['a string direction entry', { direction: ['1', 0] }],
    ['a null direction entry', { direction: [null, 1] }],
  ])('rejects %s from an untyped sender', (_, change) => {
    const settings = JSON.parse(JSON.stringify({ ...MAX, ...change })) as WaveMakerSettings;
    expect(() => checkWaveMaker(settings)).toThrow(RangeError);
  });

  it('rejects an unknown mode', () => {
    const settings = JSON.parse(JSON.stringify({ ...MAX, mode: 'storm' })) as WaveMakerSettings;
    expect(() => checkWaveMaker(settings)).toThrow(/mode/);
  });
});

describe('FlowField', () => {
  const v = new Float64Array(3);
  const sample = (f: FlowField, x: number, y: number, z: number, t = 0): number[] => {
    f.sample(x, y, z, t, v);
    return [...v];
  };

  it('rejects empty or non-finite bounds', () => {
    expect(() => new FlowField({ ...BOUNDS, maxX: BOUNDS.minX }, MAX)).toThrow(RangeError);
    expect(() => new FlowField({ ...BOUNDS, maxY: Number.NaN }, MAX)).toThrow(RangeError);
  });

  it('pushes along the top, returns along the bottom and is calm in the core', () => {
    const f = new FlowField(BOUNDS, MAX);
    const top = sample(f, 0, 0.6, 0);
    const bottom = sample(f, 0, 0, 0);
    expect(top[0]).toBeCloseTo(MAX.speedMps, 12);
    expect(bottom[0]).toBeCloseTo(-MAX.speedMps, 12);
    expect(Math.hypot(...sample(f, 0, 0.3, 0))).toBeLessThan(1e-12);
    expect(top[2]).toBe(0);
  });

  it('never flows into the end panes, the sand or the surface', () => {
    const f = new FlowField(BOUNDS, MAX);
    for (let y = 0; y <= 0.6; y += 0.05) {
      expect(Math.abs(sample(f, -0.9, y, 0.1)[0] ?? 1)).toBeLessThan(1e-12);
      expect(Math.abs(sample(f, 0.9, y, -0.1)[0] ?? 1)).toBeLessThan(1e-12);
    }
    for (let x = -0.9; x <= 0.9; x += 0.1) {
      expect(Math.abs(sample(f, x, 0, 0)[1] ?? 1)).toBeLessThan(1e-12);
      expect(Math.abs(sample(f, x, 0.6, 0)[1] ?? 1)).toBeLessThan(1e-12);
    }
  });

  it('is divergence-free', () => {
    const f = new FlowField(BOUNDS, { ...MAX, direction: [2, 1] });
    const h = 1e-5;
    for (const [x, y, z] of [
      [0.1, 0.2, 0.05],
      [-0.5, 0.45, -0.1],
      [0.6, 0.1, 0.2],
    ] as const) {
      const div =
        ((sample(f, x + h, y, z)[0] ?? 0) - (sample(f, x - h, y, z)[0] ?? 0)) / (2 * h) +
        ((sample(f, x, y + h, z)[1] ?? 0) - (sample(f, x, y - h, z)[1] ?? 0)) / (2 * h) +
        ((sample(f, x, y, z + h)[2] ?? 0) - (sample(f, x, y, z - h)[2] ?? 0)) / (2 * h);
      expect(Math.abs(div)).toBeLessThan(1e-6);
    }
  });

  it('samples a non-unit direction exactly like its unit direction', () => {
    const scaled = new FlowField(BOUNDS, { ...MAX, direction: [3, 4] });
    const unit = new FlowField(BOUNDS, { ...MAX, direction: [0.6, 0.8] });
    for (const [x, y, z] of [
      [0.2, 0.5, 0.1],
      [-0.7, 0.05, -0.2],
    ] as const) {
      expect(sample(scaled, x, y, z)).toEqual(sample(unit, x, y, z));
    }
    expect(scaled.sway(0)).toEqual({ direction: [0.6, 0.8], speed: MAX.speedMps });
  });

  it('pushes along the given direction across the top', () => {
    const f = new FlowField(BOUNDS, { ...MAX, direction: [0, -1] });
    const top = sample(f, 0, 0.6, 0);
    expect(top[2]).toBeCloseTo(-MAX.speedMps, 12);
    expect(Math.abs(top[0] ?? 1)).toBeLessThan(1e-12);
  });

  it('scales with strength and stops at zero', () => {
    const half = new FlowField(BOUNDS, { ...MAX, speedMps: MAX.speedMps / 2 });
    const full = new FlowField(BOUNDS, MAX);
    const off = new FlowField(BOUNDS, { ...MAX, speedMps: 0 });
    expect((sample(half, 0.3, 0.5, 0)[0] ?? 0) * 2).toBeCloseTo(
      sample(full, 0.3, 0.5, 0)[0] ?? 0,
      12,
    );
    expect(sample(off, 0.3, 0.5, 0).every((c) => c === 0 || Object.is(c, -0))).toBe(true);
    expect(off.sway(1).speed).toBe(0);
  });

  it('pulses between its floor and full power', () => {
    const f = new FlowField(BOUNDS, { ...MAX, mode: 'pulse', periodS: 8 });
    expect(f.amplitude(0)).toBeCloseTo(WAVE_MAKER.pulseFloor, 12);
    expect(f.amplitude(4)).toBeCloseTo(1, 12);
    for (let t = 0; t < 16; t += 0.37) {
      expect(f.amplitude(t)).toBeGreaterThanOrEqual(WAVE_MAKER.pulseFloor - 1e-12);
      expect(f.amplitude(t)).toBeLessThanOrEqual(1);
    }
  });

  it('reverses the gyre with an alternating pair and the sway follows', () => {
    const f = new FlowField(BOUNDS, { ...MAX, mode: 'alternating', periodS: 40 });
    expect(f.amplitude(10)).toBe(1);
    expect(f.amplitude(30)).toBe(-1);
    expect(f.amplitude(0)).toBeCloseTo(0, 12);
    expect(sample(f, 0, 0.6, 0, 30)[0]).toBeCloseTo(-MAX.speedMps, 12);
    expect(f.sway(10)).toEqual({ direction: [1, 0], speed: MAX.speedMps });
    expect(f.sway(30)).toEqual({ direction: [-1, -0], speed: MAX.speedMps });
  });

  it('holds steady in steady mode', () => {
    const f = new FlowField(BOUNDS, MAX);
    expect([0, 3.3, 1000].map((t) => f.amplitude(t))).toEqual([1, 1, 1]);
  });
});

describe('a wave maker in the world', { timeout: 120_000 }, () => {
  it('without one, set to null or at zero strength, runs bit-identically', () => {
    const steps = 1500;
    const base = run(reef(7, community), steps);
    const none = run(reef(7, community, null), steps);
    const zero = run(reef(7, community, { ...MAX, speedMps: 0 }), steps);
    // All three take the same no-current branch, so only a pinned trajectory catches a change to
    // that branch itself. A deliberate change to still-water behaviour updates the pin.
    expect(bitDigest(base.position)).toBe('0855d268');
    expect(none.position).toEqual(base.position);
    expect(zero.position).toEqual(base.position);
    expect(zero.speed).toEqual(base.speed);
    expect(zero.flowField).toBeNull();
    expect(zero.currents.flow.every((c) => c === 0)).toBe(true);
  });

  it('switched off mid-run, clears every fish of flow and shelter', () => {
    const w = run(reef(7, spawnMany('royal-gramma', 1), MAX), 3000);
    w.setWaveMaker(null);
    expect(w.flowField).toBeNull();
    expect(w.currents.flow.every((c) => c === 0)).toBe(true);
    expect(w.flowShelter.every((c) => c === 0)).toBe(true);
  });

  it('gives the same trajectory for the same seed at max strength', () => {
    const steps = 1500;
    const a = run(reef(11, community, MAX), steps);
    const b = run(reef(11, community, MAX), steps);
    const still = run(reef(11, community), steps);
    expect(a.position).toEqual(b.position);
    expect(a.currents.stress).toEqual(b.currents.stress);
    expect(a.position).not.toEqual(still.position);
  });

  it('gives the same trajectory for a direction and its unit direction', () => {
    const steps = 900;
    const a = run(reef(11, community, { ...MAX, direction: [3, 4] }), steps);
    const b = run(reef(11, community, { ...MAX, direction: [0.6, 0.8] }), steps);
    expect(a.position).toEqual(b.position);
  });

  it('is the same water in the sim as in a field built from the tank bounds', () => {
    const w = reef(3, spawnMany('yellow-tang', 1), MAX);
    run(w, 30);
    const b = w.basin;
    const scene = new FlowField(
      { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, minY: b.minY, maxY: b.maxY },
      MAX,
    );
    const p = [0.1, 0.4, 0.05] as const;
    const fromSim = new Float64Array(3);
    const fromScene = new Float64Array(3);
    w.flowField?.sample(...p, w.time, fromSim);
    scene.sample(...p, 30 * STEP_DT, fromScene);
    expect(fromScene).toEqual(fromSim);
  });

  it('leaves walkers clinging to their surface untouched by the flow', () => {
    const w = run(
      reef(5, [...spawnMany(cherryShrimp.id, 4), ...spawnMany('yellow-tang', 1)], MAX),
      600,
    );
    for (let i = 0; i < 4; i++) {
      expect(localSpeed(w, i)).toBe(0);
      expect(w.flowShelter[i]).toBe(0);
    }
    expect(localSpeed(w, 4)).toBeGreaterThan(0);
  });

  it('turns hovering fish to face into the current (positive rheotaxis)', () => {
    for (const id of [clownfish.id, yellowTang.id]) {
      const w = reef(3, spawnMany(id, 2), MAX);
      let upstream = 0;
      let samples = 0;
      for (let t = 0; t < 4000; t++) {
        w.step();
        for (let i = 0; i < w.count; i++) {
          const m = localSpeed(w, i);
          if (m < 0.02) continue;
          const o = i * 3;
          const f = w.currents.flow;
          upstream -=
            ((w.forward[o] ?? 0) * (f[o] ?? 0) +
              (w.forward[o + 1] ?? 0) * (f[o + 1] ?? 0) +
              (w.forward[o + 2] ?? 0) * (f[o + 2] ?? 0)) /
            m;
          samples++;
        }
      }
      expect(samples).toBeGreaterThan(1000);
      expect(upstream / samples, id).toBeGreaterThan(0.6);
    }
  });

  it('never carries a fish through glass or rock at max strength', () => {
    const w = reef(4, community, MAX);
    let worst = Infinity;
    for (let t = 0; t < 10_000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(w.contacts / (w.count * 10_000)).toBeLessThan(1e-3);
  });

  it('sends a weak cave-dweller into its cave at high flow, not in still water', () => {
    const cave = REEF_ANCHORS.find((a) => a.kind === 'cave');
    expect(cave).toBeDefined();
    const nearCave = (waveMaker: WaveMakerSettings | null) => {
      const w = reef(3, spawnMany(royalGramma.id, 1), waveMaker);
      let near = 0;
      let shelter = 0;
      const steps = 6000;
      for (let t = 0; t < steps; t++) {
        w.step();
        const [cx, cy, cz] = cave?.position ?? [0, 0, 0];
        const d = Math.hypot(
          (w.position[0] ?? 0) - cx,
          (w.position[1] ?? 0) - cy,
          (w.position[2] ?? 0) - cz,
        );
        if (d < 0.12) near++;
        shelter += w.flowShelter[0] ?? 0;
      }
      return { near: near / steps, shelter: shelter / steps };
    };
    const still = nearCave(null);
    const flow = nearCave(MAX);
    expect(still.shelter).toBe(0);
    expect(flow.shelter).toBeGreaterThan(0.05);
    expect(flow.near).toBeGreaterThan(still.near + 0.25);
  });

  it('keeps a strong swimmer out in the flow without seeking shelter', () => {
    const w = reef(3, spawnMany(yellowTang.id, 2), MAX);
    let shelter = 0;
    let local = 0;
    for (let t = 0; t < 6000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        shelter += w.flowShelter[i] ?? 0;
        local += localSpeed(w, i);
      }
    }
    expect(shelter).toBe(0);
    expect(local / (6000 * w.count)).toBeGreaterThan(0.05);
  });

  it('leaves weak free swimmers in slacker water than strong ones', () => {
    const meanLocal = (id: string) => {
      const w = new World({
        seed: 5,
        tank: REEF_TANK,
        species: SPECIES,
        fish: spawnMany(id, 4),
        waveMaker: MAX,
      });
      let local = 0;
      let n = 0;
      for (let t = 0; t < 9000; t++) {
        w.step();
        if (t < 600) continue;
        for (let i = 0; i < w.count; i++) {
          local += localSpeed(w, i);
          n++;
        }
      }
      return local / n;
    };
    expect(meanLocal(guppy.id)).toBeLessThan(0.5 * meanLocal(yellowTang.id));
  });

  it('points a stressed fish toward slacker water', () => {
    const w = reef(3, spawnMany(clownfish.id, 1), MAX);
    run(w, 1);
    const at = (x: number, y: number, z: number) => {
      w.position[0] = x;
      w.position[1] = y;
      w.position[2] = z;
      w.currents.update(w, 0);
      return localSpeed(w, 0);
    };
    const dir = new Float64Array(3);
    const start = [0.6, 0.5, 0.1] as const;
    const before = at(...start);
    expect(w.currents.refuge(w, 0, dir)).toBe(true);
    expect(Math.hypot(...dir)).toBeCloseTo(1, 12);
    const step = 0.02;
    const [dx = 0, dy = 0, dz = 0] = dir;
    const after = at(start[0] + dx * step, start[1] + dy * step, start[2] + dz * step);
    expect(after).toBeLessThan(before);
  });

  it('finds no refuge without a wave maker', () => {
    const w = reef(3, spawnMany(clownfish.id, 1));
    expect(w.currents.refuge(w, 0, new Float64Array(3))).toBe(false);
  });
});
