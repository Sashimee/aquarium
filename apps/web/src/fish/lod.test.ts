import { describe, expect, it } from 'vitest';
import { effectiveDistance, REFERENCE_LENGTH_M, selectLod } from './lod';

const thresholds = { midDistance: 1, impostorDistance: 2 };
const L = REFERENCE_LENGTH_M;

describe('selectLod', () => {
  it('picks the level from the distance for a reference-length fish', () => {
    expect(selectLod(0.5, L, thresholds, 0)).toBe(0);
    expect(selectLod(1.5, L, thresholds, 1)).toBe(1);
    expect(selectLod(3, L, thresholds, 2)).toBe(2);
  });

  it('jumps straight to the right level from far away', () => {
    expect(selectLod(3, L, thresholds, 0)).toBe(2);
    expect(selectLod(0.2, L, thresholds, 2)).toBe(0);
  });

  it('holds the current level inside the hysteresis band', () => {
    expect(selectLod(1.05, L, thresholds, 0)).toBe(0);
    expect(selectLod(1.05, L, thresholds, 1)).toBe(1);
    expect(selectLod(0.95, L, thresholds, 1)).toBe(1);
    expect(selectLod(0.95, L, thresholds, 0)).toBe(0);
    expect(selectLod(1.1, L, thresholds, 0)).toBe(1);
    expect(selectLod(0.9, L, thresholds, 1)).toBe(0);
  });

  it('keeps bigger fish detailed for longer', () => {
    expect(selectLod(1.5, L, thresholds, 0)).toBe(1);
    expect(selectLod(1.5, 2 * L, thresholds, 0)).toBe(0);
  });

  it('never asks for a level the model does not have', () => {
    expect(selectLod(10, L, thresholds, 0, 2)).toBe(1);
    expect(selectLod(10, L, thresholds, 0, 1)).toBe(0);
    expect(() => selectLod(1, L, thresholds, 0, 0)).toThrow(RangeError);
  });

  it('rejects a non-positive length', () => {
    expect(() => effectiveDistance(1, 0)).toThrow(RangeError);
    expect(() => selectLod(1, -1, thresholds, 0)).toThrow(RangeError);
  });
});
