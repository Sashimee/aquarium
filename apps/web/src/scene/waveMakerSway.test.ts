import { describe, expect, it } from 'vitest';
import { waveMakerForTier, type FlowBounds, type WaveMakerSettings } from '@aquarium/sim';
import { CurrentField, waveMakerPush, type CurrentParameters } from './current';

const bounds: FlowBounds = { minX: -0.5, maxX: 0.5, minZ: -0.25, maxZ: 0.25, minY: 0, maxY: 0.5 };
const ambient: CurrentParameters = {
  direction: [1, 0],
  speed: 0.04,
  gustPeriodS: 9,
  gustDepth: 0.4,
};

function field(settings: WaveMakerSettings | null): CurrentField {
  const f = new CurrentField();
  f.configure(ambient);
  f.setWaveMaker(settings, bounds);
  return f;
}

function push(f: CurrentField, t: number): number[] {
  const out = [0, 0];
  waveMakerPush(f.waveMaker, t, out);
  return out;
}

describe('wave maker sway', () => {
  it('leaves the ambient current untouched with no wave maker', () => {
    const plain = new CurrentField();
    plain.configure(ambient);
    const pumped = field(null);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    plain.sample(0.1, 0.2, 0.05, a);
    pumped.sample(0.1, 0.2, 0.05, b);
    expect(b).toEqual(a);
    expect(pumped.waveMakerVelocity.value.toArray()).toEqual([0, 0, 0]);
  });

  it('treats a pump at speed 0 as none', () => {
    const f = field({ direction: [1, 0], speedMps: 0, mode: 'steady', periodS: 8 });
    expect(f.waveMaker).toBeNull();
  });

  it('pushes at full strength along the direction in steady mode', () => {
    const f = field({ direction: [0, 2], speedMps: 0.3, mode: 'steady', periodS: 8 });
    const [x, z] = push(f, 3);
    expect(x).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(0.3, 12);
    expect(f.waveMakerVelocity.value.z).toBeCloseTo(0.3, 6);
  });

  it('pulses between the floor and full strength', () => {
    const f = field({ direction: [1, 0], speedMps: 0.2, mode: 'pulse', periodS: 8 });
    expect(push(f, 0)[0]).toBeCloseTo(0.2 * 0.25, 12);
    expect(push(f, 4)[0]).toBeCloseTo(0.2, 12);
  });

  it('reverses direction with an alternating pair', () => {
    const f = field({ direction: [1, 0], speedMps: 0.18, mode: 'alternating', periodS: 40 });
    expect(push(f, 10)[0]).toBeGreaterThan(0.17);
    expect(push(f, 30)[0]).toBeLessThan(-0.17);
  });

  it('follows a changed direction', () => {
    const f = field({ direction: [1, 0], speedMps: 0.1, mode: 'steady', periodS: 8 });
    f.setWaveMaker({ direction: [0, -1], speedMps: 0.1, mode: 'steady', periodS: 8 }, bounds);
    const [x, z] = push(f, 0);
    expect(x).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(-0.1, 12);
  });

  it('adds the push to the ambient sample', () => {
    const settings = { direction: [1, 0], speedMps: 0.1, mode: 'steady', periodS: 8 } as const;
    const plain = field(null);
    const pumped = field(settings);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    plain.sample(0, 0.2, 0, a);
    pumped.sample(0, 0.2, 0, b);
    expect(b[0]).toBeCloseTo((a[0] ?? 0) + 0.1, 12);
    expect(b[2]).toBeCloseTo(a[2] ?? 0, 12);
  });

  it('is deterministic and periodic in the pump period', () => {
    const settings = waveMakerForTier(2);
    const a = field(settings);
    const b = field(settings);
    for (const t of [0, 1.3, 5.9]) {
      expect(push(a, t)).toEqual(push(b, t));
      expect(push(a, t + 8)[0]).toBeCloseTo(push(a, t)[0] ?? 0, 9);
    }
  });

  it('advances and syncs the pump phase with the clock', () => {
    const f = field({ direction: [1, 0], speedMps: 0.2, mode: 'pulse', periodS: 8 });
    f.advance(4);
    expect(f.waveMakerVelocity.value.x).toBeCloseTo(0.2, 6);
    f.syncWaveMaker(16);
    expect(f.waveMakerVelocity.value.x).toBeCloseTo(0.05, 6);
  });

  it('never exceeds the pump speed', () => {
    const f = field(waveMakerForTier(3));
    for (let t = 0; t < 80; t += 0.37)
      expect(Math.abs(push(f, t)[0] ?? 0)).toBeLessThanOrEqual(0.18 + 1e-12);
  });
});
