import type { Vec3 } from '../camera';

export type TankFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface TankPick {
  readonly point: Vec3;
  readonly face: TankFace;
  /** Unit normal pointing into the tank. */
  readonly normal: Vec3;
}

const FACES: Record<'x' | 'y' | 'z', readonly [TankFace, TankFace]> = {
  x: ['left', 'right'],
  y: ['bottom', 'top'],
  z: ['back', 'front'],
};

/**
 * Where a ray from outside first enters the water box, and through which face. Null when it
 * misses, starts inside, or points away.
 */
export function pickTankBox(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): TankPick | null {
  let tNear = -Infinity;
  let tFar = Infinity;
  let axisNear: 'x' | 'y' | 'z' = 'x';
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    const o = origin[axis];
    if (d === 0) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    const t1 = (min[axis] - o) / d;
    const t2 = (max[axis] - o) / d;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (lo > tNear) {
      tNear = lo;
      axisNear = axis;
    }
    tFar = Math.min(tFar, hi);
    if (tNear > tFar) return null;
  }
  if (!(tNear > 0)) return null;
  const point = {
    x: origin.x + dir.x * tNear,
    y: origin.y + dir.y * tNear,
    z: origin.z + dir.z * tNear,
  };
  const towardsMax = dir[axisNear] < 0;
  const normal = { x: 0, y: 0, z: 0 };
  normal[axisNear] = towardsMax ? -1 : 1;
  return { point, face: FACES[axisNear][towardsMax ? 1 : 0], normal };
}

/** Intersection with the horizontal plane at `y`, or null when the ray never reaches it. */
export function pickPlaneY(origin: Vec3, dir: Vec3, y: number): Vec3 | null {
  if (dir.y === 0) return null;
  const t = (y - origin.y) / dir.y;
  if (!(t > 0)) return null;
  return { x: origin.x + dir.x * t, y, z: origin.z + dir.z * t };
}
