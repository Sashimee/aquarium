import type { DecorItem } from '@aquarium/shared';
import type { DecorSpec } from './spec';

/** An oriented rectangle on the substrate plus a height span; the piece's collision footprint. */
export interface Footprint {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
  readonly cos: number;
  readonly sin: number;
  readonly yMin: number;
  readonly yMax: number;
}

type Placed = Pick<DecorItem, 'position' | 'rotationY' | 'scale'>;

/**
 * Bounding boxes of organic models are looser than the models, so overlap tests shrink the
 * rectangle. The shipped presets pile rocks on purpose and overlap at any sensible shrink, so
 * this only governs what the player may create, not what a preset starts with.
 */
export const OVERLAP_SHRINK = 0.8;

/** Rotation about +Y as three.js applies it: +Z turns towards +X. */
export function footprintOf(spec: Pick<DecorSpec, 'box'>, item: Placed, shrink = 1): Footprint {
  const { min, max } = spec.box;
  const s = item.scale;
  const cos = Math.cos(item.rotationY);
  const sin = Math.sin(item.rotationY);
  const lx = ((min[0] + max[0]) / 2) * s;
  const lz = ((min[2] + max[2]) / 2) * s;
  return {
    cx: item.position[0] + lx * cos + lz * sin,
    cz: item.position[2] - lx * sin + lz * cos,
    hx: ((max[0] - min[0]) / 2) * s * shrink,
    hz: ((max[2] - min[2]) / 2) * s * shrink,
    cos,
    sin,
    yMin: item.position[1] + min[1] * s,
    yMax: item.position[1] + max[1] * s,
  };
}

export function corners(f: Footprint): [number, number][] {
  const out: [number, number][] = [];
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const lx = sx * f.hx;
      const lz = sz * f.hz;
      out.push([f.cx + lx * f.cos + lz * f.sin, f.cz - lx * f.sin + lz * f.cos]);
    }
  }
  return out;
}

/** Half-extent along world x and z of the rotated rectangle. */
export function extentOf(f: Footprint): { x: number; z: number } {
  return {
    x: f.hx * Math.abs(f.cos) + f.hz * Math.abs(f.sin),
    z: f.hx * Math.abs(f.sin) + f.hz * Math.abs(f.cos),
  };
}

export function overlaps(a: Footprint, b: Footprint, gap = 0): boolean {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const axes: [number, number][] = [
    [a.cos, -a.sin],
    [a.sin, a.cos],
    [b.cos, -b.sin],
    [b.sin, b.cos],
  ];
  for (const [nx, nz] of axes) {
    const ra = a.hx * Math.abs(nx * a.cos - nz * a.sin) + a.hz * Math.abs(nx * a.sin + nz * a.cos);
    const rb = b.hx * Math.abs(nx * b.cos - nz * b.sin) + b.hz * Math.abs(nx * b.sin + nz * b.cos);
    if (Math.abs(dx * nx + dz * nz) > ra + rb + gap) return false;
  }
  return true;
}

export function containsPoint(f: Footprint, x: number, z: number): boolean {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return Math.abs(dx * f.cos - dz * f.sin) <= f.hx && Math.abs(dx * f.sin + dz * f.cos) <= f.hz;
}

export function insideTank(f: Footprint, halfLength: number, halfDepth: number): boolean {
  const e = extentOf(f);
  return Math.abs(f.cx) + e.x <= halfLength + 1e-9 && Math.abs(f.cz) + e.z <= halfDepth + 1e-9;
}

export interface RayLike {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly dir: { readonly x: number; readonly y: number; readonly z: number };
}

/** Distance along the ray to the footprint extruded between its heights, or null on a miss. */
export function rayHit(f: Footprint, ray: RayLike): number | null {
  const ox = ray.origin.x - f.cx;
  const oz = ray.origin.z - f.cz;
  const lo = [ox * f.cos - oz * f.sin, ray.origin.y, ox * f.sin + oz * f.cos] as const;
  const ld = [
    ray.dir.x * f.cos - ray.dir.z * f.sin,
    ray.dir.y,
    ray.dir.x * f.sin + ray.dir.z * f.cos,
  ] as const;
  const mins = [-f.hx, f.yMin, -f.hz] as const;
  const maxs = [f.hx, f.yMax, f.hz] as const;
  let near = 0;
  let far = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = ld[i] ?? 0;
    const o = lo[i] ?? 0;
    const min = mins[i] ?? 0;
    const max = maxs[i] ?? 0;
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return null;
      continue;
    }
    const t1 = (min - o) / d;
    const t2 = (max - o) / d;
    near = Math.max(near, Math.min(t1, t2));
    far = Math.min(far, Math.max(t1, t2));
    if (near > far) return null;
  }
  return near;
}
