import { describe, expect, it } from 'vitest';
import { captureSize, deviceTextureLimit, MAX_CAPTURE_EDGE, MAX_CAPTURE_PIXELS } from './capture';

describe('captureSize', () => {
  it('doubles a laptop-sized canvas by default', () => {
    expect(captureSize(1280, 720, 2)).toEqual({ pixelRatio: 2, width: 2560, height: 1440 });
  });

  it('takes a smaller scale as asked', () => {
    expect(captureSize(1280, 720, 1)).toEqual({ pixelRatio: 1, width: 1280, height: 720 });
  });

  it('shrinks a 4K canvas to the pixel budget and keeps its aspect', () => {
    const size = captureSize(3840, 2160, 2);
    expect(size.pixelRatio).toBeLessThan(2);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_CAPTURE_PIXELS);
    expect(size.width / size.height).toBeCloseTo(3840 / 2160, 2);
  });

  it('keeps each side within the device limit', () => {
    const size = captureSize(2560, 600, 2, 4096);
    expect(size.pixelRatio).toBeCloseTo(1.6, 10);
    expect(size.width).toBe(4096);
    expect(captureSize(5000, 400, 2, 16384).width).toBeLessThanOrEqual(MAX_CAPTURE_EDGE);
  });

  it('refuses an empty canvas, a scale out of range and a missing limit', () => {
    expect(() => captureSize(0, 720, 2)).toThrow(/no area/);
    expect(() => captureSize(1280, Number.NaN, 2)).toThrow(/no area/);
    expect(() => captureSize(1280, 720, 0)).toThrow(/scale/);
    expect(() => captureSize(1280, 720, 2.5)).toThrow(/scale/);
    expect(() => captureSize(1280, 720, Number.NaN)).toThrow(/scale/);
    expect(() => captureSize(1280, 720, 2, 0)).toThrow(/maxEdge/);
  });
});

describe('deviceTextureLimit', () => {
  it('reads the WebGPU device limit', () => {
    expect(deviceTextureLimit({ device: { limits: { maxTextureDimension2D: 4096 } } })).toBe(4096);
  });

  it('falls back to the capture cap when the backend tells nothing usable', () => {
    expect(deviceTextureLimit(null)).toBe(MAX_CAPTURE_EDGE);
    expect(deviceTextureLimit({})).toBe(MAX_CAPTURE_EDGE);
    expect(deviceTextureLimit({ device: null })).toBe(MAX_CAPTURE_EDGE);
    expect(deviceTextureLimit({ device: { limits: { maxTextureDimension2D: 0 } } })).toBe(
      MAX_CAPTURE_EDGE,
    );
    expect(deviceTextureLimit({ gl: {} })).toBe(MAX_CAPTURE_EDGE);
  });
});
