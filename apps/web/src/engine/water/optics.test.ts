import { describe, expect, it } from 'vitest';
import { float } from 'three/tsl';
import { evaluate } from '../shaderFixtures';
import { AIR_IOR, fresnelDielectric, WATER_IOR } from './optics';

function reflectance(angleDegrees: number, eta: number): number {
  const [r] = evaluate(fresnelDielectric(float(Math.cos((angleDegrees * Math.PI) / 180)), eta));
  if (r === undefined) throw new Error('fresnelDielectric evaluated to nothing');
  return r;
}

const WATER_TO_AIR = WATER_IOR / AIR_IOR;
const AIR_TO_WATER = AIR_IOR / WATER_IOR;
const CRITICAL = (Math.asin(1 / WATER_TO_AIR) * 180) / Math.PI;

describe('fresnelDielectric', () => {
  it('reflects about 2% at normal incidence from either side', () => {
    const normal = ((WATER_IOR - AIR_IOR) / (WATER_IOR + AIR_IOR)) ** 2;
    expect(reflectance(0, WATER_TO_AIR)).toBeCloseTo(normal, 6);
    expect(reflectance(0, AIR_TO_WATER)).toBeCloseTo(normal, 6);
    expect(normal).toBeLessThan(0.025);
  });

  it('stays faint well inside the critical angle and rises with it', () => {
    let previous = 0;
    for (let angle = 0; angle < CRITICAL - 0.5; angle += 2) {
      const r = reflectance(angle, WATER_TO_AIR);
      expect(r).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = r;
    }
    expect(reflectance(30, WATER_TO_AIR)).toBeLessThan(0.03);
  });

  it('reflects totally past the critical angle of 48.6° from water into air', () => {
    expect(CRITICAL).toBeCloseTo(48.6, 1);
    expect(reflectance(CRITICAL - 1, WATER_TO_AIR)).toBeLessThan(1);
    for (const angle of [CRITICAL + 0.1, 60, 75, 89.9]) {
      expect(reflectance(angle, WATER_TO_AIR)).toBe(1);
    }
  });

  it('meets total reflection without a jump at the critical angle', () => {
    const approach = [1, 0.1, 0.01, 0.0001].map((d) => reflectance(CRITICAL - d, WATER_TO_AIR));
    for (let i = 1; i < approach.length; i++) {
      expect(approach[i]).toBeGreaterThan(approach[i - 1] ?? 1);
    }
    expect(approach.at(-1)).toBeGreaterThan(0.98);
  });

  it('never reflects totally from air into water, only towards grazing', () => {
    expect(reflectance(80, AIR_TO_WATER)).toBeLessThan(1);
    expect(reflectance(89.9, AIR_TO_WATER)).toBeGreaterThan(0.95);
  });
});
