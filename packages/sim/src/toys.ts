import type { BehaviourHost, Plan } from './behaviour.ts';
import { CURIOSITY } from './curiosity.ts';
import { FEEDING, feedingHeight } from './feeding.ts';
import type { FishResize } from './fishArrays.ts';
import { clamp, DEG, wrapAngle } from './math.ts';
import { FishState } from './snapshot.ts';
import type { SimSpecies } from './species.ts';

/** Every tunable of mirror and ball play; sources are in BEHAVIOUR.md. */
export const TOYS = {
  maxToys: 8,

  mirrorHalfWidthM: 0.06,
  mirrorHalfHeightM: 0.08,
  /** A mirror that moved or turned further than this between two `setToys` is a new one. */
  mirrorMovedM: 0.01,
  mirrorTurnedRad: 5 * DEG,
  mirrorLatencyMeanS: 25,
  mirrorLatencySdS: 16,
  mirrorLatencyMinS: 5,
  mirrorLatencyMaxS: 60,
  mirrorRetryS: 30,
  mirrorInterruptRetryS: 5,
  mirrorApproachS: 12,
  mirrorStandoffBodyLengths: 0.45,
  mirrorArriveBodyLengths: 0.75,
  mirrorLeaveBodyLengths: 2,
  frontalMeanS: 1.1,
  frontalMinS: 0.3,
  frontalMaxS: 4,
  lateralMinS: 1,
  lateralMaxS: 3,
  pauseMinS: 1,
  pauseMaxS: 4,
  pauseShare: 0.25,
  mirrorAttentionS: 600,
  mirrorRecoverTauS: 900,
  mirrorRecoverLevel: 0.3,
  /** Share of display intensity lost at full habituation. */
  habituatedIntensity: 0.6,
  displayTauS: 0.25,

  /** Fish at or below this boldness keep away from the ball; above it they may play. */
  shyBoldness: 0.3,
  /** Only species whose depth band reaches this high go up to a floating ball. */
  ballMinDepthHigh: 0.7,
  ballRadiusM: 0.02,
  ballMassKg: 0.0027,
  ballRestitution: 0.3,
  ballLatencyMinS: 1,
  ballLatencyMaxS: 6,
  ballRetryS: 20,
  ballApproachS: 15,
  ballPushBodyLengths: 1.5,
  ballPushS: 2,
  ballPushCruiseFactor: 1.2,
  ballBackOffMinS: 1,
  ballBackOffMaxS: 3,
  ballBackOffBodyLengths: 2,
  ballAttentionS: 60,
  ballRecoverTauS: 300,
  ballRecoverLevel: 0.3,
  ballShunBodyLengths: 3,
  ballShunWeight: 2,
} as const;

type Triple = readonly [number, number, number];

/**
 * A toy in the world's frame. A mirror's `position` is the centre of its glass and `normal` points
 * into the tank, horizontal; a ball's `position` is its centre and `velocity` its drift in m/s.
 */
export type SimToy =
  | { readonly kind: 'mirror'; readonly position: Triple; readonly normal: Triple }
  | { readonly kind: 'ball'; readonly position: Triple; readonly velocity: Triple };

/** A fish bumped a ball: the velocity change it gave it, m/s in the world's x and z. */
export interface ToyNudge {
  readonly fishId: string;
  /** Index of the ball in the toys last given to `setToys`. */
  readonly toy: number;
  readonly ix: number;
  readonly iz: number;
}

export const MirrorPhase = { Idle: 0, Approach: 1, Frontal: 2, Lateral: 3, Pause: 4 } as const;
export const BallPhase = { Idle: 0, Approach: 1, Push: 2, BackOff: 3 } as const;

interface Mirror {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
}

interface Ball {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  readonly index: number;
}

const DT = 1 / 30;
const NO_NUDGES: readonly ToyNudge[] = Object.freeze([]);

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

function triple(value: unknown, what: string): Triple {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new RangeError(`toys: ${what} must be a finite [x, y, z] array`);
  }
  return value as unknown as Triple;
}

function parseToys(toys: readonly SimToy[]): { mirrors: Mirror[]; balls: Ball[] } {
  if (!Array.isArray(toys)) throw new TypeError('toys: expected an array of toys');
  if (toys.length > TOYS.maxToys) {
    throw new RangeError(`toys: at most ${TOYS.maxToys} toys, got ${toys.length}`);
  }
  const mirrors: Mirror[] = [];
  const balls: Ball[] = [];
  toys.forEach((toy: SimToy, index) => {
    const kind: unknown = toy.kind;
    if (kind === 'mirror') {
      const [x, y, z] = triple(toy.position, `toy ${index} position`);
      const n = triple((toy as { normal: unknown }).normal, `toy ${index} normal`);
      const h = Math.hypot(n[0], n[2]);
      if (h < 1e-3) {
        throw new RangeError(`toys: mirror ${index} normal must point into the tank horizontally`);
      }
      mirrors.push({ x, y, z, nx: n[0] / h, nz: n[2] / h });
    } else if (kind === 'ball') {
      const [x, y, z] = triple(toy.position, `toy ${index} position`);
      const v = triple((toy as { velocity: unknown }).velocity, `toy ${index} velocity`);
      balls.push({ x, y, z, vx: v[0], vz: v[2], index });
    } else {
      throw new RangeError(`toys: toy ${index} has unknown kind ${JSON.stringify(kind)}`);
    }
  });
  return { mirrors, balls };
}

/**
 * Mirror and ball play. A fish that displays to rivals (a betta) takes its reflection for one:
 * after a latency it closes on the mirror, holds a short stand-off and displays in bouts, facing
 * with gill covers out or side-on with fins spread, until it habituates and leaves; it comes back
 * once the habituation has worn off. Bold, curious fish of the upper water now and then swim up to
 * a floating ball and bump it, which `takeNudges` reports; shy fish keep away from it.
 * `Behaviour` fills `eligible` and `leash` before every `update` and turns the phases into plans.
 * The RNG is drawn only while a toy is in view of a fish that would respond to it.
 */
export class Toys {
  private _eligible: Uint8Array;
  private _leash: Float64Array;
  private _mirrorPhase: Uint8Array;
  private mirrorToy: Int32Array;
  private mirrorTimer: Float64Array;
  private mirrorNotice: Float64Array;
  private mirrorLatency: Float64Array;
  private _mirrorHabituation: Float64Array;
  private lateralSign: Float64Array;
  private _ballPhase: Uint8Array;
  private ballToy: Int32Array;
  private ballTimer: Float64Array;
  private ballNotice: Float64Array;
  private _ballHabituation: Float64Array;

  private readonly host: BehaviourHost;
  private mirrors: readonly Mirror[] = [];
  private balls: readonly Ball[] = [];
  private readonly nudges: ToyNudge[] = [];

  /** 1 when the fish may take up a toy this step. */
  get eligible(): Uint8Array {
    return this._eligible;
  }

  /** Per fish x, y, z, radius of the area it will leave home for; radius Infinity for none. */
  get leash(): Float64Array {
    return this._leash;
  }

  /** Each fish's `MirrorPhase`. */
  get mirrorPhase(): Uint8Array {
    return this._mirrorPhase;
  }

  /** 0 to 1: how far each fish has tired of its reflection; it leaves at 1. */
  get mirrorHabituation(): Float64Array {
    return this._mirrorHabituation;
  }

  /** Each fish's `BallPhase`. */
  get ballPhase(): Uint8Array {
    return this._ballPhase;
  }

  get ballHabituation(): Float64Array {
    return this._ballHabituation;
  }

  get count(): number {
    return this.mirrors.length + this.balls.length;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._eligible = new Uint8Array(n);
    this._leash = new Float64Array(n * 4);
    this._mirrorPhase = new Uint8Array(n);
    this.mirrorToy = new Int32Array(n).fill(-1);
    this.mirrorTimer = new Float64Array(n);
    this.mirrorNotice = new Float64Array(n);
    this.mirrorLatency = new Float64Array(n).fill(-1);
    this._mirrorHabituation = new Float64Array(n);
    this.lateralSign = new Float64Array(n).fill(1);
    this._ballPhase = new Uint8Array(n);
    this.ballToy = new Int32Array(n).fill(-1);
    this.ballTimer = new Float64Array(n);
    this.ballNotice = new Float64Array(n);
    this._ballHabituation = new Float64Array(n);
  }

  resize(edit: FishResize): void {
    this._eligible = edit.array(this.eligible);
    this._leash = edit.array(this.leash, 4);
    this._mirrorPhase = edit.array(this.mirrorPhase);
    this.mirrorToy = edit.array(this.mirrorToy, 1, -1);
    this.mirrorTimer = edit.array(this.mirrorTimer);
    this.mirrorNotice = edit.array(this.mirrorNotice);
    this.mirrorLatency = edit.array(this.mirrorLatency, 1, -1);
    this._mirrorHabituation = edit.array(this.mirrorHabituation);
    this.lateralSign = edit.array(this.lateralSign, 1, 1);
    this._ballPhase = edit.array(this.ballPhase);
    this.ballToy = edit.array(this.ballToy, 1, -1);
    this.ballTimer = edit.array(this.ballTimer);
    this.ballNotice = edit.array(this.ballNotice);
    this._ballHabituation = edit.array(this.ballHabituation);
  }

  /**
   * Replaces the toys. Mirrors and balls are matched by their order among their own kind, so a
   * ball resent each tick as it drifts stays the one a fish is playing with. A fish whose mirror
   * was taken away, moved or turned, or whose ball is gone, stops at once; habituation stays.
   * Throws, changing nothing, on a malformed toy.
   */
  setToys(toys: readonly SimToy[]): void {
    const { mirrors, balls } = parseToys(toys);
    for (let i = 0; i < this.host.count; i++) {
      if (at(this.mirrorPhase, i) !== MirrorPhase.Idle) {
        const k = at(this.mirrorToy, i);
        const before = this.mirrors[k];
        const now = mirrors[k];
        if (before === undefined || now === undefined || moved(before, now)) {
          this.endMirror(i, 0, -1);
        }
      }
      if (at(this.ballPhase, i) !== BallPhase.Idle && at(this.ballToy, i) >= balls.length) {
        this.endBall(i, 0);
      }
    }
    if (mirrors.length === 0) {
      this.mirrorNotice.fill(0);
      this.mirrorLatency.fill(-1);
    }
    if (balls.length === 0) this.ballNotice.fill(0);
    this.mirrors = mirrors;
    this.balls = balls;
  }

  /** Whether fish `i` is busy with a toy. */
  engaged(i: number): boolean {
    return at(this.mirrorPhase, i) !== MirrorPhase.Idle || at(this.ballPhase, i) !== BallPhase.Idle;
  }

  /** The nudges given since the last call, in the order they happened. */
  takeNudges(): readonly ToyNudge[] {
    return this.nudges.length === 0 ? NO_NUDGES : this.nudges.splice(0);
  }

  /** Advances every fish's toy state; `occupied` marks fish busy with something else (a lure). */
  update(occupied: Uint8Array): void {
    const mirrorRecover = Math.exp(-DT / TOYS.mirrorRecoverTauS);
    const ballRecover = Math.exp(-DT / TOYS.ballRecoverTauS);
    for (let i = 0; i < this.host.count; i++) {
      const sp = this.speciesOf(i);
      if (sp.walking !== null) continue;
      const free = at(this.eligible, i) === 1 && at(occupied, i) !== 1;
      if (sp.flare) this.updateMirror(i, free, mirrorRecover);
      if (plays(sp)) this.updateBall(i, sp, free, ballRecover);
    }
  }

  private updateMirror(i: number, free: boolean, recover: number): void {
    const phase = at(this.mirrorPhase, i);
    if (phase === MirrorPhase.Idle) {
      this.mirrorHabituation[i] = at(this.mirrorHabituation, i) * recover;
      this.watchMirror(i, free);
      return;
    }
    const h = at(this.mirrorHabituation, i) + DT / TOYS.mirrorAttentionS;
    this.mirrorHabituation[i] = h;
    if (!free) {
      this.endMirror(i, -TOYS.mirrorInterruptRetryS, 0);
      return;
    }
    if (h >= 1) {
      this.endMirror(i, -TOYS.mirrorRetryS, -1);
      return;
    }
    const m = this.mirrors[at(this.mirrorToy, i)];
    if (m === undefined) {
      this.endMirror(i, 0, -1);
      return;
    }
    const left = at(this.mirrorTimer, i) - DT;
    this.mirrorTimer[i] = left;
    const length = at(this.host.bodyLength, i);
    const { dn, u, v } = this.offset(i, m);
    const arrival = (FEEDING.mouthBodyLengths + TOYS.mirrorStandoffBodyLengths) * length;
    const inFront =
      Math.abs(u) <= TOYS.mirrorHalfWidthM + 0.5 * length &&
      Math.abs(v) <= TOYS.mirrorHalfHeightM + 0.5 * length;
    if (phase === MirrorPhase.Approach) {
      if (inFront && dn > 0 && dn <= arrival + TOYS.mirrorArriveBodyLengths * length) {
        this.nextBout(i, MirrorPhase.Approach);
      } else if (left <= 0) {
        this.endMirror(i, -TOYS.mirrorRetryS, 0);
      }
      return;
    }
    if (!inFront || dn <= 0 || dn > arrival + TOYS.mirrorLeaveBodyLengths * length) {
      this._mirrorPhase[i] = MirrorPhase.Approach;
      this.mirrorTimer[i] = TOYS.mirrorApproachS;
      return;
    }
    if (left <= 0) this.nextBout(i, phase);
  }

  private watchMirror(i: number, free: boolean): void {
    const notice = at(this.mirrorNotice, i);
    if (notice < 0) {
      this.mirrorNotice[i] = Math.min(0, notice + DT);
      return;
    }
    if (!free || at(this.ballPhase, i) !== BallPhase.Idle) return;
    const k = this.mirrorInView(i);
    if (k < 0) return;
    const { rng } = this.host;
    let latency = at(this.mirrorLatency, i);
    if (latency < 0) {
      latency = clamp(
        TOYS.mirrorLatencyMeanS + TOYS.mirrorLatencySdS * rng.gaussian(),
        TOYS.mirrorLatencyMinS,
        TOYS.mirrorLatencyMaxS,
      );
      this.mirrorLatency[i] = latency;
    }
    const watched = notice + DT;
    this.mirrorNotice[i] = watched;
    if (watched < latency) return;
    if (at(this.mirrorHabituation, i) > TOYS.mirrorRecoverLevel) {
      this.mirrorNotice[i] = -TOYS.mirrorRetryS;
      return;
    }
    this._mirrorPhase[i] = MirrorPhase.Approach;
    this.mirrorToy[i] = k;
    this.mirrorTimer[i] = TOYS.mirrorApproachS;
    this.mirrorNotice[i] = 0;
  }

  /**
   * Bouts alternate: a frontal display (gill covers out) is followed by a lateral one (side-on,
   * fins spread), after which the fish displays head-on again or pauses, more often as it tires.
   */
  private nextBout(i: number, after: number): void {
    const { rng } = this.host;
    let next: number = MirrorPhase.Frontal;
    if (after === MirrorPhase.Frontal) next = MirrorPhase.Lateral;
    else if (after === MirrorPhase.Lateral) {
      const pause = TOYS.pauseShare + 0.5 * at(this.mirrorHabituation, i);
      next = rng.next() < pause ? MirrorPhase.Pause : MirrorPhase.Frontal;
    }
    let s: number;
    if (next === MirrorPhase.Frontal) {
      s = clamp(-TOYS.frontalMeanS * Math.log(1 - rng.next()), TOYS.frontalMinS, TOYS.frontalMaxS);
    } else if (next === MirrorPhase.Lateral) {
      s = rng.range(TOYS.lateralMinS, TOYS.lateralMaxS);
      this.lateralSign[i] = rng.next() < 0.5 ? -1 : 1;
    } else {
      s = rng.range(TOYS.pauseMinS, TOYS.pauseMaxS);
    }
    this._mirrorPhase[i] = next;
    this.mirrorTimer[i] = s;
  }

  /** `notice` is where the watch count restarts; `latency` 0 lets the fish re-engage at once. */
  private endMirror(i: number, notice: number, latency: number): void {
    this._mirrorPhase[i] = MirrorPhase.Idle;
    this.mirrorToy[i] = -1;
    this.mirrorNotice[i] = notice;
    this.mirrorLatency[i] = latency;
  }

  /**
   * The first mirror fish `i` can see: the nearest point of its glass within perception range and
   * view cone, the fish on its reflecting side, and the glass within its leash. A fish glimpsing
   * movement in it from the side closes in, and there meets its image.
   */
  private mirrorInView(i: number): number {
    const sp = this.speciesOf(i);
    const { forward } = this.host;
    const fov = Math.cos(sp.perceptionFov / 2);
    for (let k = 0; k < this.mirrors.length; k++) {
      const m = this.mirrors[k];
      if (m === undefined) continue;
      const { dn, u, v } = this.offset(i, m);
      if (dn <= 0) continue;
      const du = clamp(u, -TOYS.mirrorHalfWidthM, TOYS.mirrorHalfWidthM) - u;
      const dv = clamp(v, -TOYS.mirrorHalfHeightM, TOYS.mirrorHalfHeightM) - v;
      const d = Math.hypot(dn, du, dv);
      if (d > sp.perceptionRange) continue;
      if (!this.withinLeash(i, m.x, m.y, m.z)) continue;
      if (sp.perceptionFov < 2 * Math.PI) {
        const dx = -dn * m.nx + du * m.nz;
        const dz = -dn * m.nz - du * m.nx;
        const cos =
          (dx * at(forward, i * 3) + dv * at(forward, i * 3 + 1) + dz * at(forward, i * 3 + 2)) / d;
        if (cos < fov) continue;
      }
      return k;
    }
    return -1;
  }

  /** Fish `i` relative to mirror `m`: out from the glass, along it, and up. */
  private offset(i: number, m: Mirror): { dn: number; u: number; v: number } {
    const { position } = this.host;
    const rx = at(position, i * 3) - m.x;
    const rz = at(position, i * 3 + 2) - m.z;
    return {
      dn: rx * m.nx + rz * m.nz,
      u: rx * m.nz - rz * m.nx,
      v: at(position, i * 3 + 1) - m.y,
    };
  }

  /**
   * Holds a stand-off in front of the mirror, facing it, at the point of the glass opposite the
   * fish; on display it turns head-on or side-on to its image and barely moves.
   */
  planMirror(i: number, sp: SimSpecies, plan: Plan): boolean {
    const phase = at(this.mirrorPhase, i);
    if (phase === MirrorPhase.Idle) return false;
    const m = this.mirrors[at(this.mirrorToy, i)];
    if (m === undefined) return false;
    const { basin } = this.host;
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    const { u } = this.offset(i, m);
    // Aiming inside the edge keeps a fish coming in obliquely from parking off the glass's end.
    const span = Math.max(0, TOYS.mirrorHalfWidthM - 0.5 * length);
    const along = clamp(u, -span, span);
    const gx = m.x + m.nz * along;
    const gz = m.z - m.nx * along;
    const py = at(this.host.position, i * 3 + 1);
    const gy = feedingHeight(
      clamp(py, m.y - TOYS.mirrorHalfHeightM, m.y + TOYS.mirrorHalfHeightM),
      length,
      basin.ground(gx, gz),
      basin.maxY,
    );
    plan.align = 0;
    plan.cohesion = 0;
    plan.wander *= 0.2;
    plan.bandLo = Math.min(plan.bandLo, gy - length);
    plan.bandHi = Math.max(plan.bandHi, gy + length);
    plan.arrival = (FEEDING.mouthBodyLengths + TOYS.mirrorStandoffBodyLengths) * length;
    plan.speedFloor = 0;
    if (phase === MirrorPhase.Approach) {
      const sx = gx + m.nx * plan.arrival;
      const sz = gz + m.nz * plan.arrival;
      const d = Math.hypot(
        sx - at(this.host.position, i * 3),
        gy - py,
        sz - at(this.host.position, i * 3 + 2),
      );
      const speed = Math.min(FEEDING.pursuitSpeedFraction * vmax, 2 * cruise);
      plan.arrival = 0;
      plan.seek(sx, gy, sz, speed, 0.5);
      plan.speedCap = speed * clamp(d / (2 * length), 0.1, 1);
      return true;
    }
    plan.seek(gx, gy, gz, 0.5 * cruise, 0.5);
    plan.speedCap = 0.15 * cruise;
    plan.wander = 0;
    const facing = Math.atan2(-m.nx, -m.nz);
    const intensity = 1 - TOYS.habituatedIntensity * at(this.mirrorHabituation, i);
    if (phase === MirrorPhase.Pause) {
      plan.state = FishState.Station;
      plan.yaw = facing;
      return true;
    }
    plan.state = FishState.Display;
    if (phase === MirrorPhase.Frontal) {
      plan.yaw = facing;
      plan.display = 0.6 * intensity;
      plan.gillFlare = intensity;
    } else {
      plan.yaw = wrapAngle(facing + 0.5 * Math.PI * at(this.lateralSign, i));
      plan.display = intensity;
      plan.gillFlare = 0.3 * intensity;
    }
    return true;
  }

  private updateBall(i: number, sp: SimSpecies, free: boolean, recover: number): void {
    const phase = at(this.ballPhase, i);
    if (phase === BallPhase.Idle) {
      this.ballHabituation[i] = at(this.ballHabituation, i) * recover;
      this.watchBall(i, sp, free);
      return;
    }
    const h = at(this.ballHabituation, i) + DT / (TOYS.ballAttentionS * (0.5 + sp.curiosity));
    this.ballHabituation[i] = h;
    const b = this.balls[at(this.ballToy, i)];
    if (!free || b === undefined || !this.afloat(b)) {
      this.endBall(i, 0);
      return;
    }
    if (h >= 1) {
      this.endBall(i, -TOYS.ballRetryS);
      return;
    }
    const left = at(this.ballTimer, i) - DT;
    this.ballTimer[i] = left;
    if (phase === BallPhase.BackOff) {
      if (left > 0) return;
      if (this.host.rng.next() < sp.curiosity * (1 - h)) {
        this._ballPhase[i] = BallPhase.Approach;
        this.ballTimer[i] = TOYS.ballApproachS;
      } else {
        this.endBall(i, -TOYS.ballRetryS);
      }
      return;
    }
    if (this.touch(i, sp, b)) return;
    if (phase === BallPhase.Approach) {
      const length = at(this.host.bodyLength, i);
      if (this.toBall(i, b) <= TOYS.ballPushBodyLengths * length) {
        this._ballPhase[i] = BallPhase.Push;
        this.ballTimer[i] = TOYS.ballPushS;
      } else if (left <= 0) {
        this.endBall(i, -TOYS.ballRetryS);
      }
      return;
    }
    if (left <= 0) this.backOff(i);
  }

  private watchBall(i: number, sp: SimSpecies, free: boolean): void {
    const notice = at(this.ballNotice, i);
    if (notice < 0) {
      this.ballNotice[i] = Math.min(0, notice + DT);
      return;
    }
    if (!free || at(this.mirrorPhase, i) !== MirrorPhase.Idle) {
      this.ballNotice[i] = 0;
      return;
    }
    const k = this.ballInView(i, sp);
    if (k < 0) {
      this.ballNotice[i] = 0;
      return;
    }
    const watched = notice + DT;
    this.ballNotice[i] = watched;
    const latency =
      TOYS.ballLatencyMinS + (TOYS.ballLatencyMaxS - TOYS.ballLatencyMinS) * (1 - sp.curiosity);
    if (watched < latency) return;
    const interest = 0.5 * (sp.curiosity + sp.boldness);
    if (at(this.ballHabituation, i) > TOYS.ballRecoverLevel || this.host.rng.next() >= interest) {
      this.ballNotice[i] = -TOYS.ballRetryS;
      return;
    }
    this._ballPhase[i] = BallPhase.Approach;
    this.ballToy[i] = k;
    this.ballTimer[i] = TOYS.ballApproachS;
    this.ballNotice[i] = 0;
  }

  /**
   * A fish whose mouth reaches the ball bumps it: an inelastic collision of the fish's horizontal
   * velocity with the much lighter-than-water ball, the fish's momentum barely changed.
   */
  private touch(i: number, sp: SimSpecies, b: Ball): boolean {
    const { position, forward } = this.host;
    const length = at(this.host.bodyLength, i);
    const mouth = FEEDING.mouthBodyLengths * length;
    const px = at(position, i * 3);
    const pz = at(position, i * 3 + 2);
    const mx = px + at(forward, i * 3) * mouth;
    const my = at(position, i * 3 + 1) + at(forward, i * 3 + 1) * mouth;
    const mz = pz + at(forward, i * 3 + 2) * mouth;
    const reach = Math.hypot(b.x - mx, b.y - my, b.z - mz) - TOYS.ballRadiusM;
    if (reach > FEEDING.biteReachBodyLengths * length) return false;
    const hx = b.x - px;
    const hz = b.z - pz;
    const h = Math.hypot(hx, hz);
    if (h > 1e-9) {
      const ux = hx / h;
      const uz = hz / h;
      const v = at(this.host.speed, i);
      const closing =
        (at(forward, i * 3) * v - b.vx) * ux + (at(forward, i * 3 + 2) * v - b.vz) * uz;
      if (closing > 0) {
        const fishMass = sp.mass * (length / sp.bodyLength) ** 3;
        const share = (1 + TOYS.ballRestitution) * (fishMass / (fishMass + TOYS.ballMassKg));
        const fishId = this.host.fishIds[i];
        if (fishId === undefined) throw new RangeError(`no fish id at index ${i}`);
        this.nudges.push({
          fishId,
          toy: b.index,
          ix: share * closing * ux,
          iz: share * closing * uz,
        });
      }
    }
    this.backOff(i);
    return true;
  }

  private backOff(i: number): void {
    this._ballPhase[i] = BallPhase.BackOff;
    this.ballTimer[i] = this.host.rng.range(TOYS.ballBackOffMinS, TOYS.ballBackOffMaxS);
  }

  private endBall(i: number, notice: number): void {
    this._ballPhase[i] = BallPhase.Idle;
    this.ballToy[i] = -1;
    this.ballNotice[i] = notice;
  }

  /** The nearest floating ball fish `i` sees within reach, or -1. */
  private ballInView(i: number, sp: SimSpecies): number {
    const { position, forward } = this.host;
    const fov = Math.cos(sp.perceptionFov / 2);
    let best = -1;
    let bestD = sp.perceptionRange;
    for (let k = 0; k < this.balls.length; k++) {
      const b = this.balls[k];
      if (b === undefined || !this.afloat(b) || !this.withinLeash(i, b.x, b.y, b.z)) continue;
      const dx = b.x - at(position, i * 3);
      const dy = b.y - at(position, i * 3 + 1);
      const dz = b.z - at(position, i * 3 + 2);
      const d = Math.hypot(dx, dy, dz);
      if (d > bestD) continue;
      if (d > 1e-9 && sp.perceptionFov < 2 * Math.PI) {
        const cos =
          (dx * at(forward, i * 3) + dy * at(forward, i * 3 + 1) + dz * at(forward, i * 3 + 2)) / d;
        if (cos < fov) continue;
      }
      best = k;
      bestD = d;
    }
    return best;
  }

  /** How far fish `i` is from where it would hold its mouth under ball `b`. */
  private toBall(i: number, b: Ball): number {
    const { basin, position } = this.host;
    const length = at(this.host.bodyLength, i);
    const ty = feedingHeight(b.y, length, basin.ground(b.x, b.z), basin.maxY);
    return Math.hypot(
      b.x - at(position, i * 3),
      ty - at(position, i * 3 + 1),
      b.z - at(position, i * 3 + 2),
    );
  }

  /** In the water: its underside below the surface, and over the tank's footprint. */
  private afloat(b: Ball): boolean {
    const { basin } = this.host;
    return (
      b.y - TOYS.ballRadiusM < basin.maxY &&
      b.x >= basin.minX &&
      b.x <= basin.maxX &&
      b.z >= basin.minZ &&
      b.z <= basin.maxZ
    );
  }

  /**
   * Swims up under the ball at the surface, then pushes into it at a steady pace; after a bump it
   * turns away for a moment before it decides whether to come back.
   */
  planBall(i: number, sp: SimSpecies, plan: Plan): boolean {
    const phase = at(this.ballPhase, i);
    if (phase === BallPhase.Idle) return false;
    const b = this.balls[at(this.ballToy, i)];
    if (b === undefined) return false;
    const { basin, position } = this.host;
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    const px = at(position, i * 3);
    const pz = at(position, i * 3 + 2);
    const ty = feedingHeight(b.y, length, basin.ground(b.x, b.z), basin.maxY);
    const d = this.toBall(i, b);
    plan.align *= CURIOSITY.lureSchoolFactor;
    plan.cohesion *= CURIOSITY.lureSchoolFactor;
    plan.wander *= 0.3;
    plan.bandLo = Math.min(plan.bandLo, ty - length);
    plan.bandHi = Math.max(plan.bandHi, ty + length);
    if (d < 2 * length) plan.comfort = FEEDING.approachComfort;
    if (phase === BallPhase.BackOff) {
      const hx = px - b.x;
      const hz = pz - b.z;
      const h = Math.hypot(hx, hz);
      const away = TOYS.ballBackOffBodyLengths * length;
      const ux = h > 1e-9 ? hx / h : -at(this.host.forward, i * 3);
      const uz = h > 1e-9 ? hz / h : -at(this.host.forward, i * 3 + 2);
      plan.seek(b.x + ux * away, ty, b.z + uz * away, cruise, 0.5);
      return true;
    }
    if (phase === BallPhase.Approach) {
      const speed = Math.min(FEEDING.pursuitSpeedFraction * vmax, cruise * (1 + sp.curiosity));
      plan.seek(b.x, ty, b.z, speed, 0.5);
      plan.speedFloor = 0;
      if (d < 2 * length) plan.speedCap = cruise;
      return true;
    }
    const push = Math.min(vmax, TOYS.ballPushCruiseFactor * cruise);
    plan.continuous = true;
    plan.wander = 0;
    plan.seek(b.x, ty, b.z, push, 0.25);
    plan.speedFloor = 0.5 * push;
    return true;
  }

  /** A shy fish near a floating ball keeps it at a distance. */
  shun(i: number, sp: SimSpecies, plan: Plan): void {
    if (this.balls.length === 0 || sp.walking !== null || sp.boldness > TOYS.shyBoldness) return;
    const { position } = this.host;
    const r = TOYS.ballShunBodyLengths * at(this.host.bodyLength, i) + TOYS.ballRadiusM;
    let best: Ball | null = null;
    let bestD = r;
    for (const b of this.balls) {
      if (!this.afloat(b)) continue;
      const d = Math.hypot(
        b.x - at(position, i * 3),
        b.y - at(position, i * 3 + 1),
        b.z - at(position, i * 3 + 2),
      );
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best !== null) plan.shun(best.x, best.y, best.z, r, TOYS.ballShunWeight);
  }

  private withinLeash(i: number, x: number, y: number, z: number): boolean {
    const o = i * 4;
    const r = at(this.leash, o + 3);
    if (r === Infinity) return true;
    return (
      Math.hypot(x - at(this.leash, o), y - at(this.leash, o + 1), z - at(this.leash, o + 2)) <= r
    );
  }

  private speciesOf(i: number): SimSpecies {
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp === undefined) throw new RangeError(`no fish at index ${i}`);
    return sp;
  }
}

/** Bold enough to approach a novel object, and living high enough to reach one at the surface. */
function plays(sp: SimSpecies): boolean {
  return sp.boldness > TOYS.shyBoldness && sp.depthHigh >= TOYS.ballMinDepthHigh;
}

function moved(a: Mirror, b: Mirror): boolean {
  return (
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > TOYS.mirrorMovedM ||
    a.nx * b.nx + a.nz * b.nz < Math.cos(TOYS.mirrorTurnedRad)
  );
}
