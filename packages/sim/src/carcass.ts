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
  /** Fore and aft of the centre, where what holds the body up is looked for. */
  supportReachBodyLengths: 0.4,
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
 * and roll keep counting from death.
 */
export function sinkingCarcass(
  t: number,
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
  out: CarcassPose,
  fallT = t,
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
  out.yaw = from.yaw;
  out.pitch = 0;
  out.roll = restRoll(seed) * smoothstep(s / Math.max(landS, CARCASS.minSettleS));
  out.speed = 0;
  out.yawRate = 0;
  out.liveliness = 1 - smoothstep(s / CARCASS.limpS);
}

/** Seconds from death until a carcass dropped from `from` lies still on the floor. */
export function carcassSettleS(
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
): number {
  const drop = from.y - carcassRestY(from, length, seed, floorY);
  const land = fallTime(drop, sinkSpeed(length), sinkTimeConstant(length));
  return Math.max(land, CARCASS.minSettleS, CARCASS.limpS);
}

type Primitive = ReturnType<typeof compileCollider>;

const SURFACE_M = 5e-4;
const MAX_MARCH_STEPS = 4096;
/** A surface whose normal points at least this far up holds a body; a steeper one it slides off. */
const SUPPORT_NORMAL_Y = 0.5;

/**
 * The decor a carcass comes to rest on. Plants and anemones bend under a body, so only hard
 * colliders hold one up.
 */
export class CarcassSupport {
  private readonly hard: readonly Primitive[];
  private readonly normal = new Float64Array(3);
  private nearestUp = 0;

  constructor(colliders: readonly Collider[]) {
    this.hard = colliders.filter((c) => c.hard).map(compileCollider);
  }

  /**
   * The floor a carcass dropped from `from` lands on: the highest hard surface under its centre
   * or either end, or the substrate `ground` there. A body that starts inside a rock lies on top.
   */
  floorY(from: CarcassStart, length: number, ground: (x: number, z: number) => number): number {
    const reach = CARCASS.supportReachBodyLengths * length;
    const dx = Math.sin(from.yaw) * reach;
    const dz = Math.cos(from.yaw) * reach;
    let floor = -Infinity;
    for (const side of [0, 1, -1]) {
      const x = from.x + side * dx;
      const z = from.z + side * dz;
      floor = Math.max(floor, this.columnFloor(x, z, from.y, ground(x, z)));
    }
    return floor;
  }

  private columnFloor(x: number, z: number, top: number, ground: number): number {
    const under = this.hard.filter(
      (p) => x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && p.minY <= top,
    );
    if (under.length === 0) return ground;
    let y = top;
    let d = this.distance(under, x, y, z);
    for (let i = 0; d < 0 && i < MAX_MARCH_STEPS; i++) {
      y += Math.max(-d, SURFACE_M);
      d = this.distance(under, x, y, z);
    }
    for (let i = 0; y > ground && i < MAX_MARCH_STEPS; i++) {
      if (d > SURFACE_M) y -= d;
      // Brushing past a rock's flank is no landing; the column only stops on a top or inside.
      else if (d < 0 || this.nearestUp >= SUPPORT_NORMAL_Y) break;
      else y -= SURFACE_M;
      d = this.distance(under, x, y, z);
    }
    return Math.max(y, ground);
  }

  /** Union distance at (x, y, z); `nearestUp` is the up component of the nearest surface's normal. */
  private distance(under: readonly Primitive[], x: number, y: number, z: number): number {
    let d = Infinity;
    for (const p of under) {
      const dp = p.sample(x, y, z, this.normal);
      if (dp < d) {
        d = dp;
        this.nearestUp = this.normal[1] ?? 0;
      }
    }
    return d;
  }
}
