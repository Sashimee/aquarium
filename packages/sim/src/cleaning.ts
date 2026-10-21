import type { BehaviourHost, Plan } from './behaviour.ts';
import { BEHAVIOUR } from './behaviour.ts';
import type { DecorBounds } from './decor.ts';
import type { FishResize } from './fishArrays.ts';
import { clamp, DEG } from './math.ts';
import { FishState } from './snapshot.ts';
import type { SimSpecies } from './species.ts';

/** Every tunable of the cleaning station; sources are in BEHAVIOUR.md. */
export const CLEANING = {
  visitMeanIntervalS: 300,
  visitMinIntervalS: 30,
  /** A client of this length visits at the mean interval; bigger ones come more often. */
  visitReferenceLengthM: 0.1,
  visitSizeFactorMin: 0.5,
  visitSizeFactorMax: 2,
  retryMinS: 10,
  retryMaxS: 30,
  inspectMinS: 8,
  inspectMaxS: 25,
  maxQueue: 3,
  giveUpS: 60,
  approachGiveUpS: 20,

  stationStandoffBodyLengths: 1,
  stationRadiusBodyLengths: 0.75,
  stationBearings: 16,
  stationLevels: 4,
  /** Share of a feature's height, down from its top, that the station may sit beside. */
  stationFlankShare: 0.6,
  stationSpacingBodyLengths: 2,

  poseGapBodyLengths: 0.25,
  poseArriveBodyLengths: 0.5,
  /** A small client is close enough within this many cleaner lengths of its spot. */
  poseArriveCleanerBodyLengths: 0.5,
  poseSpeedFactor: 0.1,
  posePitchRad: 35 * DEG,
  poseDisplay: 0.8,
  poseGillFlare: 0.6,
  queueBodyLengths: 3,
  queueSchoolFactor: 0.3,

  contactAlong: [0.32, 0.18, 0.02, -0.15, -0.32, -0.42],
  /** The cleaner's snout is 0.38 body lengths ahead of its centre; the rest is water. */
  contactGapBodyLengths: 0.5,
  contactArriveBodyLengths: 0.15,
  /** Height over the client's centre of a point above its back, as client body lengths. */
  dorsalBodyLengths: 0.3,
  dorsalGapBodyLengths: 0.3,
  sideSwitchChance: 0.3,
  /** Half the client's body axis the cleaner keeps off, as client body lengths. */
  bodyAxisBodyLengths: 0.45,
  bodyShunShare: 1,
  bodyShunWeight: 4,
  contactHoldMinS: 0.3,
  contactHoldMaxS: 1.2,
  dartSpeedFraction: 0.25,
  dartTauS: 0.4,
  holdSpeedFactor: 0.1,
  dartTimeoutS: 1.5,
} as const;

/** What a client is doing about cleaning. */
export const VisitPhase = { None: 0, Queued: 1, Posing: 2 } as const;
const Contact = { None: 0, Dart: 1, Hold: 2 } as const;

const DT = 1 / 30;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * How a species poses for a cleaner. Posture is species-specific (Côté et al. 1998), and the
 * content has no field for it, so it is fixed per species id: -1 head-down, 1 head-up, 0 level.
 */
export function poseOf(speciesId: string): -1 | 0 | 1 {
  let h = 2166136261;
  for (let k = 0; k < speciesId.length; k++) {
    h ^= speciesId.charCodeAt(k);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const r = h % 3;
  return r === 0 ? -1 : r === 1 ? 1 : 0;
}

/**
 * Cleaner fish (`cleaner` trait on a swimmer) hold a station by the most prominent rock and pick
 * parasites off visiting clients. Each other swimmer visits now and then, joins the queue of the
 * nearest open station, poses beside it with fins spread and gill covers out, and is inspected
 * with short darts while it holds still; a cleaner serves one client at a time, first come first
 * served. Anything that stops a fish feeding (a startle, food, rest at night) ends its visit, and
 * a cleaner busy with any of it closes its station. `Behaviour` fills `eligible` and `open` before
 * every `update` and asks `plan` for the plans. The RNG is drawn only while a tank holds a
 * cleaner, so a tank without one runs as it did before cleaning existed.
 */
export class Cleaning {
  private _eligible: Uint8Array;
  private _open: Uint8Array;
  private _phase: Uint8Array;
  private _cleanerOf: Int32Array;
  private _serving: Int32Array;
  private ticket: Float64Array;
  private nextVisit: Float64Array;
  private waitLeft: Float64Array;
  private inspectLeft: Float64Array;
  private _arrived: Uint8Array;
  private poseYaw: Float64Array;
  private contact: Uint8Array;
  private contactTimer: Float64Array;
  private contactAlong: Float64Array;
  private contactSide: Float64Array;
  private _station: Float64Array;
  private stationOut: Float64Array;

  private readonly host: BehaviourHost;
  private dirty = true;
  private tickets = 0;
  private cleaners = 0;
  private readonly n3 = new Float64Array(3);
  private readonly p3 = new Float64Array(3);

  /** 1 when the fish may visit, or go on with a visit, this step. */
  get eligible(): Uint8Array {
    return this._eligible;
  }

  /** Per cleaner, 1 when it is free to clean this step. */
  get open(): Uint8Array {
    return this._open;
  }

  /** Per client, its `VisitPhase`. */
  get phase(): Uint8Array {
    return this._phase;
  }

  /** Per client in a visit, the cleaner whose station it is at; -1 otherwise. */
  get cleanerOf(): Int32Array {
    return this._cleanerOf;
  }

  /** Per cleaner, the client it is serving; -1 when none. */
  get serving(): Int32Array {
    return this._serving;
  }

  /** Per client, 1 while it is holding its pose at the station. */
  get arrived(): Uint8Array {
    return this._arrived;
  }

  /** Per cleaner, its station point, x, y, z. */
  get station(): Float64Array {
    return this._station;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._eligible = new Uint8Array(n);
    this._open = new Uint8Array(n);
    this._phase = new Uint8Array(n);
    this._cleanerOf = new Int32Array(n).fill(-1);
    this._serving = new Int32Array(n).fill(-1);
    this.ticket = new Float64Array(n);
    this.nextVisit = new Float64Array(n).fill(NaN);
    this.waitLeft = new Float64Array(n);
    this.inspectLeft = new Float64Array(n);
    this._arrived = new Uint8Array(n);
    this.poseYaw = new Float64Array(n).fill(NaN);
    this.contact = new Uint8Array(n);
    this.contactTimer = new Float64Array(n);
    this.contactAlong = new Float64Array(n);
    this.contactSide = new Float64Array(n);
    this._station = new Float64Array(n * 3);
    this.stationOut = new Float64Array(n * 3);
  }

  /** A client that leaves ends its visit; a cleaner that leaves sends its clients away. */
  resize(edit: FishResize): void {
    if (edit.removed >= 0) {
      const r = edit.removed;
      const served = at(this._serving, r);
      if (served >= 0) this.end(served, false);
      for (let j = 0; j < edit.count; j++) {
        if (at(this._cleanerOf, j) === r) this.end(j, false);
      }
      const c = at(this._cleanerOf, r);
      if (c >= 0 && at(this._serving, c) === r) this._serving[c] = -1;
    }
    this._eligible = edit.array(this._eligible);
    this._open = edit.array(this._open);
    this._phase = edit.array(this._phase);
    this._cleanerOf = edit.array(this._cleanerOf, 1, -1);
    this._serving = edit.array(this._serving, 1, -1);
    edit.remap(this._cleanerOf);
    edit.remap(this._serving);
    this.ticket = edit.array(this.ticket);
    this.nextVisit = edit.array(this.nextVisit, 1, NaN);
    this.waitLeft = edit.array(this.waitLeft);
    this.inspectLeft = edit.array(this.inspectLeft);
    this._arrived = edit.array(this._arrived);
    this.poseYaw = edit.array(this.poseYaw, 1, NaN);
    this.contact = edit.array(this.contact);
    this.contactTimer = edit.array(this.contactTimer);
    this.contactAlong = edit.array(this.contactAlong);
    this.contactSide = edit.array(this.contactSide);
    this._station = edit.array(this._station, 3);
    this.stationOut = edit.array(this.stationOut, 3);
    this.dirty = true;
  }

  /** Hard decor changed: every station is chosen again. */
  decorMoved(): void {
    this.dirty = true;
  }

  isCleaner(i: number): boolean {
    return this.speciesOf(i).cleaner;
  }

  /** In a visit, queued or posing. */
  visiting(i: number): boolean {
    return at(this._phase, i) !== VisitPhase.None;
  }

  /** A fish a territorial owner lets be: a cleaner, or a client at a station. */
  tolerated(i: number): boolean {
    return this.isCleaner(i) || this.visiting(i);
  }

  update(): void {
    const n = this.host.count;
    let cleaners = 0;
    for (let i = 0; i < n; i++) if (this.isCleaner(i)) cleaners++;
    this.cleaners = cleaners;
    if (cleaners === 0) return;
    if (this.dirty) {
      this.dirty = false;
      this.chooseStations();
    }
    // Scheduling first: a visit ended below draws its next interval, which must not start
    // running down until the next step, or the minimum interval falls one step short.
    let anyOpen = false;
    for (let c = 0; c < n; c++) if (this.isCleaner(c) && at(this._open, c) === 1) anyOpen = true;
    if (anyOpen) this.schedule();
    for (let c = 0; c < n; c++) {
      if (this.isCleaner(c) && at(this._open, c) === 0) this.close(c);
    }
    for (let i = 0; i < n; i++) {
      const phase = at(this._phase, i);
      if (phase === VisitPhase.None) continue;
      if (at(this._eligible, i) === 0) {
        this.end(i, true);
        continue;
      }
      if (phase === VisitPhase.Queued || at(this._arrived, i) === 0) {
        const left = at(this.waitLeft, i) - DT;
        this.waitLeft[i] = left;
        if (left <= 0) this.end(i, true);
      }
    }
    for (let c = 0; c < n; c++) {
      if (this.isCleaner(c) && at(this._open, c) === 1) this.serve(c);
    }
  }

  private schedule(): void {
    const { rng } = this.host;
    for (let i = 0; i < this.host.count; i++) {
      if (at(this._phase, i) !== VisitPhase.None || at(this._eligible, i) === 0) continue;
      let left = at(this.nextVisit, i);
      if (Number.isNaN(left)) left = this.drawInterval(i);
      left -= DT;
      if (left > 0) {
        this.nextVisit[i] = left;
        continue;
      }
      const c = this.pickStation(i);
      if (c < 0) {
        this.nextVisit[i] = rng.range(CLEANING.retryMinS, CLEANING.retryMaxS);
        continue;
      }
      this._phase[i] = VisitPhase.Queued;
      this._cleanerOf[i] = c;
      this.ticket[i] = this.tickets++;
      this.waitLeft[i] = CLEANING.giveUpS;
      this._arrived[i] = 0;
      this.poseYaw[i] = NaN;
    }
  }

  /** Exponential, so visits are a Poisson process, floored so one visit does not follow another. */
  private drawInterval(i: number): number {
    const size = clamp(
      CLEANING.visitReferenceLengthM / at(this.host.bodyLength, i),
      CLEANING.visitSizeFactorMin,
      CLEANING.visitSizeFactorMax,
    );
    const mean = CLEANING.visitMeanIntervalS * size;
    return Math.max(CLEANING.visitMinIntervalS, -mean * Math.log(1 - this.host.rng.next()));
  }

  /** The open station with the shortest queue, then the nearest; -1 when every queue is full. */
  private pickStation(i: number): number {
    const { position } = this.host;
    let best = -1;
    let bestQueue = Infinity;
    let bestD = Infinity;
    for (let c = 0; c < this.host.count; c++) {
      if (!this.isCleaner(c) || at(this._open, c) === 0) continue;
      const queue = this.queueLength(c);
      if (queue >= CLEANING.maxQueue) continue;
      const d = Math.hypot(
        at(this._station, c * 3) - at(position, i * 3),
        at(this._station, c * 3 + 1) - at(position, i * 3 + 1),
        at(this._station, c * 3 + 2) - at(position, i * 3 + 2),
      );
      if (queue < bestQueue || (queue === bestQueue && d < bestD)) {
        best = c;
        bestQueue = queue;
        bestD = d;
      }
    }
    return best;
  }

  /** Clients waiting at cleaner `c`'s station, not counting the one being served. */
  queueLength(c: number): number {
    let k = 0;
    for (let j = 0; j < this.host.count; j++) {
      if (at(this._cleanerOf, j) === c && at(this._phase, j) === VisitPhase.Queued) k++;
    }
    return k;
  }

  private serve(c: number): void {
    let s = at(this._serving, c);
    if (s >= 0 && at(this._phase, s) !== VisitPhase.Posing) {
      this._serving[c] = -1;
      s = -1;
    }
    if (s < 0) {
      let first = -1;
      for (let j = 0; j < this.host.count; j++) {
        if (at(this._cleanerOf, j) !== c || at(this._phase, j) !== VisitPhase.Queued) continue;
        if (first < 0 || at(this.ticket, j) < at(this.ticket, first)) first = j;
      }
      if (first < 0) return;
      s = first;
      this._phase[s] = VisitPhase.Posing;
      this._serving[c] = s;
      this.waitLeft[s] = CLEANING.approachGiveUpS;
      this.inspectLeft[c] = this.host.rng.range(CLEANING.inspectMinS, CLEANING.inspectMaxS);
      this.contact[c] = Contact.None;
    }
    const p = this.p3;
    this.posePoint(s, c, p);
    const ls = at(this.host.bodyLength, s);
    const d = Math.hypot(
      at(p, 0) - at(this.host.position, s * 3),
      at(p, 1) - at(this.host.position, s * 3 + 1),
      at(p, 2) - at(this.host.position, s * 3 + 2),
    );
    const arrive = Math.max(
      CLEANING.poseArriveBodyLengths * ls,
      CLEANING.poseArriveCleanerBodyLengths * at(this.host.bodyLength, c),
    );
    if (d < arrive) this._arrived[s] = 1;
    else if (d > 2 * arrive) this._arrived[s] = 0;
    if (at(this._arrived, s) === 0) return;
    const left = at(this.inspectLeft, c) - DT;
    this.inspectLeft[c] = left;
    if (left <= 0) this.end(s, true);
  }

  /** Sends away the client being served and every queued one. */
  private close(c: number): void {
    for (let j = 0; j < this.host.count; j++) {
      if (at(this._cleanerOf, j) === c) this.end(j, true);
    }
    this._serving[c] = -1;
    this.contact[c] = Contact.None;
  }

  /** Ends client `i`'s visit; `redraw` draws its next one, else it draws one when next free. */
  private end(i: number, redraw: boolean): void {
    const c = at(this._cleanerOf, i);
    if (c >= 0 && at(this._serving, c) === i) {
      this._serving[c] = -1;
      this.contact[c] = Contact.None;
    }
    this._phase[i] = VisitPhase.None;
    this._cleanerOf[i] = -1;
    this._arrived[i] = 0;
    this.poseYaw[i] = NaN;
    this.nextVisit[i] = redraw ? this.drawInterval(i) : NaN;
  }

  /** Writes plan `plan` for a cleaner at work or a client in a visit; false for anyone else. */
  plan(i: number, sp: SimSpecies, plan: Plan): boolean {
    if (this.cleaners === 0) return false;
    if (sp.cleaner) {
      if (at(this._open, i) === 0) return false;
      this.planCleaner(i, plan);
      return true;
    }
    const phase = at(this._phase, i);
    if (phase === VisitPhase.None) return false;
    if (phase === VisitPhase.Queued) this.planQueued(i, plan);
    else this.planPose(i, sp, plan);
    return true;
  }

  private planQueued(i: number, plan: Plan): void {
    const c = at(this._cleanerOf, i);
    const p = this.p3;
    this.posePoint(i, c, p);
    const px = at(p, 0);
    const py = at(p, 1);
    const pz = at(p, 2);
    const length = at(this.host.bodyLength, i);
    const radius = CLEANING.queueBodyLengths * length;
    const cruise = at(this.host.cruiseSpeed, i);
    const d = this.distanceTo(i, px, py, pz);
    widenBand(plan, py, radius);
    plan.align *= CLEANING.queueSchoolFactor;
    plan.cohesion *= CLEANING.queueSchoolFactor;
    plan.wander *= 0.5;
    plan.speedFloor = 0;
    // Queued clients keep off the posing spot, so the one being served has it to itself.
    plan.shun(px, py, pz, length + at(this.host.bodyLength, c), 1);
    if (d > radius) {
      plan.seek(px, py, pz, cruise, 1.5, clamp((d - radius) / radius, 0.3, 1));
      return;
    }
    plan.cruiseScale *= BEHAVIOUR.stationCruiseFactor;
    plan.state = FishState.Station;
  }

  private planPose(i: number, sp: SimSpecies, plan: Plan): void {
    const c = at(this._cleanerOf, i);
    const p = this.p3;
    this.posePoint(i, c, p);
    const px = at(p, 0);
    const py = at(p, 1);
    const pz = at(p, 2);
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    const d = this.distanceTo(i, px, py, pz);
    widenBand(plan, py, length);
    plan.align = 0;
    plan.cohesion = 0;
    plan.separation = 0;
    plan.speedFloor = 0;
    if (at(this._arrived, i) === 0) {
      const speed = Math.min(0.6 * vmax, Math.max(cruise, d / 1.5));
      plan.wander *= 0.3;
      plan.seek(px, py, pz, speed, 0.5, 1.5);
      plan.speedCap = speed * clamp(d / (2 * length), 0.2, 1);
      plan.state = FishState.Station;
      return;
    }
    if (Number.isNaN(at(this.poseYaw, i))) this.poseYaw[i] = at(this.host.yaw, i);
    plan.wander = 0;
    plan.seek(px, py, pz, Math.min(CLEANING.poseSpeedFactor * cruise, d), 1);
    plan.speedCap = CLEANING.poseSpeedFactor * cruise;
    plan.yaw = at(this.poseYaw, i);
    plan.pitch = poseOf(sp.id) * Math.min(CLEANING.posePitchRad, sp.maxPitch);
    plan.display = CLEANING.poseDisplay;
    plan.gillFlare = CLEANING.poseGillFlare;
    plan.state = FishState.Pose;
  }

  private planCleaner(c: number, plan: Plan): void {
    const o = c * 3;
    const sx = at(this._station, o);
    const sy = at(this._station, o + 1);
    const sz = at(this._station, o + 2);
    const length = at(this.host.bodyLength, c);
    const cruise = at(this.host.cruiseSpeed, c);
    const s = at(this._serving, c);
    widenBand(plan, sy, length);
    plan.align = 0;
    plan.cohesion = 0;
    plan.speedFloor = 0;
    if (s >= 0 && at(this._arrived, s) === 1) {
      widenBand(plan, at(this.host.position, s * 3 + 1), length + at(this.host.bodyLength, s));
      this.planInspect(c, s, plan);
      return;
    }
    const radius = CLEANING.stationRadiusBodyLengths * length;
    const d = this.distanceTo(c, sx, sy, sz);
    plan.wander *= 0.5;
    if (d > radius) {
      plan.seek(sx, sy, sz, cruise, 1, clamp((d - radius) / radius, 0.3, 1));
    } else {
      plan.cruiseScale *= BEHAVIOUR.stationCruiseFactor;
      plan.state = FishState.Station;
    }
    if (s >= 0) {
      plan.yaw = Math.atan2(
        at(this.host.position, s * 3) - at(this.host.position, o),
        at(this.host.position, s * 3 + 2) - at(this.host.position, o + 2),
      );
    }
  }

  /**
   * Darts to a point beside the client's body, holds there picking for a moment, then darts to
   * another; a point inside rock or glass is swapped for the other flank.
   */
  private planInspect(c: number, s: number, plan: Plan): void {
    const { rng } = this.host;
    const length = at(this.host.bodyLength, c);
    const vmax = at(this.host.maxSpeed, c);
    const cruise = at(this.host.cruiseSpeed, c);
    let phase = at(this.contact, c);
    const timer = at(this.contactTimer, c) - DT;
    if (phase === Contact.None || (phase === Contact.Hold && timer <= 0)) {
      this.pickContact(c);
      phase = Contact.Dart;
      this.contactTimer[c] = CLEANING.dartTimeoutS;
    } else if (phase === Contact.Dart && timer <= 0) {
      this.pickContact(c);
      this.contactTimer[c] = CLEANING.dartTimeoutS;
    } else {
      this.contactTimer[c] = timer;
    }
    const p = this.p3;
    const facing = this.contactPoint(c, s, at(this.contactAlong, c), at(this.contactSide, c), p);
    const d = this.distanceTo(c, at(p, 0), at(p, 1), at(p, 2));
    plan.wander = 0;
    plan.separation = 0;
    plan.pivot = true;
    plan.state = FishState.Clean;
    this.shunBody(c, s, plan);
    const ls = at(this.host.bodyLength, s);
    plan.keepOff(
      s,
      CLEANING.bodyAxisBodyLengths * ls,
      BEHAVIOUR.bodyThicknessBodyLengths * (ls + length),
    );
    if (phase === Contact.Dart) {
      const dart = CLEANING.dartSpeedFraction * vmax;
      plan.continuous = true;
      plan.seek(at(p, 0), at(p, 1), at(p, 2), dart, CLEANING.dartTauS);
      plan.speedCap = dart * clamp(d / length, 0.1, 1);
      if (d < CLEANING.contactArriveBodyLengths * length) {
        this.contact[c] = Contact.Hold;
        this.contactTimer[c] = rng.range(CLEANING.contactHoldMinS, CLEANING.contactHoldMaxS);
      } else {
        this.contact[c] = Contact.Dart;
      }
      return;
    }
    // Facing the flank, any way it makes is towards the client, so it barely holds its place.
    const hold = CLEANING.holdSpeedFactor * cruise;
    plan.seek(at(p, 0), at(p, 1), at(p, 2), hold, CLEANING.dartTauS, 0.3);
    plan.speedCap = hold;
    plan.yaw = facing;
  }

  /**
   * Steers the cleaner's centre off the client's body axis, so darting between two points it
   * swims round the client rather than through it; `Plan.keepOff` makes sure of it.
   */
  private shunBody(c: number, s: number, plan: Plan): void {
    const { position, forward } = this.host;
    const ls = at(this.host.bodyLength, s);
    const lc = at(this.host.bodyLength, c);
    const fx = at(forward, s * 3);
    const fy = at(forward, s * 3 + 1);
    const fz = at(forward, s * 3 + 2);
    const along = clamp(
      (at(position, c * 3) - at(position, s * 3)) * fx +
        (at(position, c * 3 + 1) - at(position, s * 3 + 1)) * fy +
        (at(position, c * 3 + 2) - at(position, s * 3 + 2)) * fz,
      -CLEANING.bodyAxisBodyLengths * ls,
      CLEANING.bodyAxisBodyLengths * ls,
    );
    const flank = BEHAVIOUR.bodyThicknessBodyLengths * ls + CLEANING.contactGapBodyLengths * lc;
    const back = CLEANING.dorsalBodyLengths * ls + CLEANING.dorsalGapBodyLengths * lc;
    plan.shun(
      at(position, s * 3) + fx * along,
      at(position, s * 3 + 1) + fy * along,
      at(position, s * 3 + 2) + fz * along,
      CLEANING.bodyShunShare * Math.min(flank, back),
      CLEANING.bodyShunWeight,
    );
  }

  /**
   * Picks the next point to inspect, mostly on the flank the cleaner is already at. To change
   * flanks it goes over the client's back, never through its body.
   */
  private pickContact(c: number): void {
    const { rng, position, yaw, sceneSdf } = this.host;
    const s = at(this._serving, c);
    const k = Math.min(
      CLEANING.contactAlong.length - 1,
      Math.floor(rng.next() * CLEANING.contactAlong.length),
    );
    const along = CLEANING.contactAlong[k] ?? 0;
    const y = at(yaw, s);
    const dx = at(position, c * 3) - at(position, s * 3);
    const dy = at(position, c * 3 + 1) - at(position, s * 3 + 1);
    const dz = at(position, c * 3 + 2) - at(position, s * 3 + 2);
    const across = dx * Math.cos(y) - dz * Math.sin(y);
    const current = across < 0 ? -1 : 1;
    const above = dy > 0.5 * CLEANING.dorsalBodyLengths * at(this.host.bodyLength, s);
    let side = rng.next() < CLEANING.sideSwitchChance ? -current : current;
    const p = this.p3;
    const clearance = at(this.host.radius, c) * 0.5;
    this.contactPoint(c, s, along, side, p);
    const here = sceneSdf.sample(at(p, 0), at(p, 1), at(p, 2), this.n3);
    if (here < clearance) {
      this.contactPoint(c, s, along, -side, p);
      if (sceneSdf.sample(at(p, 0), at(p, 1), at(p, 2), this.n3) > here) side = -side;
    }
    if (side !== current && !above) side = 0;
    this.contactAlong[c] = along;
    this.contactSide[c] = side;
  }

  /**
   * Where cleaner `c`'s centre goes to put its snout to client `s`'s flank at `along` body
   * lengths from its centre on side `side` (-1 or 1, or 0 for over its back); returns the yaw
   * that faces the flank, NaN over the back.
   */
  private contactPoint(
    c: number,
    s: number,
    along: number,
    side: number,
    out: Float64Array,
  ): number {
    const { position, forward, yaw } = this.host;
    const ls = at(this.host.bodyLength, s);
    const lc = at(this.host.bodyLength, c);
    const y = at(yaw, s);
    const rx = Math.cos(y);
    const rz = -Math.sin(y);
    const off = BEHAVIOUR.bodyThicknessBodyLengths * ls + CLEANING.contactGapBodyLengths * lc;
    if (side === 0) {
      out[0] = at(position, s * 3) + at(forward, s * 3) * along * ls;
      const lift = CLEANING.dorsalBodyLengths * ls + CLEANING.dorsalGapBodyLengths * lc;
      out[1] = at(position, s * 3 + 1) + at(forward, s * 3 + 1) * along * ls + lift;
      out[2] = at(position, s * 3 + 2) + at(forward, s * 3 + 2) * along * ls;
      return NaN;
    }
    out[0] = at(position, s * 3) + at(forward, s * 3) * along * ls + rx * side * off;
    out[1] = at(position, s * 3 + 1) + at(forward, s * 3 + 1) * along * ls;
    out[2] = at(position, s * 3 + 2) + at(forward, s * 3 + 2) * along * ls + rz * side * off;
    return Math.atan2(-rx * side, -rz * side);
  }

  /**
   * Where client `i` poses at cleaner `c`'s station: out from the rock beside the cleaner, or on
   * the station itself when that water is taken by rock or glass.
   */
  posePoint(i: number, c: number, out: Float64Array): void {
    const o = c * 3;
    const li = at(this.host.bodyLength, i);
    const lc = at(this.host.bodyLength, c);
    const reach = 0.5 * (li + lc) + CLEANING.poseGapBodyLengths * li;
    const sx = at(this._station, o);
    const sy = at(this._station, o + 1);
    const sz = at(this._station, o + 2);
    const ux = at(this.stationOut, o);
    const uz = at(this.stationOut, o + 2);
    const need = at(this.host.radius, i) * 0.5;
    if (this.poseClear(sx + ux * reach, sy, sz + uz * reach, need, out)) return;
    if (this.poseClear(sx - uz * reach, sy, sz + ux * reach, need, out)) return;
    if (this.poseClear(sx + uz * reach, sy, sz - ux * reach, need, out)) return;
    out[0] = sx;
    out[1] = sy;
    out[2] = sz;
  }

  private poseClear(x: number, y: number, z: number, need: number, out: Float64Array): boolean {
    if (this.host.sceneSdf.sample(x, y, z, this.n3) < need) return false;
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return true;
  }

  private distanceTo(i: number, x: number, y: number, z: number): number {
    const { position } = this.host;
    return Math.hypot(
      x - at(position, i * 3),
      y - at(position, i * 3 + 1),
      z - at(position, i * 3 + 2),
    );
  }

  /**
   * Gives each cleaner a station, from the layout alone, so the same decor always gives the same
   * stations: cleaning stations sit on prominent reef features, so the cleaners take the hard
   * decor pieces standing tallest above the sand in turn (ties by id). Without decor, or with no
   * room by any piece, a cleaner holds mid-water at the middle of the tank.
   */
  private chooseStations(): void {
    const { basin } = this.host;
    const features = this.host.decorBounds
      .map((b) => ({
        b,
        rise: b.maxY - basin.ground(0.5 * (b.minX + b.maxX), 0.5 * (b.minZ + b.maxZ)),
      }))
      .sort((a, b) => b.rise - a.rise || (a.b.id < b.b.id ? -1 : a.b.id > b.b.id ? 1 : 0));
    const placed: number[] = [];
    let k = 0;
    for (let c = 0; c < this.host.count; c++) {
      if (!this.isCleaner(c)) continue;
      let done = false;
      for (let m = 0; m < features.length && !done; m++) {
        const f = features[(k + m) % features.length];
        if (f !== undefined) done = this.placeBeside(c, f.b, placed);
      }
      if (!done) this.placeMidWater(c);
      placed.push(c);
      k++;
    }
  }

  private placeBeside(c: number, f: DecorBounds, placed: readonly number[]): boolean {
    const { basin, sceneSdf, decorSdf } = this.host;
    if (decorSdf === null) return false;
    const sp = this.speciesOf(c);
    const length = at(this.host.bodyLength, c);
    const margin = at(this.host.radius, c) + 0.5 * length;
    const standoff = CLEANING.stationStandoffBodyLengths * length;
    const spacing = CLEANING.stationSpacingBodyLengths * length;
    const cx = 0.5 * (f.minX + f.maxX);
    const cz = 0.5 * (f.minZ + f.maxZ);
    const floor = Math.max(f.minY, basin.ground(cx, cz));
    const height = Math.max(0, f.maxY - floor);
    const reach = 0.5 * Math.hypot(f.maxX - f.minX, f.maxZ - f.minZ) + standoff + length;
    const midX = 0.5 * (basin.minX + basin.maxX);
    const midZ = 0.5 * (basin.minZ + basin.maxZ);
    const n3 = this.n3;
    let best = Infinity;
    for (let l = 0; l < CLEANING.stationLevels; l++) {
      const y0 =
        f.maxY - (height * CLEANING.stationFlankShare * (l + 0.5)) / CLEANING.stationLevels;
      for (let b = 0; b < CLEANING.stationBearings; b++) {
        const theta = (2 * Math.PI * b) / CLEANING.stationBearings;
        const dx = Math.sin(theta);
        const dz = Math.cos(theta);
        let r = 0;
        let found = false;
        let x = cx;
        let z = cz;
        while (r <= reach) {
          x = cx + dx * r;
          z = cz + dz * r;
          const d = decorSdf.sample(x, y0, z, n3);
          if (d >= standoff) {
            found = true;
            break;
          }
          r += Math.max(standoff - d, 0.1 * length);
        }
        if (!found) continue;
        if (
          x < basin.minX + margin ||
          x > basin.maxX - margin ||
          z < basin.minZ + margin ||
          z > basin.maxZ - margin
        ) {
          continue;
        }
        const ground = basin.ground(x, z);
        const y = clamp(y0, ground + margin, basin.maxY - margin);
        if (sceneSdf.sample(x, y, z, n3) < margin) continue;
        if (placed.some((p) => this.distanceToStation(p, x, y, z) < spacing)) continue;
        const column = basin.maxY - ground;
        const bandMid = ground + 0.5 * (sp.depthLow + sp.depthHigh) * column;
        const score = Math.hypot(x - midX, z - midZ) + Math.abs(y - bandMid);
        if (score < best) {
          best = score;
          this.setStation(c, x, y, z, dx, dz);
        }
      }
    }
    if (best === Infinity) return false;
    const o = c * 3;
    decorSdf.sample(at(this._station, o), at(this._station, o + 1), at(this._station, o + 2), n3);
    const h = Math.hypot(at(n3, 0), at(n3, 2));
    if (h > 1e-6) {
      this.stationOut[o] = at(n3, 0) / h;
      this.stationOut[o + 2] = at(n3, 2) / h;
    }
    return true;
  }

  private placeMidWater(c: number): void {
    const { basin, sceneSdf } = this.host;
    const sp = this.speciesOf(c);
    const x = 0.5 * (basin.minX + basin.maxX);
    const z = 0.5 * (basin.minZ + basin.maxZ);
    const ground = basin.ground(x, z);
    const y = ground + 0.5 * (sp.depthLow + sp.depthHigh) * (basin.maxY - ground);
    if (sceneSdf.sample(x, y, z, this.n3) >= at(this.host.radius, c)) {
      this.setStation(c, x, y, z, 0, 1);
      return;
    }
    const { position } = this.host;
    this.setStation(c, at(position, c * 3), at(position, c * 3 + 1), at(position, c * 3 + 2), 0, 1);
  }

  private setStation(c: number, x: number, y: number, z: number, ux: number, uz: number): void {
    const o = c * 3;
    this._station[o] = x;
    this._station[o + 1] = y;
    this._station[o + 2] = z;
    this.stationOut[o] = ux;
    this.stationOut[o + 1] = 0;
    this.stationOut[o + 2] = uz;
  }

  private distanceToStation(c: number, x: number, y: number, z: number): number {
    const o = c * 3;
    return Math.hypot(
      x - at(this._station, o),
      y - at(this._station, o + 1),
      z - at(this._station, o + 2),
    );
  }

  private speciesOf(i: number): SimSpecies {
    const s = this.host.species[at(this.host.speciesIndex, i)];
    if (s === undefined) throw new RangeError(`no fish at index ${i}`);
    return s;
  }
}

function widenBand(plan: Plan, y: number, r: number): void {
  plan.bandLo = Math.min(plan.bandLo, y - r);
  plan.bandHi = Math.max(plan.bandHi, y + r);
}
