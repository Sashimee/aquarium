import { describe, expect, it } from 'vitest';
import {
  appendFinAtlas,
  finTexel,
  paintFinTile,
  type FinPaint,
  type FinPalette,
} from './fin-paint.ts';
import { FIN_IDS } from './index-schema.ts';
import { retouchPhoto } from './retouch.ts';
import type { Rgba } from './textures.ts';

const paint: FinPaint = {
  root: [200, 60, 40],
  tip: [100, 20, 20],
  rim: [20, 0, 0],
  rimStart: 0.7,
  rays: 8,
  rayDepth: 0.5,
  opacity: { root: 0.9, tip: 0.4 },
};

const palette: FinPalette = {
  caudal: { ...paint, root: [250, 0, 0] },
  dorsal: { ...paint, root: [0, 250, 0] },
  anal: { ...paint, root: [0, 0, 250] },
  pectoral: { ...paint, root: [250, 250, 0] },
  pelvic: { ...paint, root: [0, 250, 250] },
};

function solid(width: number, height: number, rgb: [number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

describe('finTexel', () => {
  it('lets the membrane between rays be more transparent than the rays', () => {
    const onRay = finTexel(paint, 0.5 / paint.rays + 1 / paint.rays, 0.3)[3];
    const between = finTexel(paint, 1 / paint.rays, 0.3)[3];
    expect(Math.min(onRay, between)).toBeLessThan(Math.max(onRay, between) - 0.05);
  });

  it('fades the tip and the side edges towards transparent', () => {
    expect(finTexel(paint, 0.5, 1)[3]).toBeLessThan(finTexel(paint, 0.5, 0.5)[3]);
    expect(finTexel(paint, 0, 0.3)[3]).toBeLessThan(0.05);
    expect(finTexel(paint, 1, 0.3)[3]).toBeLessThan(0.05);
  });

  it('takes the rim colour at the tip and the root colour at the base', () => {
    const [rr, gr] = finTexel({ ...paint, rayDepth: 0 }, 0.5, 0);
    expect(rr).toBeCloseTo(200, 0);
    expect(gr).toBeCloseTo(60, 0);
    expect(finTexel({ ...paint, rayDepth: 0 }, 0.5, 1)[0]).toBeLessThan(40);
  });

  it('keeps a solid leading ray on a spine fin', () => {
    const spine = { ...paint, opacity: { root: 0.1, tip: 0.1 }, leadingRay: 0.3 };
    expect(finTexel(spine, 0.12, 0.5)[3]).toBeGreaterThan(0.8);
    expect(finTexel(spine, 0.8, 0.5)[3]).toBeLessThan(0.5);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    expect(finTexel({ ...paint, seed: 3 }, 0.37, 0.4)).toEqual(
      finTexel({ ...paint, seed: 3 }, 0.37, 0.4),
    );
    const a = Array.from({ length: 30 }, (_, i) => finTexel({ ...paint, seed: 1 }, i / 30, 0.4)[3]);
    const b = Array.from({ length: 30 }, (_, i) => finTexel({ ...paint, seed: 2 }, i / 30, 0.4)[3]);
    expect(a).not.toEqual(b);
  });

  it('keeps channels in range', () => {
    for (let i = 0; i <= 20; i++)
      for (let j = 0; j <= 20; j++) {
        const [r, g, b, a] = finTexel(paint, i / 20, j / 20);
        for (const value of [r, g, b]) expect(value).toBeGreaterThanOrEqual(0);
        for (const value of [r, g, b]) expect(value).toBeLessThanOrEqual(255);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
  });
});

describe('paintFinTile', () => {
  it('fills a size x size RGBA tile', () => {
    const tile = paintFinTile(paint, 32);
    expect(tile).toHaveLength(32 * 32 * 4);
    expect(tile.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
  });
});

describe('appendFinAtlas', () => {
  const photo = solid(100, 40, [10, 20, 30]);

  it('keeps the photo rows and appends opaque-where-painted tiles below them', () => {
    const { image, bodyVMax } = appendFinAtlas(photo, palette);
    expect(image.height).toBe(40 + 20);
    expect(Array.from(image.data.subarray(0, photo.data.length))).toEqual(Array.from(photo.data));
    expect(bodyVMax).toBeLessThan(40 / image.height);
    const strip = image.data.subarray(40 * 100 * 4);
    expect(strip.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
  });

  it('maps each fin id to its own tile and base-to-tip down the tile', () => {
    const { image, finTexture } = appendFinAtlas(photo, palette);
    const seen = new Set<number>();
    for (const id of Object.values(FIN_IDS)) {
      const [u, v] = finTexture(id, 0.5, 0.5, 0);
      expect(v).toBeGreaterThan(40 / image.height);
      expect(v).toBeLessThan(1);
      seen.add(Math.floor(u * 5));
    }
    expect(seen.size).toBe(5);
    const [, base] = finTexture(FIN_IDS.caudal, 0.5, 0, 0);
    const [, tip] = finTexture(FIN_IDS.caudal, 0.5, 1, 0);
    expect(tip).toBeGreaterThan(base);
  });

  it('adds a spine tile for variant 1 only when the palette has one', () => {
    const withSpine = appendFinAtlas(photo, { ...palette, spine: { ...paint, root: [1, 2, 3] } });
    const [u] = withSpine.finTexture(FIN_IDS.dorsal, 0.5, 0.5, 1);
    expect(Math.floor(u * 6)).toBe(5);
    expect(() => appendFinAtlas(photo, palette).finTexture(FIN_IDS.dorsal, 0.5, 0.5, 1)).toThrow(
      /no atlas tile/,
    );
  });

  it('rejects a photo too narrow for the tiles', () => {
    expect(() => appendFinAtlas(solid(40, 20, [0, 0, 0]), palette)).toThrow(/under 16px/);
  });
});

describe('retouchPhoto', () => {
  it('washes a disc towards the colour and leaves the rest alone', () => {
    const image = solid(60, 60, [0, 0, 0]);
    retouchPhoto(image, { left: 100, top: 200 }, [
      { kind: 'wash', centre: [130, 230], radius: 10, colour: [200, 200, 200], strength: 1 },
    ]);
    expect(image.data[(30 * 60 + 30) * 4]).toBe(200);
    expect(image.data[(5 * 60 + 5) * 4]).toBe(0);
    expect(image.data[(30 * 60 + 30) * 4 + 3]).toBe(255);
  });

  it('draws an eye with a dark pupil, a coloured ring and a highlight', () => {
    const image = solid(80, 80, [240, 240, 240]);
    retouchPhoto(image, { left: 0, top: 0 }, [
      { kind: 'eye', centre: [40, 40], radius: 20, iris: [120, 80, 20], rim: [210, 170, 80] },
    ]);
    const at = (x: number, y: number): number[] =>
      Array.from(image.data.subarray((y * 80 + x) * 4, (y * 80 + x) * 4 + 3));
    expect(at(42, 42)[0]).toBeLessThan(30);
    expect(at(40 + 12, 40)).toEqual([120, 80, 20]);
    expect(at(40 + 17, 40)).toEqual([210, 170, 80]);
    expect(at(34, 34)[0]).toBeGreaterThan(200);
    expect(at(2, 2)).toEqual([240, 240, 240]);
  });

  it('ignores operations that fall off the image', () => {
    const image = solid(10, 10, [5, 5, 5]);
    expect(() =>
      retouchPhoto(image, { left: 0, top: 0 }, [
        { kind: 'wash', centre: [-50, -50], radius: 8, colour: [255, 255, 255], strength: 1 },
      ]),
    ).not.toThrow();
    expect(image.data[0]).toBe(5);
  });
});
