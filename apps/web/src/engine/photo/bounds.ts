import { STAND_HEIGHT, type TankDimensions, validateTank } from '../tank/dimensions';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
}

/** The free camera stays in the room: the water has no inside to see from. */
export interface PhotoBounds {
  /** The room the eye may roam. */
  readonly room: Box;
  /** Tank and stand, grown by the reach of the near plane; the eye stays out of it. */
  readonly solid: Box;
}

/** The view the bounds are for: how far the near plane reaches decides how close the eye gets. */
export interface PhotoLens {
  readonly near: number;
  /** Vertical field of view in degrees. */
  readonly fov: number;
  /** Width over height. */
  readonly aspect: number;
}

/** The orbit camera reaches 4 m from the tank, so every pose it can hand over is in the room. */
const ROOM_MARGIN = 4.5;
const ROOM_CEILING = 4.5;
const FLOOR_EYE = 0.1;
const STAND_OVERHANG = 0.02;
/** Past the near plane's reach, so a corner of the picture never grazes the glass. */
const NEAR_MARGIN = 0.01;

/**
 * How far the near plane's farthest point, a corner, is from the eye. Kept at least that far from
 * a face, the near plane can't cross it whichever way the camera looks.
 */
export function nearPlaneReach(lens: PhotoLens): number {
  const { near, fov, aspect } = lens;
  if (!(near > 0 && near < Infinity && fov > 0 && fov < 180 && aspect > 0 && aspect < Infinity)) {
    throw new RangeError(
      `photo lens: need near > 0, 0 < fov < 180 and aspect > 0, got ${near}, ${fov}, ${aspect}`,
    );
  }
  const halfHeight = Math.tan((fov * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  return near * Math.sqrt(1 + halfHeight * halfHeight + halfWidth * halfWidth);
}

export function photoBounds(d: TankDimensions, lens: PhotoLens): PhotoBounds {
  validateTank(d);
  const halfL = d.length / 2;
  const halfD = d.depth / 2;
  const clearance = nearPlaneReach(lens) + NEAR_MARGIN;
  const sideClear = STAND_OVERHANG + clearance;
  return {
    room: {
      min: {
        x: -halfL - ROOM_MARGIN,
        y: -STAND_HEIGHT + Math.max(FLOOR_EYE, clearance),
        z: -halfD - ROOM_MARGIN,
      },
      max: { x: halfL + ROOM_MARGIN, y: d.height + ROOM_CEILING, z: halfD + ROOM_MARGIN },
    },
    solid: {
      min: { x: -halfL - sideClear, y: -Infinity, z: -halfD - sideClear },
      max: { x: halfL + sideClear, y: d.height + clearance, z: halfD + sideClear },
    },
  };
}

function inside(p: Vec3, box: Box): boolean {
  const { min, max } = box;
  return p.x > min.x && p.x < max.x && p.y > min.y && p.y < max.y && p.z > min.z && p.z < max.z;
}

function clampInto(p: Vec3, box: Box): Vec3 {
  const { min, max } = box;
  return {
    x: Math.min(max.x, Math.max(min.x, p.x)),
    y: Math.min(max.y, Math.max(min.y, p.y)),
    z: Math.min(max.z, Math.max(min.z, p.z)),
  };
}

/** Moves an eye inside `solid` out through the nearest of its sides or its top. */
function pushOut(p: Vec3, solid: Box): Vec3 {
  if (!inside(p, solid)) return p;
  const exits: [number, Vec3][] = [
    [p.x - solid.min.x, { ...p, x: solid.min.x }],
    [solid.max.x - p.x, { ...p, x: solid.max.x }],
    [p.z - solid.min.z, { ...p, z: solid.min.z }],
    [solid.max.z - p.z, { ...p, z: solid.max.z }],
    [solid.max.y - p.y, { ...p, y: solid.max.y }],
  ];
  let best = exits[0];
  for (const exit of exits) if (best === undefined || exit[0] < best[0]) best = exit;
  return best === undefined ? p : best[1];
}

function requireFinite(name: string, p: Vec3): void {
  if (![p.x, p.y, p.z].every(Number.isFinite)) {
    throw new RangeError(`photo camera: ${name} must be finite, got ${p.x}, ${p.y}, ${p.z}`);
  }
}

/** The nearest allowed eye position to `eye`. */
export function clampEye(eye: Vec3, bounds: PhotoBounds): Vec3 {
  requireFinite('eye', eye);
  return pushOut(clampInto(eye, bounds.room), bounds.solid);
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * Where an eye moving from `from` to `to` ends. A move into the tank slides along the side it
 * would have entered through, so a long step can't tunnel out at the far side.
 */
export function moveEye(from: Vec3, to: Vec3, bounds: PhotoBounds): Vec3 {
  requireFinite('eye', from);
  requireFinite('target', to);
  const { solid } = bounds;
  const target = clampInto(to, bounds.room);
  if (inside(from, solid)) return clampEye(target, bounds);
  const entry = segmentEntry(from, target, solid);
  if (entry === null) return clampEye(target, bounds);
  return clampEye({ ...target, [entry.axis]: entry.face }, bounds);
}

/** Where the segment `from`-`to` first enters the open box, by the slab method; null if never. */
function segmentEntry(
  from: Vec3,
  to: Vec3,
  box: Box,
): { axis: (typeof AXES)[number]; face: number } | null {
  let enter = -Infinity;
  let exit = Infinity;
  let axisIn: (typeof AXES)[number] | null = null;
  let face = 0;
  for (const axis of AXES) {
    const d = to[axis] - from[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (d === 0) {
      if (!(from[axis] > lo && from[axis] < hi)) return null;
      continue;
    }
    const tLo = (lo - from[axis]) / d;
    const tHi = (hi - from[axis]) / d;
    const tIn = Math.min(tLo, tHi);
    const tOut = Math.max(tLo, tHi);
    if (tIn > enter) {
      enter = tIn;
      axisIn = axis;
      face = d > 0 ? lo : hi;
    }
    exit = Math.min(exit, tOut);
  }
  // An eye resting on a face starts there at t = 0 and must not slip through it.
  if (axisIn === null || !(enter >= 0 && enter <= 1 && enter < exit)) return null;
  return { axis: axisIn, face };
}
