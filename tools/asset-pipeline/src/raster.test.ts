import { describe, expect, it } from 'vitest';
import { rasterise } from './raster.ts';

describe('rasterise texture sampling', () => {
  it('samples v downwards from the top row, as glTF does', () => {
    const texture = {
      data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      width: 1,
      height: 2,
      channels: 4,
    };
    const quad = (v: number) => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      uvs: new Float32Array([0, v, 1, v, 1, v, 0, v]),
    });
    const frame = {
      min: [0, 0, 0] as [number, number, number],
      max: [1, 1, 0] as [number, number, number],
    };
    const centre = (v: number): number[] => {
      const { rgb, width, height } = rasterise(quad(v), 'front', 40, frame, texture);
      const o = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 3;
      return [rgb[o]!, rgb[o + 1]!, rgb[o + 2]!];
    };
    const top = centre(0.25);
    const bottom = centre(0.75);
    expect(top[0]).toBeGreaterThan(top[2]!);
    expect(bottom[2]).toBeGreaterThan(bottom[0]!);
  });
});
