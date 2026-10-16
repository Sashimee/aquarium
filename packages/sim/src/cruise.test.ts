import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { World, type FishSpawn } from './world.ts';

const dir = join(import.meta.dirname, '../../../content/species');
const DEG = Math.PI / 180;
const HZ = 30;
const SETTLE_STEPS = 3 * HZ;
const SECONDS = 30;
const SEEDS = [1, 2, 3];
/** A 31-sample (≈1 s) centred mean: what is left over is the bob, not a depth change. */
const HALF_WINDOW = 15;
/** Pitch-rate swings smaller than this are trim, not a visible nod. */
const NOD_DEADBAND = 20 * DEG;

const TANK = { width: 1.18, height: 0.4, depth: 0.48 };
const PRESETS: Record<string, Record<string, number>> = {
  freshwater: { 'neon-tetra': 14, angelfish: 2, 'bronze-corydoras': 5, betta: 1, guppy: 4 },
  reef: {
    'ocellaris-clownfish': 2,
    'yellow-tang': 1,
    'royal-gramma': 1,
    'banggai-cardinalfish': 1,
  },
};
const SHOALERS = new Set(['neon-tetra', 'guppy']);

function load(id: string) {
  return speciesContentSchema.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
}

function highPass(x: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = HALF_WINDOW; i < x.length - HALF_WINDOW; i++) {
    let sum = 0;
    for (let k = -HALF_WINDOW; k <= HALF_WINDOW; k++) sum += x[i + k] ?? 0;
    out.push((x[i] ?? 0) - sum / (2 * HALF_WINDOW + 1));
  }
  return out;
}

function rms(x: readonly number[]): number {
  return Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
}

function signFlips(x: readonly number[], deadband: number): number {
  let flips = 0;
  let last = 0;
  for (const v of x) {
    if (Math.abs(v) < deadband) continue;
    const sign = Math.sign(v);
    if (last !== 0 && sign !== last) flips++;
    last = sign;
  }
  return flips;
}

interface Cruise {
  /** High-pass vertical displacement, RMS in body lengths. */
  bob: number;
  maxPitchRate: number;
  nodsPerS: number;
}

function cruise(preset: string, seed: number): Map<string, Cruise[]> {
  const counts = PRESETS[preset] ?? {};
  const fish: FishSpawn[] = Object.entries(counts).flatMap(([species, n]) =>
    Array.from({ length: n }, (_, k) => ({ id: `${species}-${k}`, species })),
  );
  const w = new World({
    seed,
    tank: TANK,
    species: Object.keys(counts).map(load),
    fish,
    light: 1,
  });
  const ys: number[][] = fish.map(() => []);
  const rates: number[][] = fish.map(() => []);
  for (let t = 0; t < SETTLE_STEPS + SECONDS * HZ; t++) {
    w.step();
    if (t < SETTLE_STEPS) continue;
    for (let i = 0; i < w.count; i++) {
      ys[i]?.push(w.position[i * 3 + 1] ?? 0);
      rates[i]?.push(w.pitchRate[i] ?? 0);
    }
  }
  const out = new Map<string, Cruise[]>();
  for (let i = 0; i < w.count; i++) {
    const y = ys[i] ?? [];
    const rate = rates[i] ?? [];
    const runs = out.get(w.speciesOf(i).id) ?? [];
    runs.push({
      bob: rms(highPass(y)) / (w.bodyLength[i] ?? 1),
      maxPitchRate: Math.max(...rate.map(Math.abs)),
      nodsPerS: signFlips(rate, NOD_DEADBAND) / SECONDS,
    });
    out.set(w.speciesOf(i).id, runs);
  }
  return out;
}

const mean = (x: readonly number[]) => x.reduce((a, v) => a + v, 0) / x.length;

describe('cruising fish swim level, without bobbing or nodding', { timeout: 120_000 }, () => {
  it.each(Object.keys(PRESETS))('%s community', (preset) => {
    const bySpecies = new Map<string, Cruise[]>();
    for (const seed of SEEDS) {
      for (const [id, runs] of cruise(preset, seed)) {
        bySpecies.set(id, [...(bySpecies.get(id) ?? []), ...runs]);
      }
    }
    for (const [id, runs] of bySpecies) {
      const bob = mean(runs.map((r) => r.bob));
      const worstRate = Math.max(...runs.map((r) => r.maxPitchRate));
      const nods = mean(runs.map((r) => r.nodsPerS));
      // Shoalers jostle for place in a moving school; loners hold a depth.
      expect(bob, `${id} bob (body lengths)`).toBeLessThan(SHOALERS.has(id) ? 0.04 : 0.0175);
      // Nosing into the sand and darting up for air are held postures, pitched at full turn rate.
      const peakCap = load(id).behaviour.traits.includes('air-gulp') ? 150 : 90;
      expect(worstRate / DEG, `${id} peak pitch rate (°/s)`).toBeLessThan(peakCap);
      expect(nods, `${id} nods per second`).toBeLessThan(0.5);
    }
  });
});
