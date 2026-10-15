import { FishState } from '@aquarium/sim';

/**
 * Shrimp appendage kinematics. Decapods walk with a metachronal wave running from the rear pair
 * forwards, the two legs of a pair in antiphase, and each foot on the ground for about two thirds
 * of the cycle (Clarac & Cruse 1982 for crayfish; Neocaridina is not measured, so the shares and
 * angles are estimates by eye from aquarium footage). Every rate below is a multiple of one
 * appendage clock, so the instance buffer carries a single phase for them all.
 */
export const WALK_GAIT = {
  /** Share of the leg cycle a foot stays planted. */
  dutyFactor: 0.65,
  /** Phase lag of each pair behind the one behind it, in cycles. */
  pairLag: 0.18,
  /** Fore-aft swing of a walking leg about its hip, either way of rest, radians. */
  sweep: 0.3,
  /** Hip roll that lifts the foot during its swing, radians. */
  lift: 0.35,
  /** The first two pairs are chelipeds, which pick at the surface instead of stepping. */
  chelipedPairs: 2,
  /** Cheliped pitch towards the mouth at full picking, radians. */
  pickPitch: 0.45,
  /** Antenna tip sway at rest and at full display, in body lengths. */
  antennaSway: 0.025,
  antennaDisplaySway: 0.08,
  /** Pleopod tip excursion idling (fanning water over the gills) and paddling, in body lengths. */
  pleopodFan: 0.006,
  pleopodPaddle: 0.022,
  /** Phase lag between neighbouring pleopod pairs, rear pair first, radians. */
  pleopodLag: 0.9,
} as const;

/** Rates in multiples of APPENDAGE_HZ; each times APPENDAGE_WRAP_CYCLES must be whole. */
export const APPENDAGE_RATE = { pick: 3, pleopod: 5, antenna: 0.7 } as const;
export const APPENDAGE_HZ = 1;
/** The clock wraps after this many cycles, where every rate above completes whole cycles too. */
export const APPENDAGE_WRAP_CYCLES = 10;

/** Peak ventral flexion of the abdomen at the telson in a tail flip, radians. */
export const MAX_TAIL_CURL = 1.4;
/** Flip progress at which the abdomen is fully flexed; the rest of the flip extends it again. */
export const TAIL_CURL_PEAK = 0.3;
/** Walking speed (body lengths per second) from which the legs take full strides. */
export const FULL_STRIDE_BODY_LENGTHS_PER_S = 0.2;
/** Share of full picking a standing or walking shrimp keeps up anyway: they graze constantly. */
export const PICK_IDLE = 0.3;
const STRIDE_SETTLE_S = 0.15;
const PADDLE_START_S = 0.05;
const PADDLE_STOP_S = 0.4;
const PICK_SETTLE_S = 0.3;
const DANCE_SETTLE_S = 0.5;
const TAU = Math.PI * 2;

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Ventral abdomen flexion (radians at the telson) at a tail flip's progress, 0 outside a flip. */
export function tailCurl(progress: number): number {
  if (!(progress > 0) || progress >= 1) return 0;
  const flex =
    progress < TAIL_CURL_PEAK
      ? smooth01(progress / TAIL_CURL_PEAK)
      : 1 - smooth01((progress - TAIL_CURL_PEAK) / (1 - TAIL_CURL_PEAK));
  return MAX_TAIL_CURL * flex;
}

/** A model-space point on the curling tail and the share of the flexion it turns by. */
export interface TailTip {
  readonly y: number;
  readonly z: number;
  readonly share: number;
}

/** What `curlAboveFloor` needs of a walker's model, in model units. */
export interface TailRig {
  readonly hinge: { readonly y: number; readonly z: number };
  readonly tip: TailTip;
  readonly bodyLength: number;
}

/** Gap kept between the tail tip and the substrate, in body lengths. */
export const TAIL_FLOOR_CLEARANCE_BODY_LENGTHS = 0.01;
const CURL_MARCH_STEPS = 8;
const CURL_BISECTIONS = 12;

/**
 * The tip at ventral flexion `curl`, turned about the hinge as the material turns it: positive
 * flexion is a negative turn about +x.
 */
export function curledTip(
  rig: TailRig,
  curl: number,
  out: { y: number; z: number } = { y: 0, z: 0 },
): { y: number; z: number } {
  const { hinge, tip } = rig;
  const a = -curl * tip.share;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dy = tip.y - hinge.y;
  const dz = tip.z - hinge.z;
  out.y = hinge.y + dy * c - dz * s;
  out.z = hinge.z + dy * s + dz * c;
  return out;
}

type Quat = { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
type Point = { readonly x: number; readonly y: number; readonly z: number };

const tipScratch = { y: 0, z: 0 };

function floorUnderTip(
  curl: number,
  rig: TailRig,
  scale: number,
  position: Point,
  quaternion: Quat,
  floorAt: (x: number, z: number, fromY: number) => number,
): number {
  const { x, y, z, w } = quaternion;
  const t = curledTip(rig, curl, tipScratch);
  const tx = position.x + scale * (2 * (x * y - w * z) * t.y + 2 * (x * z + w * y) * t.z);
  const tz = position.z + scale * (2 * (y * z + w * x) * t.y + (1 - 2 * (x * x + y * y)) * t.z);
  return floorAt(tx, tz, position.y);
}

function tipClearance(
  curl: number,
  rig: TailRig,
  scale: number,
  bodyY: number,
  upFromY: number,
  upFromZ: number,
  floor: number,
): number {
  const t = curledTip(rig, curl, tipScratch);
  return bodyY + scale * (upFromY * t.y + upFromZ * t.z) - floor;
}

/**
 * The floor the tail tip sweeps over in a flexion up to `curl`: the higher of `floorAt` under the
 * tip at rest and at full `curl`. `floorAt(x, z, fromY)` looks down from the body's height, so a
 * walker on a rock gets the rock top and one beside it the sand.
 */
export function floorUnderTail(
  curl: number,
  rig: TailRig,
  scale: number,
  position: Point,
  quaternion: Quat,
  floorAt: (x: number, z: number, fromY: number) => number,
): number {
  return Math.max(
    floorUnderTip(0, rig, scale, position, quaternion, floorAt),
    floorUnderTip(curl, rig, scale, position, quaternion, floorAt),
  );
}

/**
 * The largest flexion up to `curl` that keeps the tail tip above `floorY`, for a walker at
 * `position` turned by `quaternion` and scaled by `scale`. The sim lets go of the surface as a
 * flip starts, but the abdomen peaks within its first third, while the body is still only
 * millimetres up, so the full curl would sweep the tail fan through the sand. A tip already below
 * the floor at rest is only kept from sinking further.
 */
export function curlAboveFloor(
  curl: number,
  rig: TailRig,
  scale: number,
  position: { readonly y: number },
  quaternion: Quat,
  floorY: number,
): number {
  if (!(curl > 0)) return curl;
  const { x, y, z, w } = quaternion;
  const upFromY = 1 - 2 * (x * x + z * z);
  const upFromZ = 2 * (y * z - w * x);
  const floor = floorY + TAIL_FLOOR_CLEARANCE_BODY_LENGTHS * rig.bodyLength * scale;
  const limit = Math.min(tipClearance(0, rig, scale, position.y, upFromY, upFromZ, floor), 0);
  let clear = 0;
  for (let k = 1; k <= CURL_MARCH_STEPS; k++) {
    const c = (curl * k) / CURL_MARCH_STEPS;
    if (tipClearance(c, rig, scale, position.y, upFromY, upFromZ, floor) < limit) {
      let blocked = c;
      for (let i = 0; i < CURL_BISECTIONS; i++) {
        const mid = (clear + blocked) / 2;
        if (tipClearance(mid, rig, scale, position.y, upFromY, upFromZ, floor) < limit)
          blocked = mid;
        else clear = mid;
      }
      return clear;
    }
    clear = c;
  }
  return curl;
}

/**
 * A leg's swing at `u` (its own cycle phase, 0..1): `sweep` runs +1 (forward) to -1 while the foot
 * is planted and back while it swings; `lift` rises to 1 mid-swing. The material evaluates the
 * same curve on the GPU.
 */
export function legSwing(u: number): { sweep: number; lift: number } {
  const beta = WALK_GAIT.dutyFactor;
  const t = u - Math.floor(u);
  if (t < beta) return { sweep: 1 - (2 * t) / beta, lift: 0 };
  const v = (t - beta) / (1 - beta);
  return { sweep: -1 + 2 * smooth01(v), lift: Math.sin(Math.PI * v) };
}

/** The leg cycle phase of limb `leg` (pair * 2 + side) at the body's leg phase. */
export function legCyclePhase(legPhase: number, leg: number): number {
  const pair = Math.floor(leg / 2);
  const side = leg % 2;
  const u = legPhase - pair * WALK_GAIT.pairLag + side * 0.5;
  return u - Math.floor(u);
}

export interface WalkSample {
  speed: number;
  state: number;
  /** The sim's interpolated snapshot fields; see `SnapshotField`. */
  legPhase: number;
  flip: number;
  attached: number;
}

/**
 * Per-shrimp appendage state. The sim owns the leg phase and the flip; this only eases the
 * weights that switch with the sim's discrete state, so a leg never snaps between poses.
 */
export class WalkState {
  clock: number;
  legPhase = 0;
  curl = 0;
  stride = 0;
  paddle = 0;
  pick = PICK_IDLE;
  dance = 0;

  constructor(
    readonly length: number,
    phaseOffset: number,
  ) {
    if (!(length > 0)) throw new RangeError(`walk: body length must be > 0, got ${length}`);
    this.clock = phaseOffset % (TAU * APPENDAGE_WRAP_CYCLES);
  }

  advance(dt: number, sample: WalkSample): void {
    if (!(dt >= 0)) throw new RangeError(`walk: dt must be >= 0, got ${dt}`);
    this.clock = (this.clock + TAU * APPENDAGE_HZ * dt) % (TAU * APPENDAGE_WRAP_CYCLES);
    this.legPhase = sample.legPhase - Math.floor(sample.legPhase);
    this.curl = tailCurl(sample.flip);
    const attached = sample.attached >= 0.5;
    const pace = Math.max(sample.speed, 0) / this.length / FULL_STRIDE_BODY_LENGTHS_PER_S;
    const ease = (from: number, to: number, tau: number): number =>
      from + (to - from) * (1 - Math.exp(-dt / tau));
    this.stride = ease(this.stride, attached ? smooth01(pace) : 0, STRIDE_SETTLE_S);
    this.paddle = ease(this.paddle, attached ? 0 : 1, attached ? PADDLE_STOP_S : PADDLE_START_S);
    const pickTarget = !attached ? 0 : sample.state === FishState.Pick ? 1 : PICK_IDLE;
    this.pick = ease(this.pick, pickTarget, PICK_SETTLE_S);
    this.dance = ease(this.dance, sample.state === FishState.Dance ? 1 : 0, DANCE_SETTLE_S);
  }
}
