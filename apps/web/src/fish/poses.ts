/**
 * Poses for fish the sim does not move: a bagged fish acclimating at the surface, a dying one and
 * a dead one floating belly-up. These are fixed animations, not behaviour, so they live here.
 * Engine space, metres and radians; yaw/pitch/roll follow `quatFromYawPitchRoll`.
 */

export interface WaterBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** The water surface. */
  readonly top: number;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** Drives the tail beat as if the fish swam at this speed (m/s). */
  speed: number;
  yawRate: number;
  /** Scales the body wave and fin motion: 1 alive, 0 limp. */
  liveliness: number;
}

export interface Anchor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export const DYING_S = 6;
export const BELLY_UP = Math.PI;
/** A floating body rides with most of it under water; its centre sits this far down, in lengths. */
const FLOAT_DEPTH = 0.08;
const BAG_SPACING = 0.16;
const BAG_INSET = 0.12;

export function createPose(): Pose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, yawRate: 0, liveliness: 1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function keepInside(pose: Pose, box: WaterBox, length: number): void {
  const m = length / 2;
  pose.x = clamp(pose.x, box.minX + m, box.maxX - m);
  pose.z = clamp(pose.z, box.minZ + m, box.maxZ - m);
}

export function floatHeight(box: WaterBox, length: number): number {
  return box.top - FLOAT_DEPTH * length;
}

/** Where a fish that was already dead when the tank loaded floats; `seed` is 0..1. */
export function deadAnchor(box: WaterBox, length: number, seed: number): Anchor {
  const m = length;
  const u = (seed * 7.31) % 1;
  const v = (seed * 13.7) % 1;
  return {
    x: clamp(box.minX + m + u * (box.maxX - box.minX - 2 * m), box.minX + m, box.maxX - m),
    y: floatHeight(box, length),
    z: clamp(box.minZ + m + v * (box.maxZ - box.minZ - 2 * m), box.minZ + m, box.maxZ - m),
    yaw: seed * Math.PI * 2,
  };
}

/** Belly-up at the surface, bobbing and drifting a little. Equals `anchor` at t = 0. */
export function deadPose(
  t: number,
  anchor: Anchor,
  length: number,
  seed: number,
  box: WaterBox,
  out: Pose,
): void {
  const w = 0.6 + 0.4 * seed;
  out.x = anchor.x + 0.01 * Math.sin(0.21 * w * t);
  out.z = anchor.z + 0.008 * Math.sin(0.17 * w * t);
  out.y = floatHeight(box, length) + 0.0015 * Math.sin(1.3 * w * t);
  out.yaw = anchor.yaw + 0.25 * Math.sin(0.05 * w * t);
  out.pitch = 0.04 * Math.sin(0.9 * w * t);
  out.roll = BELLY_UP + 0.1 * Math.sin(0.7 * w * t);
  out.speed = 0;
  out.yawRate = 0;
  out.liveliness = 0;
  keepInside(out, box, length);
}

/**
 * Death throes from `from`: darting and spinning that peak mid-way, while the fish loses buoyancy
 * control, rolls over and rises; after `DYING_S` it continues as `deadPose`.
 */
export function dyingPose(
  t: number,
  from: Anchor,
  length: number,
  seed: number,
  box: WaterBox,
  out: Pose,
): void {
  if (t >= DYING_S) {
    deadPose(t - DYING_S, dyingEnd(from, length, box), length, seed, box, out);
    return;
  }
  const u = Math.max(0, t) / DYING_S;
  const s = seed * Math.PI * 2;
  const throes = Math.sin(Math.PI * u);
  const float = floatHeight(box, length);
  out.x = from.x + 1.2 * length * throes * Math.sin(2.3 * t + 6 * s);
  out.z = from.z + 1.2 * length * throes * Math.sin(1.7 * t + 3 * s);
  out.y = Math.min(
    float,
    Math.max(
      box.minY + length / 2,
      from.y +
        (float - from.y) * smoothstep(0.15, 1, u) +
        0.8 * length * throes * Math.sin(2.9 * t + s),
    ),
  );
  out.yaw = from.yaw + 2.2 * throes * Math.sin(3.1 * t + 5 * s);
  out.yawRate = 2.2 * 3.1 * throes * Math.cos(3.1 * t + 5 * s);
  out.pitch = 0.5 * throes * Math.sin(4.3 * t + 2 * s);
  out.roll = BELLY_UP * smoothstep(0.3, 1, u) + 0.9 * throes * Math.sin(5.3 * t + 4 * s);
  out.liveliness = 1 - smoothstep(0.55, 1, u);
  out.speed = length * (1.5 + 1.5 * Math.abs(Math.sin(3.7 * t + s))) * out.liveliness;
  keepInside(out, box, length);
}

function dyingEnd(from: Anchor, length: number, box: WaterBox): Anchor {
  const m = length / 2;
  return {
    x: clamp(from.x, box.minX + m, box.maxX - m),
    y: floatHeight(box, length),
    z: clamp(from.z, box.minZ + m, box.maxZ - m),
    yaw: from.yaw,
  };
}

/** The bag holds the fish with a little room to turn. */
export function bagRadius(length: number): number {
  return clamp(0.75 * length, 0.035, 0.1);
}

/** Bags float side by side along the front glass from the left, one per `slot`. */
export function bagCentre(slot: number, box: WaterBox): { x: number; z: number } {
  return {
    x: clamp(box.minX + BAG_INSET + slot * BAG_SPACING, box.minX + BAG_INSET, box.maxX - BAG_INSET),
    z: box.minZ + BAG_INSET * 0.75,
  };
}

/** Bags ride a little high, with air in the top; this is the bag's centre height. */
export function bagHeight(t: number, length: number, seed: number, box: WaterBox): number {
  return box.top - 0.8 * bagRadius(length) + 0.003 * Math.sin(1.1 * t + seed * 40);
}

export function bagPose(
  t: number,
  slot: number,
  length: number,
  seed: number,
  box: WaterBox,
  out: Pose,
): void {
  const r = bagRadius(length);
  const c = bagCentre(slot, box);
  const s = seed * Math.PI * 2;
  out.x = c.x + 0.25 * r * Math.sin(0.5 * t + 6 * s);
  out.z = c.z + 0.2 * r * Math.sin(0.37 * t + 3 * s);
  out.y = bagHeight(t, length, seed, box);
  out.yaw = Math.PI / 2 + 0.8 * Math.sin(0.31 * t + 6 * s);
  out.yawRate = 0.8 * 0.31 * Math.cos(0.31 * t + 6 * s);
  out.pitch = 0;
  out.roll = 0;
  out.speed = 0.4 * length;
  out.liveliness = 1;
}

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Distance along a unit-length ray to a sphere, 0 if it starts inside, null on a miss. */
export function raySphere(origin: Point, dir: Point, centre: Point, radius: number): number | null {
  const lx = centre.x - origin.x;
  const ly = centre.y - origin.y;
  const lz = centre.z - origin.z;
  const along = lx * dir.x + ly * dir.y + lz * dir.z;
  const offAxisSq = lx * lx + ly * ly + lz * lz - along * along;
  const r2 = radius * radius;
  if (offAxisSq > r2) return null;
  const half = Math.sqrt(r2 - offAxisSq);
  if (along - half >= 0) return along - half;
  return along + half >= 0 ? 0 : null;
}
