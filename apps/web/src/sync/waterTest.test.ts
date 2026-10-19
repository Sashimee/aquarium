import { newTankChemistry } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { FISH_1, fishFixture, speciesFixture, tankFixture } from './fixtures';
import {
  PADS,
  describeReading,
  dipStrip,
  formatStep,
  gradeGuess,
  nearestStep,
  padsFor,
  rawValues,
  readPad,
  suitability,
  type PadId,
} from './waterTest';

describe('chart integrity', () => {
  it.each(Object.keys(PADS) as PadId[])('%s steps ascend and carry distinct colours', (id) => {
    const { steps } = PADS[id];
    expect(steps.length).toBeGreaterThanOrEqual(5);
    steps.forEach((s, i) => {
      if (i > 0) expect(s.value).toBeGreaterThan(steps[i - 1]?.value ?? Infinity);
    });
    expect(new Set(steps.map((s) => s.colour)).size).toBe(steps.length);
  });

  it('hazard never improves as a toxin goes up', () => {
    const order = { safe: 0, caution: 1, danger: 2 };
    for (const id of ['ammonia', 'nitrite', 'nitrate'] as const) {
      const ranks = PADS[id].steps.map((s) => order[s.hazard]);
      expect(ranks).toEqual([...ranks].sort());
    }
  });
});

describe('readPad', () => {
  it('maps a value to the nearest chart step and its colour', () => {
    const r = readPad('ph', 7.1);
    expect(r?.stepIndex).toBe(4);
    expect(r?.colour).toBe(PADS.ph.steps[4]?.colour);
    expect(r?.offscale).toBeNull();
  });

  it('reads a clean tank as the zero step, safe', () => {
    expect(readPad('ammonia', 0)).toMatchObject({ stepIndex: 0, hazard: 'safe', offscale: null });
  });

  it('rounds a tiny trace down to zero', () => {
    expect(readPad('nitrite', 0.004)?.stepIndex).toBe(0);
  });

  it('puts an exact midpoint on the higher step', () => {
    expect(nearestStep(PADS.nitrate.steps, 5)).toBe(1);
    expect(nearestStep(PADS.ph.steps, 7.25)).toBe(5);
  });

  it('matches an exact step value', () => {
    PADS.kh.steps.forEach((s, i) => expect(readPad('kh', s.value)?.stepIndex).toBe(i));
  });

  it('clamps above the chart and flags it', () => {
    const r = readPad('ammonia', 40);
    expect(r).toMatchObject({ stepIndex: PADS.ammonia.steps.length - 1, offscale: 'above' });
    expect(describeReading(r ?? undefined)).toBe('above 1.00 ppm');
  });

  it('clamps below the chart and flags it', () => {
    const r = readPad('ph', 2);
    expect(r).toMatchObject({ stepIndex: 0, offscale: 'below' });
    expect(describeReading(r ?? undefined)).toBe('below 5.0');
  });

  it('keeps the boundary values on scale', () => {
    expect(readPad('ph', 5)?.offscale).toBeNull();
    expect(readPad('ph', 9)?.offscale).toBeNull();
    expect(readPad('ph', 9.001)?.offscale).toBe('above');
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])('gives no reading for %s', (v) => {
    expect(readPad('ph', v)).toBeNull();
  });

  it('describes a missing reading in words', () => {
    expect(describeReading(undefined)).toBe('no reading');
  });
});

describe('dipStrip', () => {
  it('reads every pad of a freshwater strip from the tank values', () => {
    const tank = tankFixture({
      water: { ammonia: 0.3, nitrate: 45, algae: 0, uneatenFood: 0 },
      chemistry: { ...newTankChemistry('freshwater'), nitrite: 0.5, ph: 6.4, kh: 4 },
    });
    const strip = dipStrip(tank.biome, rawValues(tank));
    expect(Object.keys(strip).sort()).toEqual(['ammonia', 'kh', 'nitrate', 'nitrite', 'ph']);
    expect(strip.ammonia?.hazard).toBe('caution');
    expect(strip.nitrate?.stepIndex).toBe(3);
    expect(strip.nitrite?.hazard).toBe('caution');
    expect(strip.ph?.stepIndex).toBe(3);
    expect(strip.kh?.stepIndex).toBe(1);
  });

  it('adds a salinity pad for reef and mangrove only', () => {
    expect(padsFor('reef')).toContain('salinity');
    expect(padsFor('mangrove')).toContain('salinity');
    expect(padsFor('freshwater')).not.toContain('salinity');
    expect(padsFor('blackwater')).not.toContain('salinity');
  });

  it('leaves a pad out when its value is missing', () => {
    const strip = dipStrip('freshwater', { ph: 7, ammonia: 0 });
    expect(Object.keys(strip).sort()).toEqual(['ammonia', 'ph']);
  });

  it('reads a reef tank salinity of 35 ppt on its own step', () => {
    const tank = tankFixture({ biome: 'reef', chemistry: newTankChemistry('reef') });
    const strip = dipStrip(tank.biome, rawValues(tank));
    expect(formatStep('salinity', strip.salinity?.stepIndex ?? -1)).toBe('35 ppt');
  });

  it('formats an out-of-range step index as no reading', () => {
    expect(formatStep('ph', 99)).toBe('no reading');
  });
});

describe('gradeGuess', () => {
  it('grades by distance in steps', () => {
    const reading = readPad('ph', 7);
    if (!reading) throw new Error('reading expected');
    expect(gradeGuess(reading, 4)).toBe('exact');
    expect(gradeGuess(reading, 3)).toBe('close');
    expect(gradeGuess(reading, 5)).toBe('close');
    expect(gradeGuess(reading, 0)).toBe('off');
  });
});

describe('suitability', () => {
  const tetra = speciesFixture();
  const withFish = tankFixture({ fish: [fishFixture(FISH_1)] });

  it('has nothing to compare with an empty tank or a missing value', () => {
    expect(suitability(tankFixture(), [tetra], 'ph', 7)).toBe('no-fish');
    expect(suitability(withFish, [tetra], 'ph', undefined)).toBe('no-fish');
  });

  it('accepts values on the species range boundary', () => {
    const [lo, hi] = tetra.chemistry.phRange;
    expect(suitability(withFish, [tetra], 'ph', lo)).toBe('suits');
    expect(suitability(withFish, [tetra], 'ph', hi)).toBe('suits');
    expect(suitability(withFish, [tetra], 'ph', hi + 0.01)).toBe('outside');
  });

  it('flags KH below the species minimum', () => {
    const picky = speciesFixture({ chemistry: { ...tetra.chemistry, khMin: 5 } });
    expect(suitability(withFish, [picky], 'kh', 4.9)).toBe('outside');
    expect(suitability(withFish, [picky], 'kh', 5)).toBe('suits');
  });

  it('ignores dead fish', () => {
    const tank = tankFixture({
      fish: [fishFixture(FISH_1, { status: 'dead', diedAt: '2026-01-02T00:00:00.000Z' })],
    });
    expect(suitability(tank, [tetra], 'ph', 7)).toBe('no-fish');
  });
});
