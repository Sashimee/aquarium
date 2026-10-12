import { describe, expect, it } from 'vitest';
import { normaliseDirection, sampleCurrent, type CurrentParameters } from './current';

const params: CurrentParameters = {
  direction: [1, 0],
  speed: 0.05,
  gustPeriodS: 8,
  gustDepth: 0.4,
};

function sample(x: number, y: number, z: number, t: number): number[] {
  const out = [0, 0, 0];
  sampleCurrent(params, x, y, z, t, out);
  return out;
}

describe('sampleCurrent', () => {
  it('is deterministic', () => {
    expect(sample(0.1, 0.2, 0.3, 4)).toEqual(sample(0.1, 0.2, 0.3, 4));
  });

  it('flows along the configured direction on average', () => {
    let sum = 0;
    const steps = 800;
    for (let i = 0; i < steps; i++) {
      sum += sample(0, 0.2, 0, (i / steps) * params.gustPeriodS)[0] ?? 0;
    }
    expect(sum / steps).toBeCloseTo(params.speed, 3);
  });

  it('gusts stay within the gust depth envelope', () => {
    for (let i = 0; i < 200; i++) {
      const v = sample(0.2, 0.1, -0.1, i * 0.1);
      expect(Math.hypot(v[0] ?? 0, v[2] ?? 0)).toBeLessThan(params.speed * 2);
    }
  });

  it('varies with position', () => {
    expect(sample(0, 0, 0, 1)).not.toEqual(sample(0.4, 0, 0, 1));
  });

  it('is steady with zero gust depth', () => {
    const out = [0, 0, 0];
    sampleCurrent({ ...params, gustDepth: 0 }, 0.3, 0.1, 0.1, 2, out);
    expect(out[0]).toBeCloseTo(0.05);
    expect(out[2]).toBeCloseTo(0);
  });
});

describe('normaliseDirection', () => {
  it('returns a unit vector', () => {
    const [x, z] = normaliseDirection([3, 4]);
    expect(x).toBeCloseTo(0.6);
    expect(z).toBeCloseTo(0.8);
  });

  it('rejects a zero direction', () => {
    expect(() => normaliseDirection([0, 0])).toThrow(RangeError);
  });
});
