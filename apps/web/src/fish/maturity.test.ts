import { describe, expect, it } from 'vitest';
import { ageDaysAt, lengthByStageM, maturityOf, youthOf, type SpeciesGrowth } from './maturity';
import { speciesGrowth } from './species';

const GUPPY = { juvenileAfterDays: 21, adultAfterDays: 90 };
const JUVENILE_FROM = 21 / 90;
const GROWTH: SpeciesGrowth = { birthSizeM: 0.008, fryGrowth: GUPPY };

describe('maturityOf', () => {
  it('starts a newborn fry at 0', () => {
    expect(maturityOf('fry', 0, GUPPY)).toBe(0);
  });

  it('places a young fish along its growth by age', () => {
    expect(maturityOf('fry', 9, GUPPY)).toBeCloseTo(0.1);
    expect(maturityOf('juvenile', 45, GUPPY)).toBeCloseTo(0.5);
  });

  it('keeps a fish inside the band of the stage the server gave it', () => {
    expect(maturityOf('fry', 60, GUPPY)).toBeCloseTo(JUVENILE_FROM);
    expect(maturityOf('juvenile', 2, GUPPY)).toBeCloseTo(JUVENILE_FROM);
    expect(maturityOf('fry', -3, GUPPY)).toBe(0);
  });

  it('is grown at the adult boundary, whether or not the server has promoted it yet', () => {
    expect(maturityOf('juvenile', 90, GUPPY)).toBe(1);
    expect(maturityOf('juvenile', 400, GUPPY)).toBe(1);
    expect(maturityOf('juvenile', 89.9, GUPPY)).toBeLessThan(1);
    expect(maturityOf('adult', 0, GUPPY)).toBe(1);
  });

  it('puts a fish of unknown age at the start of its stage', () => {
    expect(maturityOf('fry', Number.NaN, GUPPY)).toBe(0);
    expect(maturityOf('juvenile', Number.NaN, GUPPY)).toBeCloseTo(JUVENILE_FROM);
    expect(maturityOf('juvenile', Number.POSITIVE_INFINITY, GUPPY)).toBeCloseTo(JUVENILE_FROM);
    expect(maturityOf('adult', Number.NaN, GUPPY)).toBe(1);
  });

  it('falls back to the stage alone for a species without fry growth', () => {
    expect(maturityOf('fry', 10, undefined)).toBe(0);
    expect(maturityOf('juvenile', 10, undefined)).toBe(0.5);
    expect(maturityOf('adult', 10, undefined)).toBe(1);
  });

  it('treats a demo fish, which has no stage, as grown', () => {
    expect(maturityOf(null, Number.NaN, GUPPY)).toBe(1);
  });
});

describe('ageDaysAt', () => {
  it('counts days since birth, and gives NaN for a birth time that did not parse', () => {
    const born = Date.parse('2026-10-01T00:00:00.000Z');
    expect(ageDaysAt(born, born + 36 * 3_600_000)).toBe(1.5);
    expect(ageDaysAt(Date.parse('not a date'), born)).toBeNaN();
  });
});

describe('youthOf', () => {
  it('runs from 1 for a newborn to 0 for an adult', () => {
    expect(youthOf(0)).toBe(1);
    expect(youthOf(1)).toBe(0);
    expect(youthOf(0.5)).toBeCloseTo(0.5);
  });

  it('keeps a young fish mostly pale and brings the colour in towards adulthood', () => {
    expect(youthOf(JUVENILE_FROM)).toBeGreaterThan(0.8);
    expect(youthOf(0.9)).toBeLessThan(0.05);
    for (let m = 0; m < 1; m += 0.05) expect(youthOf(m + 0.05)).toBeLessThan(youthOf(m));
  });

  it('clamps out-of-range input and shows a NaN maturity as the adult livery', () => {
    expect(youthOf(-1)).toBe(1);
    expect(youthOf(2)).toBe(0);
    expect(youthOf(Number.NaN)).toBe(0);
  });
});

describe('lengthByStageM', () => {
  it("draws a fish at the server's size whatever its stage", () => {
    expect(lengthByStageM(0.008, 'fry', GROWTH, 0.027)).toBe(0.008);
    expect(lengthByStageM(0.031, 'adult', GROWTH, 0.027)).toBe(0.031);
  });

  it('puts a young fish without a usable size between its birth size and the adult length', () => {
    for (const size of [undefined, Number.NaN, 0, -0.01, Number.POSITIVE_INFINITY]) {
      expect(lengthByStageM(size, 'fry', GROWTH, 0.027)).toBe(0.008);
      expect(lengthByStageM(size, 'adult', GROWTH, 0.027)).toBe(0.027);
      expect(lengthByStageM(size, null, GROWTH, 0.027)).toBe(0.027);
    }
    expect(lengthByStageM(undefined, 'juvenile', GROWTH, 0.027)).toBeCloseTo(
      0.008 + 0.019 * JUVENILE_FROM,
    );
  });

  it('never draws a newborn longer than the adult', () => {
    const big: SpeciesGrowth = { birthSizeM: 0.05, fryGrowth: GUPPY };
    expect(lengthByStageM(undefined, 'fry', big, 0.027)).toBe(0.027);
  });

  it('uses the adult length for a species this build has no content for', () => {
    expect(lengthByStageM(undefined, 'fry', undefined, 0.2)).toBe(0.2);
  });
});

describe('speciesGrowth', () => {
  it("reads a breeding species' birth size and fry growth from its content", () => {
    expect(speciesGrowth('guppy')).toEqual({ birthSizeM: 0.008, fryGrowth: GUPPY });
  });

  it('has no fry growth for a species that does not breed', () => {
    expect(speciesGrowth('neon-tetra')?.fryGrowth).toBeUndefined();
    expect(speciesGrowth('mystery-fish')).toBeUndefined();
  });
});
