import { FIN_IDS, type FinName } from './index-schema.ts';
import type { FinTexture } from './loft.ts';
import type { Rgba } from './textures.ts';

export type Rgb = [number, number, number];

/** How one fin type is painted on its atlas tile: u runs along the fin base, v from the base (0) to the tip (1). */
export interface FinPaint {
  root: Rgb;
  tip: Rgb;
  /** Colour of the outer rim, blended in from `rimStart` to the tip. */
  rim?: Rgb;
  rimStart?: number;
  rays: number;
  /** 0..1, how far the rays darken the membrane colour. */
  rayDepth: number;
  /** Membrane opacity at the root and at the tip; the rays stay more opaque than the membrane between them. */
  opacity: { root: number; tip: number };
  /** Width of a solid leading ray as a fraction of the fin base; for spine fins. */
  leadingRay?: number;
  /** Take the root colour from the photographed body at the end of the peduncle, so the fin continues the skin. */
  rootFromPhoto?: boolean;
  /** Crosswise colour bands from `from` to `to` along the fin, base 0 to tip 1, such as a rummy-nose's barred caudal. */
  bands?: { from: number; to: number; colour: Rgb; opacity: number }[];
  seed?: number;
}

export type FinPalette = Record<FinName, FinPaint> & { spine?: FinPaint };

export const FIN_TILE_ORDER: FinName[] = ['caudal', 'dorsal', 'anal', 'pectoral', 'pelvic'];

const RAY_OPACITY = 0.55;
const RAY_SHADE = 0.5;
const TIP_FADE_START = 0.9;
const TIP_FADE_STRENGTH = 0.7;
const SIDE_FADE = 0.1;
const BAND_EDGE = 0.02;

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function hash(n: number, seed: number): number {
  const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Colour and opacity of a fin membrane at (u, v); exported for tests. */
export function finTexel(paint: FinPaint, u: number, v: number): [number, number, number, number] {
  const seed = paint.seed ?? 0;
  const phase = u * paint.rays;
  const nearest = Math.floor(phase + 0.5);
  const centre = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
  const strength = 0.55 + 0.45 * hash(nearest, seed);
  const ray = centre ** 4 * strength;

  let colour = mix(paint.root, paint.tip, smooth(0, 1, v));
  if (paint.rim) {
    const start = paint.rimStart ?? 0.82;
    colour = mix(colour, paint.rim, smooth(start, Math.min(1, start + 0.18), v));
  }
  colour = mix(
    colour,
    [colour[0] * RAY_SHADE, colour[1] * RAY_SHADE, colour[2] * RAY_SHADE],
    ray * paint.rayDepth,
  );

  const membrane = paint.opacity.root + (paint.opacity.tip - paint.opacity.root) * smooth(0, 1, v);
  let alpha = membrane + (1 - membrane) * ray * RAY_OPACITY;
  for (const band of paint.bands ?? []) {
    const inside =
      smooth(band.from - BAND_EDGE, band.from + BAND_EDGE, v) *
      (1 - smooth(band.to - BAND_EDGE, band.to + BAND_EDGE, v));
    colour = mix(colour, band.colour, inside);
    alpha += (band.opacity - alpha) * inside;
  }
  alpha *= 1 - smooth(TIP_FADE_START, 1, v) * TIP_FADE_STRENGTH;
  alpha *= smooth(0, SIDE_FADE, u) * smooth(0, SIDE_FADE, 1 - u);

  if (paint.leadingRay) {
    const lead = 1 - smooth(paint.leadingRay * 0.4, paint.leadingRay, u);
    alpha = Math.max(alpha, lead * (1 - smooth(0.9, 1, v) * 0.7));
    colour = mix(
      colour,
      [colour[0] * RAY_SHADE, colour[1] * RAY_SHADE, colour[2] * RAY_SHADE],
      lead * 0.6,
    );
  }
  return [colour[0], colour[1], colour[2], Math.min(1, Math.max(0, alpha))];
}

export function paintFinTile(paint: FinPaint, size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = finTexel(paint, (x + 0.5) / size, (y + 0.5) / size);
      const o = (y * size + x) * 4;
      data[o] = Math.round(Math.min(255, Math.max(0, r)));
      data[o + 1] = Math.round(Math.min(255, Math.max(0, g)));
      data[o + 2] = Math.round(Math.min(255, Math.max(0, b)));
      data[o + 3] = Math.round(a * 255);
    }
  return data;
}

/**
 * Appends one square tile per fin type under the photo. Tiles are side by side, so a tile is a fifth
 * of the photo width; body coordinates stay above the strip through `bodyVMax`.
 */
export function appendFinAtlas(
  photo: Rgba,
  palette: FinPalette,
): { image: Rgba; finTexture: FinTexture; bodyVMax: number } {
  const paints: FinPaint[] = FIN_TILE_ORDER.map((fin) => palette[fin]);
  if (palette.spine) paints.push(palette.spine);
  const tiles = paints.length;
  const size = Math.floor(photo.width / tiles);
  if (size < 16) throw new Error(`photo is ${photo.width}px wide; fin tiles would be under 16px`);
  const height = photo.height + size;
  const data = new Uint8Array(photo.width * height * 4);
  data.set(photo.data);
  paints.forEach((paint, index) => {
    const tile = paintFinTile(paint, size);
    for (let y = 0; y < size; y++)
      data.set(
        tile.subarray(y * size * 4, (y + 1) * size * 4),
        ((photo.height + y) * photo.width + index * size) * 4,
      );
  });
  const finTexture: FinTexture = (fin, u, v, variant) => {
    const name = (Object.keys(FIN_IDS) as FinName[]).find((key) => FIN_IDS[key] === fin);
    const index = variant === 1 ? FIN_TILE_ORDER.length : name ? FIN_TILE_ORDER.indexOf(name) : -1;
    if (index < 0 || index >= tiles)
      throw new Error(`fin id ${fin} variant ${variant} has no atlas tile`);
    const x = (index * size + 1 + u * (size - 2)) / photo.width;
    const y = (photo.height + 1 + v * (size - 2)) / height;
    return [x, y];
  };
  return {
    image: { width: photo.width, height, data },
    finTexture,
    bodyVMax: (photo.height - 1) / height,
  };
}
