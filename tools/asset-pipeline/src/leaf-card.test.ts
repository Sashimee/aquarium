import { describe, expect, it } from 'vitest';
import { flatCard, withOpacity } from './leaf-card.ts';
import type { Rgba } from './textures.ts';

function image(width: number, height: number, rgba: [number, number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

describe('withOpacity', () => {
  it('moves the opacity map into the alpha channel and keeps the colour', () => {
    const merged = withOpacity(image(2, 2, [200, 100, 50, 255]), image(2, 2, [64, 64, 64, 255]));
    expect(Array.from(merged.data.subarray(0, 4))).toEqual([200, 100, 50, 64]);
  });

  it('refuses maps of different sizes', () => {
    expect(() => withOpacity(image(2, 2, [0, 0, 0, 255]), image(4, 4, [0, 0, 0, 255]))).toThrow(
      /2x2 but opacity is 4x4/,
    );
  });
});

describe('flatCard', () => {
  const card = flatCard(0.3, 'leaf');

  it('lies flat on y = 0, centred, facing up', () => {
    for (let i = 0; i < card.positions.length; i += 3) {
      expect(card.positions[i + 1]).toBe(0);
      expect(Math.abs(card.positions[i] ?? 0)).toBeLessThanOrEqual(0.15 + 1e-6);
      expect(card.normals[i + 1]).toBe(1);
    }
  });

  it('winds every triangle counter-clockwise seen from above', () => {
    const at = (vertex: number, axis: number): number => card.positions[vertex * 3 + axis] ?? 0;
    for (let t = 0; t < card.indices.length; t += 3) {
      const a = card.indices[t] ?? 0;
      const b = card.indices[t + 1] ?? 0;
      const c = card.indices[t + 2] ?? 0;
      const cross =
        (at(b, 2) - at(a, 2)) * (at(c, 0) - at(a, 0)) -
        (at(b, 0) - at(a, 0)) * (at(c, 2) - at(a, 2));
      expect(cross).toBeGreaterThan(0);
    }
  });

  it('maps the whole atlas onto the card', () => {
    expect(Math.min(...card.uvs)).toBe(0);
    expect(Math.max(...card.uvs)).toBe(1);
  });
});
