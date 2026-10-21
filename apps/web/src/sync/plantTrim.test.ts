import type { Plant } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../ui/api';
import {
  clampTrimSize,
  describePlantSize,
  plantLabel,
  samePlants,
  trimmablePlants,
  trimRange,
  trimRefusalText,
} from './plantTrim';

const plant = (over: Partial<Plant> = {}): Plant => ({
  key: 's1',
  assetId: 'plant-java-fern',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1.6,
  minSize: 0.4,
  maxSize: 2.4,
  ...over,
});

describe('trimRange', () => {
  it('runs from the species minimum to just under today, suggesting the middle', () => {
    expect(trimRange(plant())).toEqual({ min: 0.4, max: 1.59, step: 0.01, suggested: 1 });
  });

  it('rounds the minimum up and the top down so the server accepts every value', () => {
    const range = trimRange(plant({ size: 1.234, minSize: 0.333 }));
    expect(range?.min).toBe(0.34);
    expect(range?.max).toBe(1.23);
  });

  it('is exact for sizes that float arithmetic gets wrong', () => {
    expect(trimRange(plant({ size: 0.3, minSize: 0.1 }))?.max).toBe(0.29);
    expect(trimRange(plant({ size: 1.1, minSize: 0.3 }))).toMatchObject({ min: 0.3, max: 1.09 });
  });

  it('is null for a plant already at its minimum', () => {
    expect(trimRange(plant({ size: 0.4 }))).toBeNull();
  });

  it('allows a single size one step above the minimum', () => {
    expect(trimRange(plant({ size: 0.41 }))).toMatchObject({ min: 0.4, max: 0.4 });
    expect(trimRange(plant({ size: 0.405 }))).toMatchObject({ min: 0.4, max: 0.4 });
  });
});

describe('clampTrimSize', () => {
  const range = { min: 0.4, max: 1.59, step: 0.01, suggested: 1 };
  it('keeps the choice inside the range and on a hundredth', () => {
    expect(clampTrimSize(range, 0.1)).toBe(0.4);
    expect(clampTrimSize(range, 5)).toBe(1.59);
    expect(clampTrimSize(range, 0.7000001)).toBe(0.7);
  });
});

describe('trimmablePlants', () => {
  it('lists the plants that can be cut and tolerates a tank without growth state', () => {
    expect(trimmablePlants(null)).toEqual([]);
    expect(trimmablePlants({})).toEqual([]);
    const small = plant({ key: 's2', size: 0.4 });
    expect(trimmablePlants({ plants: [plant(), small] })).toEqual([plant()]);
  });
});

describe('text', () => {
  it('names a plant from its asset id', () => {
    expect(plantLabel('plant-java-fern')).toBe('java fern');
    expect(plantLabel('plant')).toBe('plant');
  });

  it('puts the size against the limits', () => {
    expect(describePlantSize(plant())).toBe('160% of its bought size (smallest 40%, largest 240%)');
  });
});

describe('samePlants', () => {
  it('compares by content', () => {
    expect(samePlants([plant()], [plant()])).toBe(true);
    expect(samePlants(undefined, undefined)).toBe(true);
    expect(samePlants([plant()], undefined)).toBe(false);
    expect(samePlants([plant()], [plant({ size: 1.7 })])).toBe(false);
    expect(samePlants([plant()], [plant(), plant({ key: 's2' })])).toBe(false);
    expect(samePlants([plant({ position: [0, 1] })], [plant({ position: [0, 2] })])).toBe(false);
  });
});

describe('trimRefusalText', () => {
  const refusal = (
    status: number,
    code: ApiRequestError['code'],
    reason?: ApiRequestError['reason'],
    retry?: number,
  ) => new ApiRequestError(status, code, 'server words', {}, retry ?? null, reason ?? null);

  it('answers each code the endpoint can return', () => {
    expect(trimRefusalText(refusal(400, 'validation_failed'), 'fern')).toMatch(/cut back that far/);
    expect(trimRefusalText(refusal(404, 'not_found'), 'fern')).toMatch(/no longer in this tank/);
    expect(trimRefusalText(refusal(409, 'conflict', 'plant_not_grown'), 'fern')).toMatch(
      /not grown past that size/,
    );
    expect(trimRefusalText(refusal(409, 'conflict', 'key_reused'), 'fern')).toMatch(/clashed/);
    expect(trimRefusalText(refusal(409, 'conflict'), 'fern')).toBe('server words');
  });

  it('says how long to wait when the server does', () => {
    expect(trimRefusalText(refusal(429, 'rate_limited', undefined, 12), 'fern')).toMatch(
      /Try again in 12 seconds/,
    );
    expect(trimRefusalText(refusal(429, 'rate_limited'), 'fern')).toMatch(/Wait a moment/);
  });

  it('leaves other failures to the generic handler', () => {
    expect(trimRefusalText(refusal(500, 'internal'), 'fern')).toBeNull();
    expect(trimRefusalText(new Error('x'), 'fern')).toBeNull();
  });
});
