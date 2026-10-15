import type { Species } from '@aquarium/shared';
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
 * `floorY` is the substrate height under `from`. Its height never increases with `t`.
 */
export function sinkingCarcass(
  t: number,
  from: CarcassStart,
  length: number,
  seed: number,
  floorY: number,
  out: CarcassPose,
): void {
  const s = Math.max(0, t);
  const vt = sinkSpeed(length);
  const tau = sinkTimeConstant(length);
  const restY = carcassRestY(from, length, seed, floorY);
  const drop = from.y - restY;
  const landS = fallTime(drop, vt, tau);
  const settled = s >= landS;
  out.x = from.x;
  out.z = from.z;
  out.y = settled ? restY : Math.max(restY, from.y - fallen(s, vt, tau));
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
