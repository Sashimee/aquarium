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
  verdictHazard,
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
    expect(r?.stepIndex).toBe(17);
    expect(r?.colour).toBe(PADS.ph.steps[17]?.colour);
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
    expect(nearestStep(PADS.ph.steps, 7.25)).toBe(19);
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
      water: { ammonia: 0.3, nitrate: 45, algae: 0, tannin: 0, uneatenFood: 0 },
      chemistry: { ...newTankChemistry('freshwater'), nitrite: 0.5, ph: 6.4, kh: 4 },
    });
    const strip = dipStrip(tank.biome, rawValues(tank));
    expect(Object.keys(strip).sort()).toEqual(['ammonia', 'kh', 'nitrate', 'nitrite', 'ph']);
    expect(strip.ammonia?.hazard).toBe('caution');
    expect(strip.nitrate?.stepIndex).toBe(3);
    expect(strip.nitrite?.hazard).toBe('caution');
    expect(strip.ph?.stepIndex).toBe(10);
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
    expect(gradeGuess(reading, 16)).toBe('exact');
    expect(gradeGuess(reading, 15)).toBe('close');
    expect(gradeGuess(reading, 17)).toBe('close');
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

describe('verdictHazard', () => {
  const discus = speciesFixture({
    id: 'discus',
    lifecycle: { ...speciesFixture().lifecycle, ammoniaTolerance: 0.1 },
  });
  const tetra = speciesFixture();
  const tank = (water: { ammonia: number; nitrate: number }) =>
    tankFixture({
      water: { ...water, algae: 0, tannin: 0, uneatenFood: 0 },
      fish: [
        fishFixture(FISH_1),
        fishFixture('10000000-0000-4000-8000-000000000009', { species: 'discus' }),
      ],
    });

  it('grades ammonia on the strictest living fish tolerance', () => {
    const t = tank({ ammonia: 0.3, nitrate: 0 });
    const reading = readPad('ammonia', 0.3);
    expect(reading?.hazard).toBe('caution');
    expect(reading && verdictHazard(t, [tetra, discus], reading)).toBe('danger');
    expect(reading && verdictHazard(t, [tetra], reading)).toBe('danger');
    const tolerant = speciesFixture({
      lifecycle: { ...tetra.lifecycle, ammoniaTolerance: 1 },
    });
    expect(
      reading && verdictHazard(tankFixture({ fish: [fishFixture(FISH_1)] }), [tolerant], reading),
    ).toBe('safe');
  });

  it('warns at 0.4x of the tolerance and is safe below', () => {
    const t = tank({ ammonia: 0, nitrate: 0 });
    const warn = readPad('ammonia', 0.05);
    const calm = readPad('ammonia', 0.02);
    expect(warn && verdictHazard(t, [tetra, discus], warn)).toBe('caution');
    expect(calm && verdictHazard(t, [tetra, discus], calm)).toBe('safe');
  });

  it('agrees with Care on nitrate: poor from 30 ppm', () => {
    const t = tank({ ammonia: 0, nitrate: 30 });
    const reading = readPad('nitrate', 30);
    expect(reading?.hazard).toBe('caution');
    expect(reading && verdictHazard(t, [tetra, discus], reading)).toBe('danger');
    const fair = readPad('nitrate', 20);
    expect(fair && verdictHazard(t, [tetra, discus], fair)).toBe('caution');
  });

  it('grades the dipped snapshot, not the water now', () => {
    const dipped = readPad('ammonia', 0.3);
    const afterWaterChange = tank({ ammonia: 0, nitrate: 0 });
    expect(dipped && verdictHazard(afterWaterChange, [tetra, discus], dipped)).toBe('danger');
  });

  it('keeps the chart hazard for nitrite', () => {
    const reading = readPad('nitrite', 1);
    expect(reading && verdictHazard(tank({ ammonia: 0, nitrate: 0 }), [tetra], reading)).toBe(
      'danger',
    );
  });
});

describe('chart resolution matches verdicts', () => {
  const readBack = (id: PadId, value: number) => describeReading(readPad(id, value) ?? undefined);

  it('reads a default mangrove tank at 15 ppt', () => {
    expect(readBack('salinity', 15)).toBe('15 ppt');
  });

  it('reads a reef at 37 ppt as 37 and the verdict agrees', () => {
    expect(readBack('salinity', 37)).toBe('37 ppt');
    const reef = speciesFixture({
      chemistry: { ...speciesFixture().chemistry, salinityPpt: [30, 36] },
    });
    const tank = tankFixture({ biome: 'reef', fish: [fishFixture(FISH_1)] });
    expect(suitability(tank, [reef], 'salinity', readPad('salinity', 37)?.value)).toBe('outside');
    expect(suitability(tank, [reef], 'salinity', readPad('salinity', 36)?.value)).toBe('suits');
    expect(readBack('salinity', 33)).toBe('33 ppt');
  });

  it('reads pH 7.6 as 7.6 so it cannot show 7.5 beside an outside verdict', () => {
    expect(readBack('ph', 7.6)).toBe('7.6');
    expect(readBack('ph', 7.5)).toBe('7.5');
  });
});
