import { bodyCentreOfMass } from './fins.ts';
import { FIN_ID_ATTRIBUTE, FIN_IDS, FIN_MASK_ATTRIBUTE, type FinName } from './index-schema.ts';
import { clamp } from './math.ts';
import type { Part } from './parts.ts';

/** One cross-section of the body along the spine; every length is a fraction of standard length, y is up. */
export interface SectionKey {
  t: number;
  top: number;
  bottom: number;
  halfWidth: number;
}

export interface FinSpec {
  fin: FinName;
  from: number;
  to: number;
  anchor: 'top' | 'bottom' | 'side';
  /** Fin length, as a fraction of standard length, sampled evenly from `from` to `to`. */
  shape: number[];
  /** Backward shear: how far the tip trails behind the base per unit of fin length. */
  sweep: number;
  /** For side fins, the outward and vertical direction of the fin plane. */
  direction?: [number, number];
  /** Height on the flank for side fins, 0 = belly line, 1 = back. */
  flankHeight?: number;
  /** Selects an alternative texture tile for the fin, such as a spine fin beside the soft dorsal. */
  variant?: number;
}

export interface CaudalSpec {
  /** Fin length along the axis, as a fraction of standard length, sampled from the lower to the upper edge. */
  shape: number[];
  /** Extra half-height at the tip beyond the peduncle, as a fraction of standard length. */
  spread: number;
}

export interface LoftSpec {
  standardLengthM: number;
  sections: SectionKey[];
  /** Superellipse exponent of the cross-section: 2 is elliptical, higher is boxier. */
  roundness: number;
  fins: FinSpec[];
  caudal: CaudalSpec;
  /**
   * Membrane fins: smooth outlines on a finer grid, a caudal rooted inside the peduncle, and a
   * peduncle that narrows so no flat cap shows where the caudal begins.
   */
  membrane?: boolean;
}

/** Maps a fin vertex (fin id, position along the base 0..1, position from base to tip 0..1, tile variant) to a texture coordinate. */
export type FinTexture = (fin: number, u: number, v: number, variant: number) => [number, number];

export interface Projection {
  /** Maps a point in (metres behind the snout, y) to a texture coordinate. */
  (behind: number, y: number): [number, number];
}

export const RING = 24;
export const SECTION_COUNT = 48;
const FIN_COLUMNS = 12;
const FIN_ROWS = 5;
const MEMBRANE_FIN_COLUMNS = 24;
const MEMBRANE_FIN_ROWS = 6;
const ROOT_INSET = 0.02;
const CAUDAL_ROOT_DEPTH = 0.05;
const PEDUNCLE_TAPER_START = 0.86;
const PEDUNCLE_TAPER_WIDTH = 0.65;

function hermite(keys: SectionKey[], pick: (key: SectionKey) => number, t: number): number {
  const n = keys.length;
  let i = 0;
  while (i < n - 2 && t > keys[i + 1]!.t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const slope = (k: number): number => {
    const prev = keys[Math.max(0, k - 1)]!;
    const next = keys[Math.min(n - 1, k + 1)]!;
    return (pick(next) - pick(prev)) / (next.t - prev.t);
  };
  const h = b.t - a.t;
  const s = clamp((t - a.t) / h, 0, 1);
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * pick(a) +
    (s3 - 2 * s2 + s) * h * slope(i) +
    (-2 * s3 + 3 * s2) * pick(b) +
    (s3 - s2) * h * slope(i + 1)
  );
}

export function sectionEdges(
  sections: SectionKey[],
  t: number,
): { top: number; bottom: number; halfWidth: number } {
  return {
    top: hermite(sections, (k) => k.top, t),
    bottom: hermite(sections, (k) => k.bottom, t),
    halfWidth: hermite(sections, (k) => k.halfWidth, t),
  };
}

function sampleShape(shape: number[], u: number, smoothly: boolean): number {
  const position = clamp(u, 0, 1) * (shape.length - 1);
  const i = Math.min(shape.length - 2, Math.floor(position));
  const f = position - i;
  if (!smoothly) return shape[i]! * (1 - f) + shape[i + 1]! * f;
  const p0 = shape[Math.max(0, i - 1)]!;
  const p1 = shape[i]!;
  const p2 = shape[i + 1]!;
  const p3 = shape[Math.min(shape.length - 1, i + 2)]!;
  const f2 = f * f;
  const f3 = f2 * f;
  const value =
    0.5 *
    (2 * p1 +
      (p2 - p0) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (3 * p1 - p0 - 3 * p2 + p3) * f3);
  return Math.max(0, value);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function signedPow(v: number, exponent: number): number {
  return Math.sign(v) * Math.abs(v) ** exponent;
}

class MeshBuilder {
  positions: number[] = [];
  indices: number[] = [];
  mask: number[] = [];
  id: number[] = [];
  finU: number[] = [];
  finV: number[] = [];
  finVariant: number[] = [];

  vertex(
    x: number,
    y: number,
    z: number,
    mask: number,
    id: number,
    u = 0,
    v = 0,
    variant = 0,
  ): number {
    this.positions.push(x, y, z);
    this.mask.push(mask);
    this.id.push(id);
    this.finU.push(u);
    this.finV.push(v);
    this.finVariant.push(variant);
    return this.mask.length - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }
}

function addBody(builder: MeshBuilder, spec: LoftSpec, length: number): void {
  const exponent = 2 / spec.roundness;
  const first = builder.mask.length;
  for (let s = 0; s < SECTION_COUNT; s++) {
    const t = s / (SECTION_COUNT - 1);
    const top = hermite(spec.sections, (k) => k.top, t) * length;
    const bottom = hermite(spec.sections, (k) => k.bottom, t) * length;
    const taper = spec.membrane
      ? 1 - PEDUNCLE_TAPER_WIDTH * smoothstep(PEDUNCLE_TAPER_START, 1, t)
      : 1;
    const width = Math.max(1e-4, hermite(spec.sections, (k) => k.halfWidth, t) * length * taper);
    const centre = (top + bottom) / 2;
    const half = Math.max(1e-4, (top - bottom) / 2);
    const z = length - t * length;
    for (let j = 0; j < RING; j++) {
      const angle = (2 * Math.PI * j) / RING;
      builder.vertex(
        width * signedPow(Math.cos(angle), exponent),
        centre + half * signedPow(Math.sin(angle), exponent),
        z,
        0,
        0,
      );
    }
  }
  for (let s = 0; s < SECTION_COUNT - 1; s++)
    for (let j = 0; j < RING; j++) {
      const a = first + s * RING + j;
      const b = first + s * RING + ((j + 1) % RING);
      const c = first + (s + 1) * RING + j;
      const d = first + (s + 1) * RING + ((j + 1) % RING);
      builder.triangle(a, c, b);
      builder.triangle(b, c, d);
    }
  const cap = (s: number, flip: boolean): void => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < RING; j++) {
      const v = first + s * RING + j;
      cx += builder.positions[v * 3]!;
      cy += builder.positions[v * 3 + 1]!;
      cz += builder.positions[v * 3 + 2]!;
    }
    const centre = builder.vertex(cx / RING, cy / RING, cz / RING, 0, 0);
    for (let j = 0; j < RING; j++) {
      const a = first + s * RING + j;
      const b = first + s * RING + ((j + 1) % RING);
      if (flip) builder.triangle(centre, b, a);
      else builder.triangle(centre, a, b);
    }
  };
  cap(0, false);
  cap(SECTION_COUNT - 1, true);
}

function addFinGrid(
  builder: MeshBuilder,
  id: number,
  base: (u: number) => [number, number, number],
  tip: (u: number) => [number, number, number],
  mirror: boolean,
  columns: number,
  rows: number,
  variant = 0,
): void {
  const first = builder.mask.length;
  for (let c = 0; c <= columns; c++) {
    const u = c / columns;
    const b = base(u);
    const t = tip(u);
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      builder.vertex(
        b[0] + (t[0] - b[0]) * v,
        b[1] + (t[1] - b[1]) * v,
        b[2] + (t[2] - b[2]) * v,
        v,
        id,
        u,
        v,
        variant,
      );
    }
  }
  for (let c = 0; c < columns; c++)
    for (let r = 0; r < rows; r++) {
      const a = first + c * (rows + 1) + r;
      const b = a + 1;
      const d = a + rows + 1;
      const e = d + 1;
      if (mirror) {
        builder.triangle(a, d, b);
        builder.triangle(b, d, e);
      } else {
        builder.triangle(a, b, d);
        builder.triangle(b, e, d);
      }
    }
}

function addFins(builder: MeshBuilder, spec: LoftSpec, length: number): void {
  const at = (t: number, pick: (k: SectionKey) => number): number =>
    hermite(spec.sections, pick, t) * length;
  const columns = spec.membrane ? MEMBRANE_FIN_COLUMNS : FIN_COLUMNS;
  const rows = spec.membrane ? MEMBRANE_FIN_ROWS : FIN_ROWS;
  const smoothly = spec.membrane === true;
  for (const fin of spec.fins) {
    const id = FIN_IDS[fin.fin];
    const sides = fin.anchor === 'side' ? [1, -1] : [0];
    for (const side of sides) {
      const parameter = (u: number): number => fin.from + (fin.to - fin.from) * u;
      const reach = (u: number): number => sampleShape(fin.shape, u, smoothly) * length;
      const zAt = (u: number): number => length - parameter(u) * length;
      const base = (u: number): [number, number, number] => {
        const t = parameter(u);
        if (fin.anchor === 'top') return [0, at(t, (k) => k.top) - ROOT_INSET * length, zAt(u)];
        if (fin.anchor === 'bottom')
          return [0, at(t, (k) => k.bottom) + ROOT_INSET * length, zAt(u)];
        const top = at(t, (k) => k.top);
        const bottom = at(t, (k) => k.bottom);
        const y = bottom + (top - bottom) * (fin.flankHeight ?? 0.4);
        return [side * (at(t, (k) => k.halfWidth) - ROOT_INSET * length), y, zAt(u)];
      };
      const tip = (u: number): [number, number, number] => {
        const [bx, by, bz] = base(u);
        const r = reach(u);
        if (fin.anchor === 'top') return [bx, by + r, bz - fin.sweep * r];
        if (fin.anchor === 'bottom') return [bx, by - r, bz - fin.sweep * r];
        const [dx, dy] = fin.direction ?? [0.8, -0.5];
        const norm = Math.hypot(dx, dy);
        return [bx + (side * dx * r) / norm, by + (dy * r) / norm, bz - fin.sweep * r];
      };
      addFinGrid(builder, id, base, tip, side < 0, columns, rows, fin.variant ?? 0);
    }
  }

  const last = spec.sections[spec.sections.length - 1]!;
  const rearZ = 0;
  const rootZ = rearZ + (spec.membrane ? CAUDAL_ROOT_DEPTH : ROOT_INSET) * length;
  const top = last.top * length;
  const bottom = last.bottom * length;
  const centre = (top + bottom) / 2;
  const spread = spec.caudal.spread * length;
  addFinGrid(
    builder,
    FIN_IDS.caudal,
    (u) => [0, bottom + (top - bottom) * u, rootZ],
    (u) => [
      0,
      centre + (u - 0.5) * (top - bottom + 2 * spread),
      rearZ - sampleShape(spec.caudal.shape, u, smoothly) * length,
    ],
    false,
    columns,
    rows,
  );
}

export function vertexNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array<ArrayBuffer> {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const e1x = positions[b]! - positions[a]!;
    const e1y = positions[b + 1]! - positions[a + 1]!;
    const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!;
    const e2y = positions[c + 1]! - positions[a + 1]!;
    const e2z = positions[c + 2]! - positions[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      normals[v] = normals[v]! + nx;
      normals[v + 1] = normals[v + 1]! + ny;
      normals[v + 2] = normals[v + 2]! + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const n = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = normals[i]! / n;
    normals[i + 1] = normals[i + 1]! / n;
    normals[i + 2] = normals[i + 2]! / n;
  }
  return normals;
}

/** Closed-form lofted fish: +Z forward, +Y up, origin at the body centre of mass, fin mask and id baked analytically. With `finUv` every fin vertex samples that one texel: the photo behind a fin is background, not membrane. */
export function loftFish(
  spec: LoftSpec,
  project: Projection,
  material: string,
  finUv?: [number, number],
  finTexture?: FinTexture,
): Part {
  const length = spec.standardLengthM;
  const builder = new MeshBuilder();
  addBody(builder, spec, length);
  const bodyIndexCount = builder.indices.length;
  addFins(builder, spec, length);

  const positions = Float32Array.from(builder.positions);
  const indices = Uint32Array.from(builder.indices);
  const mask = Float32Array.from(builder.mask);
  const id = Float32Array.from(builder.id);
  const count = mask.length;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    if (finTexture && id[i] !== 0) {
      const [u, v] = finTexture(id[i]!, builder.finU[i]!, builder.finV[i]!, builder.finVariant[i]!);
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
      continue;
    }
    if (finUv && id[i] !== 0) {
      uvs[i * 2] = finUv[0];
      uvs[i * 2 + 1] = finUv[1];
      continue;
    }
    const [u, v] = project(length - positions[i * 3 + 2]!, positions[i * 3 + 1]!);
    uvs[i * 2] = clamp(u, 0, 1);
    uvs[i * 2 + 1] = clamp(v, 0, 1);
  }

  const centre = bodyCentreOfMass(positions, indices, id);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 1] = positions[i * 3 + 1]! - centre[1];
    positions[i * 3 + 2] = positions[i * 3 + 2]! - centre[2];
  }
  if (signedVolume(positions, indices.subarray(0, bodyIndexCount)) < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const swap = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = swap;
    }
  }
  const normals = vertexNormals(positions, indices);
  return {
    positions,
    normals,
    uvs,
    indices,
    material,
    extra: { [FIN_MASK_ATTRIBUTE]: mask, [FIN_ID_ATTRIBUTE]: id },
  };
}

export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    volume +=
      positions[a]! *
        (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
      positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
      positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return volume / 6;
}

/**
 * Similarity transform pinning the snout and the end of the peduncle to two pixels of a side-view
 * photo. A fish facing right in the photo is mirrored as well as rotated, so its back stays up.
 */
export function sideProjection(options: {
  standardLengthM: number;
  snoutY: number;
  tailY: number;
  snoutPixel: [number, number];
  tailPixel: [number, number];
  crop: { left: number; top: number; width: number; height: number };
}): Projection {
  const { standardLengthM: length, snoutY, tailY, crop } = options;
  const toUp = (p: [number, number]): [number, number] => [p[0], -p[1]];
  const snout = toUp(options.snoutPixel);
  const tail = toUp(options.tailPixel);
  const ax = length;
  const ay = tailY - snoutY;
  const px = tail[0] - snout[0];
  const py = tail[1] - snout[1];
  const axisLength = Math.hypot(ax, ay);
  const photoLength = Math.hypot(px, py);
  const scale = photoLength / axisLength;
  const side = px < 0 ? -1 : 1;
  return (behind, y) => {
    const qx = behind;
    const qy = y - snoutY;
    const along = (qx * ax + qy * ay) / axisLength;
    const across = (-qx * ay + qy * ax) / axisLength;
    const x = snout[0] + (scale * (along * px - side * across * py)) / photoLength;
    const yUp = snout[1] + (scale * (along * py + side * across * px)) / photoLength;
    return [(x - crop.left) / crop.width, (-yUp - crop.top) / crop.height];
  };
}
