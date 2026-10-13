import sharp from 'sharp';
import type { Rgba } from './textures.ts';

export type Rgb = [number, number, number];

/** Three stops (shadow, mid, highlight) in sRGB 0-255 that a normalised luminance is mapped onto. */
export interface Ramp {
  dark: Rgb;
  mid: Rgb;
  light: Rgb;
}

export interface TintSpec {
  ramps: [Ramp, Ramp];
  /** Size in pixels of the patches that switch between the two ramps. */
  mottleCells: number;
  seed: number;
  /** Pixels darker than this luminance (0..1) are left out of the contrast stretch, e.g. empty atlas gaps. */
  ignoreBelow?: number;
}

export interface PoreSpec {
  /** Average pore spacing in pixels at the 2048 px working size. */
  cell: number;
  /** Strength of the normal perturbation, in slope per unit of height. */
  strength: number;
  /** How much the base colour darkens inside the deepest pores, 0..1. */
  darken: number;
  seed: number;
}

export async function upscaleTo(image: Rgba, size: number): Promise<Rgba> {
  if (image.width === size && image.height === size) return image;
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Tileable value noise in 0..1 with `cells` lattice cells across the image. */
function valueNoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const at = (i: number, j: number): number => hash2(i % cells, j % cells, seed);
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function ramp(r: Ramp, t: number): Rgb {
  const lerp = (a: Rgb, b: Rgb, k: number): Rgb => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
  return t < 0.5 ? lerp(r.dark, r.mid, t * 2) : lerp(r.mid, r.light, (t - 0.5) * 2);
}

/** Recolours by luminance so the source's shading and cavities survive while the hue is replaced. */
export function tintImage(image: Rgba, spec: TintSpec): Rgba {
  const { width, height, data } = image;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++)
    lum[i] = (0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!) / 255;
  const sorted = Float32Array.from(lum.filter((l) => l >= (spec.ignoreBelow ?? 0))).sort();
  if (sorted.length === 0) throw new Error('tintImage: every pixel is below ignoreBelow');
  const low = sorted[Math.floor(sorted.length * 0.02)]!;
  const high = sorted[Math.floor(sorted.length * 0.98)]!;
  const span = Math.max(1e-3, high - low);
  const cells = Math.max(2, Math.round(Math.max(width, height) / spec.mottleCells));
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const t = Math.min(1, Math.max(0, (lum[i]! - low) / span));
      const m = smooth(valueNoise(x / width, y / height, cells, spec.seed));
      const a = ramp(spec.ramps[0], t);
      const b = ramp(spec.ramps[1], t);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(a[c]! * (1 - m) + b[c]! * m);
      out[i * 4 + 3] = data[i * 4 + 3]!;
    }
  return { width, height, data: out };
}

/** Pore depth in 0..1 (1 = deepest) from jittered-cell distance, broken up by low-frequency noise. */
function poreDepth(size: number, spec: PoreSpec): Float32Array {
  const grid = Math.max(2, Math.round(size / spec.cell));
  const step = size / grid;
  const depth = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / step);
      const cy = Math.floor(y / step);
      let nearest = Infinity;
      let radius = 1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          const wx = ((gx % grid) + grid) % grid;
          const wy = ((gy % grid) + grid) % grid;
          const px = (gx + 0.15 + 0.7 * hash2(wx, wy, spec.seed)) * step;
          const py = (gy + 0.15 + 0.7 * hash2(wx, wy, spec.seed + 1)) * step;
          const d = Math.hypot(x - px, y - py);
          if (d < nearest) {
            nearest = d;
            radius = step * (0.14 + 0.3 * hash2(wx, wy, spec.seed + 2));
          }
        }
      const bowl = nearest < radius ? smooth(1 - nearest / radius) : 0;
      const presence = smooth(valueNoise(x / size, y / size, 6, spec.seed + 3));
      const grain = valueNoise(x / size, y / size, Math.round(size / 6), spec.seed + 4);
      depth[y * size + x] = Math.min(1, bowl * (0.35 + 0.65 * presence) + 0.12 * grain);
    }
  return depth;
}

/**
 * Adds pores to a square tangent-space (OpenGL, +Y up) normal map and darkens the colour map inside
 * them. Both inputs must share the same square size.
 */
export function addPores(
  baseColor: Rgba,
  normal: Rgba,
  spec: PoreSpec,
): { baseColor: Rgba; normal: Rgba } {
  const size = baseColor.width;
  if (baseColor.height !== size || normal.width !== size || normal.height !== size)
    throw new Error('addPores needs square colour and normal maps of equal size');
  const depth = poreDepth(size, spec);
  const colour = new Uint8Array(baseColor.data);
  const nrm = new Uint8Array(normal.data);
  const at = (x: number, y: number): number =>
    depth[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))]!;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dHdU = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const dHdRow = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      let nx = (nrm[i * 4]! / 255) * 2 - 1;
      let ny = (nrm[i * 4 + 1]! / 255) * 2 - 1;
      let nz = (nrm[i * 4 + 2]! / 255) * 2 - 1;
      nx += spec.strength * dHdU;
      ny -= spec.strength * dHdRow;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      nrm[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      nrm[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nrm[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      const shade = 1 - spec.darken * depth[i]!;
      for (let c = 0; c < 3; c++) colour[i * 4 + c] = Math.round(colour[i * 4 + c]! * shade);
    }
  return {
    baseColor: { width: size, height: size, data: colour },
    normal: { width: size, height: size, data: nrm },
  };
}

/** Packs a glTF-style ARM map: occlusion in R, roughness in G, metalness (zero) in B. */
export function packArm(occlusion: Rgba, roughness: Rgba): Rgba {
  if (occlusion.width !== roughness.width || occlusion.height !== roughness.height)
    throw new Error(
      `occlusion is ${occlusion.width}x${occlusion.height} but roughness is ${roughness.width}x${roughness.height}`,
    );
  const data = new Uint8Array(occlusion.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = occlusion.data[i]!;
    data[i + 1] = roughness.data[i]!;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  return { width: occlusion.width, height: occlusion.height, data };
}
