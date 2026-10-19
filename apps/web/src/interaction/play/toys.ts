import type { Vec3 } from '../camera';

export const BALL_RADIUS_M = 0.02;
/** A ping-pong ball is mostly air: it rides with about a fifth of its height under the surface. */
const BALL_DRAFT = 0.2;
const SURFACE_LAYER_M = 0.01;
/** How fast the surface water drags the ball up to its own speed, per second. */
const WATER_COUPLING_PER_S = 1.6;
/** Skin friction on a floating sphere, beyond the drag that follows the water. */
const SKIN_DAMPING_PER_S = 0.45;
const WALL_RESTITUTION = 0.55;
export const MAX_BALL_SPEED = 1.2;
const MAX_STEP_S = 0.05;
const MAX_NUDGE_SPEED = 0.35;
const BOB_AMPLITUDE_M = 0.0012;
const BOB_RATE_RAD_S = 3.1;

export const MIRROR_WIDTH_M = 0.12;
export const MIRROR_HEIGHT_M = 0.16;
export const MIRROR_GAP_M = 0.004;

export interface BallBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly waterTop: number;
}

export type SurfaceCurrent = (x: number, y: number, z: number, out: Float64Array) => void;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A ping-pong ball on the water surface: it floats, is dragged along by the current and bounces off the glass. */
export class PingPongBall {
  x: number;
  z: number;
  vx = 0;
  vz = 0;
  private held = false;
  private phase = 0;
  private readonly flow = new Float64Array(3);

  constructor(
    private readonly bounds: BallBounds,
    private readonly current: SurfaceCurrent,
    x: number,
    z: number,
  ) {
    this.x = this.clampX(x);
    this.z = this.clampZ(z);
  }

  /** Scene-space centre. */
  get y(): number {
    return (
      this.bounds.waterTop +
      BALL_RADIUS_M * (1 - 2 * BALL_DRAFT) +
      Math.sin(this.phase) * BOB_AMPLITUDE_M
    );
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  get isHeld(): boolean {
    return this.held;
  }

  grab(): void {
    this.held = true;
    this.vx = 0;
    this.vz = 0;
  }

  moveTo(x: number, z: number): void {
    this.x = this.clampX(x);
    this.z = this.clampZ(z);
  }

  release(vx: number, vz: number): void {
    this.held = false;
    this.flick(vx, vz);
  }

  flick(vx: number, vz: number): void {
    const speed = Math.hypot(vx, vz);
    const scale = speed > MAX_BALL_SPEED ? MAX_BALL_SPEED / speed : 1;
    this.vx = vx * scale;
    this.vz = vz * scale;
  }

  /** A fish bumping the ball adds a small push; a hard shove is capped so a fish cannot fling it. */
  nudge(ix: number, iz: number): void {
    const speed = Math.hypot(ix, iz);
    const scale = speed > MAX_NUDGE_SPEED ? MAX_NUDGE_SPEED / speed : 1;
    this.flick(this.vx + ix * scale, this.vz + iz * scale);
  }

  step(deltaS: number): void {
    this.phase += BOB_RATE_RAD_S * deltaS;
    if (this.held) return;
    let left = Math.min(deltaS, 0.25);
    while (left > 0) {
      const dt = Math.min(left, MAX_STEP_S);
      left -= dt;
      this.integrate(dt);
    }
  }

  private integrate(dt: number): void {
    this.current(this.x, this.bounds.waterTop - SURFACE_LAYER_M, this.z, this.flow);
    const follow = 1 - Math.exp(-WATER_COUPLING_PER_S * dt);
    this.vx += ((this.flow[0] ?? 0) - this.vx) * follow;
    this.vz += ((this.flow[2] ?? 0) - this.vz) * follow;
    const damp = Math.exp(-SKIN_DAMPING_PER_S * dt);
    this.vx *= damp;
    this.vz *= damp;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const loX = this.bounds.minX + BALL_RADIUS_M;
    const hiX = this.bounds.maxX - BALL_RADIUS_M;
    const loZ = this.bounds.minZ + BALL_RADIUS_M;
    const hiZ = this.bounds.maxZ - BALL_RADIUS_M;
    if (this.x < loX || this.x > hiX) {
      this.x = clamp(this.x, loX, hiX);
      this.vx = -this.vx * WALL_RESTITUTION;
    }
    if (this.z < loZ || this.z > hiZ) {
      this.z = clamp(this.z, loZ, hiZ);
      this.vz = -this.vz * WALL_RESTITUTION;
    }
  }

  private clampX(x: number): number {
    return clamp(x, this.bounds.minX + BALL_RADIUS_M, this.bounds.maxX - BALL_RADIUS_M);
  }

  private clampZ(z: number): number {
    return clamp(z, this.bounds.minZ + BALL_RADIUS_M, this.bounds.maxZ - BALL_RADIUS_M);
  }
}

export interface MirrorMount {
  readonly position: Vec3;
  /** Unit normal pointing into the tank. */
  readonly normal: Vec3;
}

interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

export const MIRROR_GROUND_MARGIN_M = 0.01;
export const MIRROR_SURFACE_MARGIN_M = 0.01;

/**
 * Where the mirror hangs for a tap along `origin` + `dir`: the back or side wall the ray leaves
 * through, so seen from the side the far glass and never the near one,  kept clear of the corners, the substrate and the water line. A ray that
 * leaves through the floor or the top is mounted on the back wall at the same x and y. Null when
 * the ray points away from the back wall and reaches no side wall. `ground` is the visible
 * substrate height at (x, z).
 */
export function mirrorMountFor(
  origin: Vec3,
  dir: Vec3,
  box: Box,
  ground: (x: number, z: number) => number = () => box.min.y,
): MirrorMount | null {
  const { min, max } = box;
  const walls: { axis: 'x' | 'z'; at: number; normal: Vec3 }[] = [
    { axis: 'z', at: min.z, normal: { x: 0, y: 0, z: 1 } },
    { axis: 'x', at: min.x, normal: { x: 1, y: 0, z: 0 } },
    { axis: 'x', at: max.x, normal: { x: -1, y: 0, z: 0 } },
  ];
  let best: { t: number; wall: (typeof walls)[number] } | null = null;
  for (const wall of walls) {
    const d = dir[wall.axis];
    if (d === 0 || dir.x * wall.normal.x + dir.z * wall.normal.z >= 0) continue;
    const t = (wall.at - origin[wall.axis]) / d;
    if (!(t > 0) || (best !== null && t >= best.t)) continue;
    // The hit wall's own coordinate is the wall by construction; testing it against its own
    // bound only fails on float noise and sends the mirror to the wrong wall.
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    const along = wall.axis === 'z' ? x >= min.x && x <= max.x : z >= min.z && z <= max.z;
    if (!along || y < min.y || y > max.y) continue;
    best = { t, wall };
  }
  let wall = best?.wall;
  let t = best?.t;
  if (!wall || t === undefined) {
    const back = walls[0];
    if (!back || dir.z >= 0) return null;
    const backT = (back.at - origin.z) / dir.z;
    if (!(backT > 0)) return null;
    wall = back;
    t = backT;
  }
  const hit = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
  let x: number;
  let z: number;
  let atX: number;
  let atZ: number;
  if (wall.axis === 'z') {
    x = clamp(hit.x, min.x + MIRROR_WIDTH_M / 2, max.x - MIRROR_WIDTH_M / 2);
    z = wall.at + MIRROR_GAP_M;
    atX = x;
    atZ = wall.at;
  } else {
    z = clamp(hit.z, min.z + MIRROR_WIDTH_M / 2, max.z - MIRROR_WIDTH_M / 2);
    x = wall.at + wall.normal.x * MIRROR_GAP_M;
    atX = wall.at;
    atZ = z;
  }
  const half = MIRROR_WIDTH_M / 2;
  const floor = Math.max(
    min.y,
    ground(atX, atZ),
    wall.axis === 'z' ? ground(atX - half, atZ) : ground(atX, atZ - half),
    wall.axis === 'z' ? ground(atX + half, atZ) : ground(atX, atZ + half),
  );
  const lowest = floor + MIRROR_GROUND_MARGIN_M + MIRROR_HEIGHT_M / 2;
  const highest = max.y - MIRROR_SURFACE_MARGIN_M - MIRROR_HEIGHT_M / 2;
  const y = Math.min(highest, Math.max(lowest, hit.y));
  return { position: { x, y, z }, normal: wall.normal };
}
