import type { BehaviourHost } from './behaviour.ts';
import type { Point3 } from './decor.ts';
import type { Feeding } from './feeding.ts';
import type { FishResize } from './fishArrays.ts';
import { clamp } from './math.ts';
import type { SimSpecies } from './species.ts';

/** Every tunable of lure following and feeding-spot memory; sources are in BEHAVIOUR.md. */
export const CURIOSITY = {
  lureLatencyMinS: 0.5,
  lureLatencyMaxS: 3,
  lureRetryS: 5,
  lureTrackTauS: 0.3,
  lureCatchUpS: 1,
  lureKeepRangeFactor: 1.5,
  lureAttentionS: 30,
  lureRecoverTauS: 120,
  lureRecoverLevel: 0.3,
  lureStandoffBodyLengths: 0.5,
  lureSchoolFactor: 0.3,
  lureLeashBodyLengths: 5,

  mealGapS: 120,
  spotLearnRate: 0.5,
  spotMemoryTauS: 7 * 24 * 3600,
  anticipationLeadShare: 0.15,
  anticipationMinWeight: 0.05,
  anticipationRadiusBodyLengths: 2,
} as const;

const DT = 1 / 30;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * Two pulls that come from what a fish has seen rather than from food in view: a lure (a laser
 * dot or fingertip on the glass) that curious fish notice, close on and track until they lose
 * interest, and the place food enters the tank, which each fish learns and drifts back to as its
 * next meal comes due. `Behaviour` fills `eligible` and `leash` before every `update` and turns
 * `follow` and `anticipation` into plans afterwards.
 */
export class Curiosity {
  private _eligible: Uint8Array;
  private _leash: Float64Array;
  private _follow: Uint8Array;
  private _seen: Float64Array;
  private _spot: Float64Array;
  private _anticipation: Float64Array;
  private notice: Float64Array;
  private habituation: Float64Array;
  private strength: Float64Array;
  private mealStart: Float64Array;
  private mealEnd: Float64Array;
  private interval: Float64Array;

  private readonly host: BehaviourHost;
  private readonly lure = new Float64Array(3);
  private lureOn = false;
  private readonly arrival = new Float64Array(3);

  /** 1 when the fish may follow a lure or wait at its feeding spot this step. */
  get eligible(): Uint8Array {
    return this._eligible;
  }

  /** Per fish x, y, z, radius of the area it will leave home for; radius Infinity for none. */
  get leash(): Float64Array {
    return this._leash;
  }

  /** 1 while the fish is tracking the lure. */
  get follow(): Uint8Array {
    return this._follow;
  }

  /** Where each fish sees the lure, x, y, z: the lure itself, lagging its moves. */
  get seen(): Float64Array {
    return this._seen;
  }

  /** Each fish's feeding spot, x, z, where it has seen food enter. */
  get spot(): Float64Array {
    return this._spot;
  }

  /** 0 to 1: how strongly each fish is drawn to its feeding spot this step. */
  get anticipation(): Float64Array {
    return this._anticipation;
  }

  get lureActive(): boolean {
    return this.lureOn;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._eligible = new Uint8Array(n);
    this._leash = new Float64Array(n * 4);
    this._follow = new Uint8Array(n);
    this._seen = new Float64Array(n * 3);
    this._spot = new Float64Array(n * 2);
    this._anticipation = new Float64Array(n);
    this.notice = new Float64Array(n);
    this.habituation = new Float64Array(n);
    this.strength = new Float64Array(n);
    this.mealStart = new Float64Array(n).fill(-1);
    this.mealEnd = new Float64Array(n).fill(-1);
    this.interval = new Float64Array(n);
  }

  /** A fish joining knows no feeding spot and has not seen the lure. */
  resize(edit: FishResize): void {
    this._eligible = edit.array(this.eligible);
    this._leash = edit.array(this.leash, 4);
    this._follow = edit.array(this.follow);
    this._seen = edit.array(this.seen, 3);
    this._spot = edit.array(this.spot, 2);
    this._anticipation = edit.array(this.anticipation);
    this.notice = edit.array(this.notice);
    this.habituation = edit.array(this.habituation);
    this.strength = edit.array(this.strength);
    this.mealStart = edit.array(this.mealStart, 1, -1);
    this.mealEnd = edit.array(this.mealEnd, 1, -1);
    this.interval = edit.array(this.interval);
  }

  /**
   * Shows the lure at `position` in the world's frame, or takes it away with null. A point
   * outside the water (a dot a hair into the sand or above the surface) is moved into it.
   */
  setLure(position: Point3 | null): void {
    if (position === null) {
      this.lureOn = false;
      return;
    }
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) {
      throw new RangeError('lure: position must be a finite [x, y, z] array or null');
    }
    const { basin } = this.host;
    const x = clamp(position[0], basin.minX, basin.maxX);
    const z = clamp(position[2], basin.minZ, basin.maxZ);
    this.lure[0] = x;
    this.lure[1] = clamp(position[1], basin.ground(x, z), basin.maxY);
    this.lure[2] = z;
    this.lureOn = true;
  }

  /** How strongly fish `i`, with hunger `motivation`, is drawn to its feeding spot now. */
  private anticipate(i: number, motivation: number, time: number): number {
    const interval = at(this.interval, i);
    if (interval <= 0) return 0;
    const due = at(this.mealStart, i) + interval;
    const lead = CURIOSITY.anticipationLeadShare * interval;
    if (Math.abs(time - due) > lead) return 0;
    return at(this.strength, i) * motivation;
  }

  update(hunger: Pick<Feeding, 'motivation'>): void {
    const n = this.host.count;
    const time = this.host.tick * DT;
    const recover = Math.exp(-DT / CURIOSITY.lureRecoverTauS);
    const forget = Math.exp(-DT / CURIOSITY.spotMemoryTauS);
    const track = 1 - Math.exp(-DT / CURIOSITY.lureTrackTauS);
    const entered = this.host.food.takeArrivals(this.arrival);
    for (let i = 0; i < n; i++) {
      this.strength[i] = at(this.strength, i) * forget;
      if (entered > 0) this.learn(i, time);
      this.anticipation[i] =
        this.eligible[i] === 1 && this.spotWithinLeash(i)
          ? this.anticipate(i, hunger.motivation(i), time)
          : 0;
      if (this.follow[i] === 1) {
        this.track(i, track);
      } else {
        this.habituation[i] = at(this.habituation, i) * recover;
        this.watch(i);
      }
    }
  }

  /**
   * Food just entered: the meal it belongs to, a new one after a gap of `mealGapS`, and where it
   * came in. Every fish in the tank sees it, as fish fed at one place learn the place.
   */
  private learn(i: number, time: number): void {
    const rate = CURIOSITY.spotLearnRate;
    const start = at(this.mealStart, i);
    const s = at(this.strength, i);
    if (start < 0 || time - at(this.mealEnd, i) > CURIOSITY.mealGapS) {
      if (start >= 0) {
        const gap = time - start;
        const known = at(this.interval, i);
        this.interval[i] = known > 0 ? known + (gap - known) * rate : gap;
      }
      this.mealStart[i] = time;
      this.strength[i] = s + (1 - s) * rate;
    }
    this.mealEnd[i] = time;
    const o = i * 2;
    const ax = at(this.arrival, 0);
    const az = at(this.arrival, 2);
    const w = s > 0 ? rate : 1;
    this.spot[o] = at(this.spot, o) + (ax - at(this.spot, o)) * w;
    this.spot[o + 1] = at(this.spot, o + 1) + (az - at(this.spot, o + 1)) * w;
  }

  /** A fish not yet following: counts how long it has watched the lure, then takes it up or not. */
  private watch(i: number): void {
    const notice = at(this.notice, i);
    if (notice < 0) {
      this.notice[i] = Math.min(0, notice + DT);
      return;
    }
    if (!this.lureOn || this.eligible[i] === 0 || !this.sees(i, false)) {
      this.notice[i] = 0;
      return;
    }
    const watched = notice + DT;
    this.notice[i] = watched;
    const curiosity = this.speciesOf(i).curiosity;
    const latency =
      CURIOSITY.lureLatencyMinS +
      (CURIOSITY.lureLatencyMaxS - CURIOSITY.lureLatencyMinS) * (1 - curiosity);
    if (watched < latency) return;
    if (at(this.habituation, i) > CURIOSITY.lureRecoverLevel || this.host.rng.next() >= curiosity) {
      this.notice[i] = -CURIOSITY.lureRetryS;
      return;
    }
    this.follow[i] = 1;
    this.seen.set(this.lure, i * 3);
  }

  /** A following fish: closes on the lure as it moves, and tires of it. */
  private track(i: number, blend: number): void {
    if (!this.lureOn || this.eligible[i] === 0 || !this.sees(i, true)) {
      this.stop(i, 0);
      return;
    }
    const attention = CURIOSITY.lureAttentionS * (0.5 + this.speciesOf(i).curiosity);
    const h = at(this.habituation, i) + DT / attention;
    this.habituation[i] = h;
    if (h >= 1) {
      this.stop(i, -CURIOSITY.lureRetryS);
      return;
    }
    const o = i * 3;
    for (let a = 0; a < 3; a++) {
      this.seen[o + a] = at(this.seen, o + a) + (at(this.lure, a) - at(this.seen, o + a)) * blend;
    }
  }

  private stop(i: number, notice: number): void {
    this.follow[i] = 0;
    this.notice[i] = notice;
  }

  /**
   * Whether fish `i` can see the lure: within its perception range and view cone, or, once it is
   * tracking it and turning with it, within half as far again in any direction.
   */
  private sees(i: number, tracking: boolean): boolean {
    const { position, forward } = this.host;
    const sp = this.speciesOf(i);
    const dx = at(this.lure, 0) - at(position, i * 3);
    const dy = at(this.lure, 1) - at(position, i * 3 + 1);
    const dz = at(this.lure, 2) - at(position, i * 3 + 2);
    const d = Math.hypot(dx, dy, dz);
    if (!this.withinLeash(i, at(this.lure, 0), at(this.lure, 1), at(this.lure, 2))) return false;
    if (tracking) return d <= CURIOSITY.lureKeepRangeFactor * sp.perceptionRange;
    if (d > sp.perceptionRange) return false;
    if (d < 1e-9 || sp.perceptionFov >= 2 * Math.PI) return true;
    const cos =
      (dx * at(forward, i * 3) + dy * at(forward, i * 3 + 1) + dz * at(forward, i * 3 + 2)) / d;
    return cos >= Math.cos(sp.perceptionFov / 2);
  }

  private speciesOf(i: number): SimSpecies {
    const sp = this.host.species[at(this.host.speciesIndex, i)];
    if (sp === undefined) throw new RangeError(`no fish at index ${i}`);
    return sp;
  }

  private withinLeash(i: number, x: number, y: number, z: number): boolean {
    const o = i * 4;
    const r = at(this.leash, o + 3);
    if (r === Infinity) return true;
    return (
      Math.hypot(x - at(this.leash, o), y - at(this.leash, o + 1), z - at(this.leash, o + 2)) <= r
    );
  }

  /** The spot is a place on the water's plan, so only its horizontal distance counts. */
  private spotWithinLeash(i: number): boolean {
    const y = at(this.leash, i * 4 + 1);
    return this.withinLeash(i, at(this.spot, i * 2), y, at(this.spot, i * 2 + 1));
  }
}
