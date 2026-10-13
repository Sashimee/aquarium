import { describe, expect, it } from 'vitest';
import {
  clampPixels,
  decodeRgbe,
  encodeRgbe,
  flipVertical,
  halve,
  type RgbeImage,
} from './rgbe.ts';

function gradient(width: number, height: number): RgbeImage {
  const pixels = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = (x + 1) / width;
      pixels[i + 1] = (y + 1) / height;
      pixels[i + 2] = x < width / 2 ? 0.25 : 40;
    }
  return { width, height, pixels };
}

describe('rgbe', () => {
  it('round-trips within the shared-exponent precision', () => {
    const source = gradient(64, 8);
    const decoded = decodeRgbe(encodeRgbe(source));
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(8);
    for (let i = 0; i < source.pixels.length; i += 3) {
      const peak = Math.max(source.pixels[i]!, source.pixels[i + 1]!, source.pixels[i + 2]!);
      for (let c = 0; c < 3; c++)
        expect(Math.abs(decoded.pixels[i + c]! - source.pixels[i + c]!)).toBeLessThanOrEqual(
          peak / 128,
        );
    }
  });

  it('is deterministic and compresses flat runs', () => {
    const flat: RgbeImage = {
      width: 64,
      height: 4,
      pixels: new Float32Array(64 * 4 * 3).fill(0.5),
    };
    const a = encodeRgbe(flat);
    expect(encodeRgbe(flat)).toEqual(a);
    expect(a.byteLength).toBeLessThan(64 * 4 * 4);
  });

  it('halves by averaging 2x2 blocks', () => {
    const image: RgbeImage = {
      width: 2,
      height: 2,
      pixels: Float32Array.from([1, 0, 0, 3, 0, 0, 5, 0, 0, 7, 0, 0]),
    };
    const half = halve(image);
    expect([half.width, half.height]).toEqual([1, 1]);
    expect(half.pixels[0]).toBe(4);
  });

  it('flips rows top to bottom and back', () => {
    const image = gradient(8, 3);
    const flipped = flipVertical(image);
    expect(flipped.pixels.subarray(0, 24)).toEqual(image.pixels.subarray(48, 72));
    expect(flipped.pixels.subarray(24, 48)).toEqual(image.pixels.subarray(24, 48));
    expect(flipVertical(flipped).pixels).toEqual(image.pixels);
  });

  it('clamps channels above the limit and counts the pixels it changed', () => {
    const image: RgbeImage = {
      width: 2,
      height: 1,
      pixels: Float32Array.from([1, 2, 3, 70000, 5, 80000]),
    };
    const { image: out, clamped } = clampPixels(image, 65504);
    expect(clamped).toBe(1);
    expect([...out.pixels]).toEqual([1, 2, 3, 65504, 5, 65504]);
    expect(clampPixels(out, 65504).clamped).toBe(0);
  });

  it('rejects input that is not Radiance', () => {
    expect(() => decodeRgbe(new TextEncoder().encode('P6\n1 1\n255\n'))).toThrow('#?');
  });

  it('rejects a truncated file', () => {
    const bytes = encodeRgbe(gradient(64, 4));
    expect(() => decodeRgbe(bytes.subarray(0, bytes.length - 20))).toThrow();
  });
});
