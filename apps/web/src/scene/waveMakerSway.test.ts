import { describe, expect, it } from 'vitest';
import {
  FlowField,
  WAVE_MAKER,
  waveMakerForTier,
  type FlowBounds,
  type WaveMakerSettings,
} from '@aquarium/sim';
import {
  CurrentField,
  PUMP_LEAN_HEIGHT,
  PUMP_PEAK_MPS,
  limitLean,
  reachCurrent,
  type CurrentParameters,
} from './current';
import { leanSeconds, maxSway } from './plants';

const bounds: FlowBounds = { minX: -0.5, maxX: 0.5, minZ: -0.25, maxZ: 0.25, minY: 0, maxY: 0.5 };
const ambient: CurrentParameters = {
  direction: [1, 0],
  speed: 0.04,
  gustPeriodS: 9,
  gustDepth: 0.4,
};

const pulse: WaveMakerSettings = { direction: [1, 0], speedMps: 0.2, mode: 'pulse', periodS: 8 };
const alternating: WaveMakerSettings = {
  direction: [0.6, 0.8],
  speedMps: 0.18,
  mode: 'alternating',
  periodS: 40,
};
const steady: WaveMakerSettings = { direction: [0, 1], speedMps: 0.12, mode: 'steady', periodS: 8 };

function current(settings: WaveMakerSettings | null, timeS = 0): CurrentField {
  const f = new CurrentField();
  f.configure(ambient);
  f.setWaveMaker(settings === null ? null : new FlowField(bounds, settings), timeS);
  return f;
}

function shaderFlow(f: CurrentField, x: number, y: number, z: number): [number, number] {
  const gain = [0, 0];
  f.pumpGainAt(x, y, z, gain);
  const amplitude = f.pumpAmplitude.value;
  return [(gain[0] ?? 0) * amplitude, (gain[1] ?? 0) * amplitude];
}

describe('wave maker sway input', () => {
  it('adds nothing with no wave maker', () => {
    const plain = new CurrentField();
    plain.configure(ambient);
    const none = current(null);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    plain.sample(0.1, 0.2, 0.05, a);
    none.sample(0.1, 0.2, 0.05, b);
    expect(b).toEqual(a);
    expect(none.pumpAmplitude.value).toBe(0);
    expect(shaderFlow(none, 0.1, 0.1, 0)).toEqual([0, 0]);
  });

  it.each([
    ['steady', steady],
    ['pulse', pulse],
    ['alternating', alternating],
    ['tier 3', waveMakerForTier(3) ?? steady],
  ])('hands the shader the sim field at plant and coral heights (%s)', (_, settings) => {
    const sim = new FlowField(bounds, settings);
    const f = current(settings);
    const out = [0, 0, 0];
    const roots: [number, number, number][] = [
      [-0.3, 0.02, 0.1],
      [0.1, 0.1, -0.15],
      [0.4, 0.18, 0.2],
      [-0.12, 0.3, 0],
    ];
    for (const t of [0, 1.7, 5.1, 9.9, 13.3, 27.5, 31, 38.2]) {
      f.syncWaveMaker(t);
      for (const [x, y, z] of roots) {
        sim.sample(x, y, z, t, out);
        const [fx, fz] = shaderFlow(f, x, y, z);
        expect(fx).toBeCloseTo(out[0] ?? 0, 9);
        expect(fz).toBeCloseTo(out[2] ?? 0, 9);
      }
    }
  });

  it('leans bottom-rooted things against the push along the top, as the return flow does', () => {
    const f = current(steady);
    const [, bottomZ] = shaderFlow(f, 0, 0.1, 0);
    const topPush = new FlowField(bounds, steady).sway(0);
    expect(Math.sign(bottomZ)).toBe(-Math.sign(topPush.direction[1]));
  });

  it('follows the sim time given each frame and ignores render time', () => {
    const f = current(pulse, 0);
    expect(f.pumpAmplitude.value).toBeCloseTo(0.2 * 0.25, 12);
    f.advance(4);
    expect(f.pumpAmplitude.value).toBeCloseTo(0.2 * 0.25, 12);
    f.syncWaveMaker(4);
    expect(f.pumpAmplitude.value).toBeCloseTo(0.2, 12);
    f.syncWaveMaker(1000.5);
    expect(f.pumpAmplitude.value).toBeCloseTo(
      0.2 * new FlowField(bounds, pulse).amplitude(1000.5),
      12,
    );
  });

  it('reverses with an alternating pair', () => {
    const f = current(alternating, 10);
    const forward = f.pumpAmplitude.value;
    f.syncWaveMaker(30);
    expect(forward).toBeGreaterThan(0.17);
    expect(f.pumpAmplitude.value).toBeLessThan(-0.17);
  });

  it('adds the sim field at the toy position to the ambient current', () => {
    const sim = new FlowField(bounds, steady);
    const plain = current(null);
    const pumped = current(steady);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const w = [0, 0, 0];
    for (const y of [0.05, 0.45]) {
      plain.sample(0.1, y, 0.05, a);
      pumped.sample(0.1, y, 0.05, b);
      sim.sample(0.1, y, 0.05, 0, w);
      expect(b[0]).toBeCloseTo((a[0] ?? 0) + (w[0] ?? 0), 12);
      expect(b[2]).toBeCloseTo((a[2] ?? 0) + (w[2] ?? 0), 12);
    }
    sim.sample(0.1, 0.05, 0.05, 0, a);
    sim.sample(0.1, 0.45, 0.05, 0, b);
    expect(Math.sign(a[2] ?? 0)).toBe(-Math.sign(b[2] ?? 0));
  });

  it('refreshes root gains when the pump changes and stops after dispose', () => {
    const f = current(null);
    const root = f.pumpRoot(0, 0.1, 0);
    expect(root.gain.value.toArray()).toEqual([0, 0, 0]);
    f.setWaveMaker(new FlowField(bounds, steady), 0);
    expect(root.gain.value.z).not.toBe(0);
    root.dispose();
    const before = root.gain.value.z;
    f.setWaveMaker(null, 0);
    expect(root.gain.value.z).toBe(before);
  });

  it('refuses a pump with no output rather than dividing by it', () => {
    const silent = new FlowField(bounds, { ...steady, speedMps: 0 });
    expect(() => current(null).setWaveMaker(silent, 0)).toThrow(RangeError);
  });
});

describe('lean cap', () => {
  const peak = ambient.speed * (1 + ambient.gustDepth);

  it('leaves ambient lean alone and saturates above it', () => {
    expect(limitLean(0.02, 0.03, 0.01)).toBe(0.02);
    expect(limitLean(0.03, 0.03, 0.01)).toBe(0.03);
    let last = 0;
    for (let shear = 0; shear < 50; shear += 0.05) {
      const lean = limitLean(shear, 0.03, 0.01);
      expect(lean).toBeGreaterThanOrEqual(last);
      expect(lean).toBeLessThan(0.04);
      last = lean;
    }
  });

  it('keeps euphyllia, anemone and plants from lying flat at the sim top speed', () => {
    expect(WAVE_MAKER.maxSpeedMps).toBe(0.3);
    const cases = [
      { height: 0.1, seconds: 0.5 },
      { height: 0.075, seconds: 0.35 },
      { height: 0.33, seconds: leanSeconds('vallisneria', 0.33) },
    ];
    for (const { height, seconds } of cases) {
      const lean = limitLean(
        (peak + PUMP_PEAK_MPS) * seconds,
        peak * seconds,
        PUMP_LEAN_HEIGHT * height,
      );
      expect(lean).toBeLessThan(peak * seconds + PUMP_LEAN_HEIGHT * height);
      expect(Math.atan(lean / height)).toBeLessThan(
        Math.atan((peak * seconds) / height + PUMP_LEAN_HEIGHT),
      );
    }
  });

  it('adds at most the capped pump lean to plant reach in a biome that runs a pump', () => {
    const pumped = reachCurrent(ambient, 'reef');
    for (const height of [0.1, 0.33, 0.6]) {
      const still = maxSway('vallisneria', height, ambient);
      const reach = maxSway('vallisneria', height, pumped);
      expect(reach).toBeGreaterThan(still);
      for (const axis of ['x', 'z'] as const) {
        expect(maxSway('vallisneria', height, pumped, axis)).toBeLessThanOrEqual(reach);
      }
      expect(reach - still).toBeLessThanOrEqual(PUMP_LEAN_HEIGHT * height + 1e-9);
    }
  });

  it('leaves room for a pump only where one may run', () => {
    expect(reachCurrent(ambient, 'reef').pumpMps).toBe(PUMP_PEAK_MPS);
    expect(reachCurrent(ambient, 'mangrove').pumpMps).toBe(PUMP_PEAK_MPS);
    expect(reachCurrent(ambient, 'freshwater').pumpMps).toBe(0);
  });
});
