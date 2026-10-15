import { describe, expect, it } from 'vitest';
import { FOOD_PARTICLES } from '@aquarium/sim';
import { FOOD_PROFILES, NORI_SCALE_MAX, NORI_SCALE_MIN } from '../food/profiles';
import { buildNoriGeometry, noriScale, noriSeed, SHEET_LENGTH } from './nori';

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
    expect(rearmost).toBeLessThan(-0.15);
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

describe('noriScale', () => {
  it('stays within the range the side-wall clearance assumes', () => {
    for (let id = 1; id <= 200; id++) {
      const scale = noriScale(id);
      expect(scale).toBeGreaterThanOrEqual(FOOD_PROFILES.nori.radius * NORI_SCALE_MIN);
      expect(scale).toBeLessThanOrEqual(FOOD_PROFILES.nori.radius * NORI_SCALE_MAX);
    }
  });
});
