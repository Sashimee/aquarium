import type { Collider, Species } from '@aquarium/shared';
import { compileCollider } from './decor.ts';
import { clamp } from './math.ts';

/** Every tunable of a sinking carcass; sources are in BEHAVIOUR.md. */
export const CARCASS = {
  /** Body density over the water's (Foote et al. 1990: live krill 1.0357). */
  densityContrast: 1.036,
  /** Body diameter over length, twice the walker's half-thickness of 0.12. */
  thicknessBodyLengths: 0.24,
  /** A cylinder falling broadside at Re 10²–10³ (Hoerner 1965). */
  dragCoefficient: 1.2,
  /** Added-mass coefficient of a cylinder moving broadside. */
  addedMass: 1,
  gravity: 9.81,
  /** Body centre over the floor when it lies belly-down on its folded legs. */
  restBellyBodyLengths: 0.12,
  /** Body centre over the floor when it lies on its side; a shrimp is laterally compressed. */
  restSideBodyLengths: 0.08,
  /** Share of carcasses that land belly-down; the rest lie on one side or the other. */
  bellyDownShare: 1 / 3,
  /** Legs and pleopods go limp over this long. */
  limpS: 1.5,
  /** A carcass already on the floor still takes this long to tip over. */
  minSettleS: 0.8,
  /** Centre to either tip; support and clearance are looked for at the tips and halfway there. */
  tipReachBodyLengths: 0.5,
} as const;

export type CarcassFate = 'float' | 'sink';

/**
 * A dead fish's swim bladder and decomposition gases bring it up; a decapod has no gas space and
 * its exoskeleton is denser than water, so it goes down.
 */
export function carcassFate(swimmingMode: Species['locomotion']['swimmingMode']): CarcassFate {
  return swimmingMode === 'pleopod' ? 'sink' : 'float';
}

/** Terminal sinking speed (m/s) of a carcass `length` metres long falling broadside. */
export function sinkSpeed(length: number): number {
  const { densityContrast, gravity, thicknessBodyLengths, dragCoefficient } = CARCASS;
  return Math.sqrt(
    (2 * (densityContrast - 1) * gravity * (Math.PI / 4) * thicknessBodyLengths * length) /
      dragCoefficient,
  );
}

function sinkTimeConstant(length: number): number {
  const { densityContrast, gravity, addedMass } = CARCASS;
  const a0 = (gravity * (densityContrast - 1)) / (densityContrast + addedMass);
  return sinkSpeed(length) / a0;
}

/** Depth fallen after `t` seconds from rest under quadratic drag: vt·τ·ln cosh(t/τ). */
function fallen(t: number, vt: number, tau: number): number {
  const x = t / tau;
  return vt * tau * (x + Math.log1p(Math.exp(-2 * x)) - Math.LN2);
}

/** Inverse of `fallen`: seconds to fall `h` metres. */
function fallTime(h: number, vt: number, tau: number): number {
  const x = h / (vt * tau);
  return tau * (x + Math.log1p(Math.sqrt(-Math.expm1(-2 * x))));
}

function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export interface CarcassStart {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export interface CarcassPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  yawRate: number;
  liveliness: number;
}

/** Height of a resting carcass's centre; never above where it died. */
export function carcassRestY(
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
): number {
  const lift =
    seed < CARCASS.bellyDownShare ? CARCASS.restBellyBodyLengths : CARCASS.restSideBodyLengths;
  return Math.min(from.y, floorY + lift * length);
}

function restRoll(seed: number): number {
  if (seed < CARCASS.bellyDownShare) return 0;
  return seed < (1 + CARCASS.bellyDownShare) / 2 ? Math.PI / 2 : -Math.PI / 2;
}

/**
 * A negatively buoyant carcass `t` seconds after death: it goes limp, sinks straight down from
 * `from` at its drag-limited speed and settles belly-down or on its side, by `seed` in [0, 1).
 * `floorY` is the substrate height under `from`. Its height never increases with `t`. A carcass
 * whose support went away falls again from rest at `from`, `fallT` seconds ago, while its limbs
 * and roll keep counting from death. Along `path`, from `CarcassSupport.descend`, it slides off
 * steep rock on the way down.
 */
export function sinkingCarcass(
  t: number,
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
  out: CarcassPose,
  fallT = t,
  path: Float64Array | null = null,
): void {
  const s = Math.max(0, t);
  const fall = Math.max(0, fallT);
  const vt = sinkSpeed(length);
  const tau = sinkTimeConstant(length);
  const restY = carcassRestY(from, length, seed, floorY);
  const drop = from.y - restY;
  const landS = fallTime(drop, vt, tau);
  const settled = fall >= landS;
  out.x = from.x;
  out.z = from.z;
  out.y = settled ? restY : Math.max(restY, from.y - fallen(fall, vt, tau));
  if (path !== null) carcassPathAt(path, out.y, out);
  out.yaw = from.yaw;
  out.pitch = 0;
  out.roll = restRoll(seed) * smoothstep(s / Math.max(landS, CARCASS.minSettleS));
  out.speed = 0;
  out.yawRate = 0;
  out.liveliness = 1 - smoothstep(s / CARCASS.limpS);
}

/** Seconds a carcass dropped from `from` takes to reach its rest height. */
export function carcassLandS(
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
): number {
  const drop = from.y - carcassRestY(from, length, seed, floorY);
  return fallTime(drop, sinkSpeed(length), sinkTimeConstant(length));
}

/** Seconds from death until a carcass dropped from `from` lies still on the floor. */
export function carcassSettleS(
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
): number {
  const land = carcassLandS(from, length, seed, floorY);
  return Math.max(land, CARCASS.minSettleS, CARCASS.limpS);
}

type Primitive = ReturnType<typeof compileCollider>;

export interface CarcassDescent {
  /** What it lands on: the substrate or the top of hard decor. */
  readonly floorY: number;
  /** Where its centre goes on the way down, as (y, x, z) with y falling; it slides off steep rock. */
  readonly path: Float64Array;
}

const SURFACE_M = 5e-4;
/** How close the body's skin comes to rock before a push off a steep face stops. */
const CONTACT_M = 1e-4;
/** How far a body sliding down a steep face drops between looks at the rock beside it. */
const SLIDE_STEP_M = 5e-4;
const MAX_MARCH_STEPS = 4096;
/** A surface whose normal points at least this far up holds a body; a steeper one it slides off. */
const SUPPORT_NORMAL_Y = 0.5;
/** Along the body from its centre, in tip reaches: where it is held up and kept clear of rock. */
const BODY_POINTS = [0, 0.5, -0.5, 1, -1] as const;
/** Rock whose bounds are further than this from the body when the search looks round is skipped. */
const NEAR_M = 0.05;

/** Where a sinking carcass's centre is at height `y` along `path`; (x, z) go into `out`. */
export function carcassPathAt(path: Float64Array, y: number, out: { x: number; z: number }): void {
  const last = path.length - 3;
  let k = 0;
  while (k < last && (path[k + 3] ?? -Infinity) >= y) k += 3;
  const y0 = path[k] ?? y;
  const x0 = path[k + 1] ?? out.x;
  const z0 = path[k + 2] ?? out.z;
  if (k >= last || y >= y0) {
    out.x = x0;
    out.z = z0;
    return;
  }
  const y1 = path[k + 3] ?? y0;
  const w = y0 > y1 ? (y0 - y) / (y0 - y1) : 1;
  out.x = x0 + w * ((path[k + 4] ?? x0) - x0);
  out.z = z0 + w * ((path[k + 5] ?? z0) - z0);
}

/**
 * The decor a carcass comes to rest on. Plants and anemones bend under a body, so only hard
 * colliders hold one up.
 */
export class CarcassSupport {
  private readonly hard: readonly Primitive[];
  private readonly normal = new Float64Array(3);
  private readonly nearest = new Float64Array(3);

  constructor(colliders: readonly Collider[]) {
    this.hard = colliders.filter((c) => c.hard).map(compileCollider);
  }

  /** `descend(from, length, ground).floorY`. */
  floorY(from: CarcassStart, length: number, ground: (x: number, z: number) => number): number {
    return this.descend(from, length, ground).floorY;
  }

  /**
   * How a carcass dropped from `from` goes down: its centre, tips and the points halfway to them,
   * kept half a body thickness clear of hard rock, fall until one of them rests on a surface that
   * faces up or on the substrate `ground`. Off a steeper face it is pushed clear and slides down
   * it. A body that starts inside a rock lies on top.
   */
  descend(
    from: CarcassStart,
    length: number,
    ground: (x: number, z: number) => number,
  ): CarcassDescent {
    const reach = CARCASS.tipReachBodyLengths * length;
    const ex = Math.sin(from.yaw) * reach;
    const ez = Math.cos(from.yaw) * reach;
    const clearance = (CARCASS.thicknessBodyLengths / 2) * length;
    const raised = this.raisedOutOf(from, ex, ez);
    if (raised !== null) {
      const floorY = Math.max(raised, this.highestGround(from.x, from.z, ex, ez, ground));
      return { floorY, path: Float64Array.of(from.y, from.x, from.z) };
    }
    const path = [from.y, from.x, from.z];
    let { x, y, z } = from;
    let near = this.near(x, z, ex, ez, y + clearance);
    let nearX = x;
    let nearZ = z;
    // Every step drops at least SLIDE_STEP_M or lands, so this always reaches the floor.
    const budget = MAX_MARCH_STEPS + Math.ceil((from.y - ground(from.x, from.z)) / SLIDE_STEP_M);
    let floorY = -Infinity;
    for (let i = 0; i < budget; i++) {
      if (Math.hypot(x - nearX, z - nearZ) > NEAR_M / 2) {
        near = this.near(x, z, ex, ez, y + clearance);
        nearX = x;
        nearZ = z;
      }
      const g = this.highestGround(x, z, ex, ez, ground);
      const gap = Math.min(this.bodyDistance(near, x, y, z, ex, ez), NEAR_M / 2) - clearance;
      const aboveGround = y - clearance - g;
      if (aboveGround <= CONTACT_M) {
        floorY = g;
        break;
      }
      const [nx = 0, ny = 0, nz = 0] = this.nearest;
      const facesUp = ny >= SUPPORT_NORMAL_Y;
      // Closing in on a face that points up shrinks the gap by at least half each step; beside a
      // steep one it may not shrink at all, so that is left to the fixed slide steps below.
      if (gap > SURFACE_M || (facesUp && gap > CONTACT_M)) {
        y -= Math.min(gap, aboveGround);
        continue;
      }
      if (facesUp) {
        floorY = Math.max(g, y - clearance - gap);
        break;
      }
      const across = Math.hypot(nx, nz);
      if ((path[path.length - 3] ?? y) - y > SLIDE_STEP_M) path.push(y, x, z);
      if (across > 1e-6 && gap < CONTACT_M) {
        const push = (CONTACT_M - gap) / across;
        x += (nx / across) * push;
        z += (nz / across) * push;
      }
      y -= Math.min(SLIDE_STEP_M, aboveGround);
      path.push(y, x, z);
    }
    if (floorY === -Infinity) {
      floorY = Math.max(this.highestGround(x, z, ex, ez, ground), y - clearance);
    }
    return { floorY, path: Float64Array.from(path) };
  }

  /**
   * The rock that can come near a body centred at (x, z) and below `top`: anything else is more
   * than NEAR_M away, and stays over NEAR_M / 2 away until the body slides that far.
   */
  private near(x: number, z: number, ex: number, ez: number, top: number): Primitive[] {
    const minX = x - Math.abs(ex) - NEAR_M;
    const maxX = x + Math.abs(ex) + NEAR_M;
    const minZ = z - Math.abs(ez) - NEAR_M;
    const maxZ = z + Math.abs(ez) + NEAR_M;
    return this.hard.filter(
      (p) => p.maxX >= minX && p.minX <= maxX && p.maxZ >= minZ && p.minZ <= maxZ && p.minY <= top,
    );
  }

  /** The highest rock top over any of the body's points that start inside rock, or null. */
  private raisedOutOf(from: CarcassStart, ex: number, ez: number): number | null {
    let top: number | null = null;
    for (const side of BODY_POINTS) {
      const x = from.x + side * ex;
      const z = from.z + side * ez;
      let y = from.y;
      let d = this.distance(this.hard, x, y, z);
      if (d >= 0) continue;
      for (let i = 0; d < 0 && i < MAX_MARCH_STEPS; i++) {
        y += Math.max(-d, SURFACE_M);
        d = this.distance(this.hard, x, y, z);
      }
      top = Math.max(top ?? -Infinity, y);
    }
    return top;
  }

  private highestGround(
    x: number,
    z: number,
    ex: number,
    ez: number,
    ground: (x: number, z: number) => number,
  ): number {
    let g = -Infinity;
    for (const side of BODY_POINTS) g = Math.max(g, ground(x + side * ex, z + side * ez));
    return g;
  }

  /** Distance from the nearest of the body's points to rock; that surface's normal goes to `nearest`. */
  private bodyDistance(
    rocks: readonly Primitive[],
    x: number,
    y: number,
    z: number,
    ex: number,
    ez: number,
  ): number {
    let d = Infinity;
    for (const side of BODY_POINTS) {
      const dp = this.distance(rocks, x + side * ex, y, z + side * ez);
      if (dp < d) {
        d = dp;
        this.nearest.set(this.normal);
      }
    }
    return d;
  }

  /** Union distance at (x, y, z); the nearest surface's normal is left in `normal`. */
  private distance(rocks: readonly Primitive[], x: number, y: number, z: number): number {
    let d = Infinity;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const p of rocks) {
      const dp = p.sample(x, y, z, this.normal);
      if (dp < d) {
        d = dp;
        nx = this.normal[0] ?? 0;
        ny = this.normal[1] ?? 0;
        nz = this.normal[2] ?? 0;
      }
    }
    this.normal[0] = nx;
    this.normal[1] = ny;
    this.normal[2] = nz;
    return d;
  }
}
