import { describe, expect, it } from 'vitest';
import { FOOD_PARTICLES } from '@aquarium/sim';
import { FOOD_PROFILES } from '../food/profiles';
import { buildNoriGeometry, hangAngle, noriSeed, SHEET_LENGTH } from './nori';

describe('nori geometry', () => {
  const geometry = buildNoriGeometry();
  const part = geometry.getAttribute('part');
  const position = geometry.getAttribute('position');

  it('merges a subdivided sheet and a clip into one indexed geometry', () => {
    expect(geometry.index).not.toBeNull();
    expect(part.count).toBe(position.count);
    const parts = new Set(Array.from({ length: part.count }, (_, i) => part.getX(i)));
    expect([...parts].sort()).toEqual([0, 1]);
  });

  it('hangs the sheet below the clip and keeps it within its stated size', () => {
    for (let i = 0; i < position.count; i++) {
      if (part.getX(i) !== 0) continue;
      expect(position.getY(i)).toBeLessThanOrEqual(1e-6);
      expect(position.getY(i)).toBeGreaterThanOrEqual(-SHEET_LENGTH - 1e-6);
      expect(Math.abs(position.getX(i))).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('puts the suction cup behind the sheet', () => {
    let rearmost = 0;
    for (let i = 0; i < position.count; i++) {
      if (part.getX(i) === 1) rearmost = Math.min(rearmost, position.getZ(i));
    }
    expect(rearmost).toBeLessThan(-0.25);
  });

  it('spans uv 0..1 down the sheet, which the shader tears and bites against', () => {
    const uv = geometry.getAttribute('uv');
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < position.count; i++) {
      if (part.getX(i) !== 0) continue;
      min = Math.min(min, uv.getY(i));
      max = Math.max(max, uv.getY(i));
    }
    expect([min, max]).toEqual([0, 1]);
  });
});

describe('hangAngle', () => {
  it('hangs straight in open water', () => {
    expect(hangAngle(1, 0.03)).toBe(0);
  });

  it('lies flat on the sand', () => {
    expect(hangAngle(0, 0.03)).toBeCloseTo(Math.PI / 2, 9);
    expect(hangAngle(-0.01, 0.03)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('swings so the lowest edge just touches the sand', () => {
    const scale = 0.03;
    const height = 0.02;
    const angle = hangAngle(height, scale);
    expect(SHEET_LENGTH * scale * Math.cos(angle)).toBeCloseTo(height, 9);
  });
});

describe('noriSeed', () => {
  it('is stable, within 0..1 and varies between ids', () => {
    const seeds = Array.from({ length: 50 }, (_, i) => noriSeed(i + 1));
    for (const s of seeds) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
    expect(noriSeed(7)).toBe(noriSeed(7));
    expect(new Set(seeds).size).toBeGreaterThan(45);
  });
});

describe('nori profile', () => {
  it('is a few-centimetre sheet and the sim hands out a real portion per sheet', () => {
    expect(FOOD_PROFILES.nori.radius * 2).toBeGreaterThan(0.04);
    expect(FOOD_PROFILES.nori.radius * 2).toBeLessThan(0.08);
    expect(FOOD_PARTICLES.nori.portion).toBeGreaterThan(0);
  });
});
