import { describe, expect, it } from 'vitest';
import {
  clampFocusDistance,
  clampFStop,
  F_STOP_RANGE,
  FOCUS_DISTANCE_RANGE,
  lensBlur,
  REFERENCE_LINES,
  viewDepth,
} from './lens';

describe('lensBlur', () => {
  it('matches focus mode at f/2.8 focused 35 cm away', () => {
    const blur = lensBlur(0.35, 2.8, REFERENCE_LINES);
    expect(blur.focalRange).toBeCloseTo(0.12, 10);
    expect(blur.bokehScale).toBeCloseTo(2.5, 10);
  });

  it('deepens the zone in focus and shrinks the bokeh as the aperture closes', () => {
    const stops = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
    const blurs = stops.map((n) => lensBlur(0.5, n, REFERENCE_LINES));
    for (let i = 1; i < blurs.length; i++) {
      expect(blurs[i]?.focalRange).toBeGreaterThan(blurs[i - 1]?.focalRange ?? Infinity);
      expect(blurs[i]?.bokehScale).toBeLessThan(blurs[i - 1]?.bokehScale ?? -Infinity);
    }
  });

  it('deepens the zone in focus with the focus distance, as a thin lens does', () => {
    const near = lensBlur(0.2, 4, REFERENCE_LINES);
    const far = lensBlur(0.8, 4, REFERENCE_LINES);
    expect(far.focalRange / near.focalRange).toBeCloseTo(4, 10);
    expect(far.bokehScale).toBe(near.bokehScale);
  });

  it('scales the bokeh with the drawing buffer, so a 2x capture blurs like the preview', () => {
    const preview = lensBlur(0.4, 2.8, 900);
    const capture = lensBlur(0.4, 2.8, 1800);
    expect(capture.bokehScale).toBeCloseTo(2 * preview.bokehScale, 10);
    expect(capture.focalRange).toBe(preview.focalRange);
  });

  it('clamps the lens to its ranges', () => {
    expect(lensBlur(100, 100, REFERENCE_LINES)).toEqual(
      lensBlur(FOCUS_DISTANCE_RANGE.max, F_STOP_RANGE.max, REFERENCE_LINES),
    );
    expect(lensBlur(0, 0.5, REFERENCE_LINES)).toEqual(
      lensBlur(FOCUS_DISTANCE_RANGE.min, F_STOP_RANGE.min, REFERENCE_LINES),
    );
  });

  it('refuses a buffer without lines and values that are not numbers', () => {
    expect(() => lensBlur(0.4, 2.8, 0)).toThrow(RangeError);
    expect(() => lensBlur(0.4, 2.8, Number.NaN)).toThrow(RangeError);
    expect(() => lensBlur(Number.NaN, 2.8, REFERENCE_LINES)).toThrow(RangeError);
    expect(() => lensBlur(0.4, Number.POSITIVE_INFINITY, REFERENCE_LINES)).toThrow(RangeError);
  });
});

describe('lens clamps', () => {
  it('keeps values inside the range and pins those outside it to the nearest end', () => {
    expect(clampFocusDistance(1.5)).toBe(1.5);
    expect(clampFocusDistance(-1)).toBe(FOCUS_DISTANCE_RANGE.min);
    expect(clampFocusDistance(1e6)).toBe(FOCUS_DISTANCE_RANGE.max);
    expect(clampFStop(5.6)).toBe(5.6);
    expect(clampFStop(1)).toBe(F_STOP_RANGE.min);
    expect(clampFStop(64)).toBe(F_STOP_RANGE.max);
  });

  it('throws on NaN rather than focusing nowhere', () => {
    expect(() => clampFocusDistance(Number.NaN)).toThrow(/focus distance/);
    expect(() => clampFStop(Number.NaN)).toThrow(/f-stop/);
  });
});

describe('viewDepth', () => {
  it('measures along the view axis, not the ray', () => {
    const eye = { x: 0, y: 0.3, z: 1 };
    const forward = { x: 0, y: 0, z: -1 };
    expect(viewDepth({ x: 0, y: 0.3, z: 0.25 }, eye, forward)).toBeCloseTo(0.75, 10);
    expect(viewDepth({ x: 0.5, y: 0.1, z: 0.25 }, eye, forward)).toBeCloseTo(0.75, 10);
    expect(viewDepth({ x: 0, y: 0.3, z: 1.5 }, eye, forward)).toBeCloseTo(-0.5, 10);
  });
});
