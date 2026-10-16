import { STAND_HEIGHT, type TankDimensions, validateTank, waterBounds } from '../tank/dimensions';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
}

/** Where the free camera is: it stays on its side of the glass, since the glass has no inside. */
export type PhotoRegion = 'room' | 'water';

export interface PhotoBounds {
  /** The room the eye may roam outside the tank. */
  readonly room: Box;
  /** Tank and stand, grown by the clearance the near plane needs; the room eye stays out of it. */
  readonly solid: Box;
  /** Where the eye may be inside the water. */
  readonly water: Box;
  /** The water itself, which decides the region an eye starts in. */
  readonly waterVolume: Box;
}

/** The orbit camera reaches 4 m from the tank, so every pose it can hand over is in the room. */
const ROOM_MARGIN = 4.5;
const ROOM_CEILING = 4.5;
const FLOOR_EYE = 0.1;
/** Past the camera's 5 cm near plane, so the glass never slices the picture. */
const GLASS_CLEARANCE = 0.08;
const STAND_OVERHANG = 0.02;
const SUBSTRATE_CLEARANCE = 0.05;
const SURFACE_CLEARANCE = 0.02;

export function photoBounds(d: TankDimensions): PhotoBounds {
  validateTank(d);
  const halfL = d.length / 2;
  const halfD = d.depth / 2;
  const volume = waterBounds(d);
  const sideClear = STAND_OVERHANG + GLASS_CLEARANCE;
  const waterInset = GLASS_CLEARANCE;
  return {
    room: {
      min: { x: -halfL - ROOM_MARGIN, y: -STAND_HEIGHT + FLOOR_EYE, z: -halfD - ROOM_MARGIN },
      max: { x: halfL + ROOM_MARGIN, y: d.height + ROOM_CEILING, z: halfD + ROOM_MARGIN },
    },
    solid: {
      min: { x: -halfL - sideClear, y: -Infinity, z: -halfD - sideClear },
      max: { x: halfL + sideClear, y: d.height + GLASS_CLEARANCE, z: halfD + sideClear },
    },
    water: {
      min: {
        x: volume.min.x + waterInset,
        y: d.glass + Math.max(d.substrateFront, d.substrateBack) + SUBSTRATE_CLEARANCE,
        z: volume.min.z + waterInset,
      },
      max: {
        x: volume.max.x - waterInset,
        y: volume.max.y - SURFACE_CLEARANCE,
        z: volume.max.z - waterInset,
      },
    },
    waterVolume: {
      min: { x: volume.min.x, y: volume.min.y, z: volume.min.z },
      max: { x: volume.max.x, y: volume.max.y, z: volume.max.z },
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

export function regionOf(eye: Vec3, bounds: PhotoBounds): PhotoRegion {
  return inside(eye, bounds.waterVolume) ? 'water' : 'room';
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

/** The nearest allowed eye position to `eye` in `region`. */
export function clampEye(eye: Vec3, region: PhotoRegion, bounds: PhotoBounds): Vec3 {
  requireFinite('eye', eye);
  if (region === 'water') return clampInto(eye, bounds.water);
  return pushOut(clampInto(eye, bounds.room), bounds.solid);
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * Where an eye moving from `from` to `to` ends. In the room a move into the tank slides along the
 * side it would have entered through, so a long step can't tunnel out at the far side.
 */
export function moveEye(from: Vec3, to: Vec3, region: PhotoRegion, bounds: PhotoBounds): Vec3 {
  requireFinite('eye', from);
  requireFinite('target', to);
  const { solid } = bounds;
  const target = region === 'room' ? clampInto(to, bounds.room) : to;
  if (region === 'water' || inside(from, solid)) return clampEye(target, region, bounds);
  const entry = segmentEntry(from, target, solid);
  if (entry === null) return clampEye(target, region, bounds);
  return clampEye({ ...target, [entry.axis]: entry.face }, region, bounds);
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
