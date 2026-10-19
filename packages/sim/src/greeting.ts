import { VISIT_WINDOW_DAYS } from '@aquarium/shared';
import type { BehaviourHost } from './behaviour.ts';
import type { FishResize } from './fishArrays.ts';
import { clamp } from './math.ts';

/** Every tunable of fish coming to the front glass for a familiar owner; sources are in BEHAVIOUR.md. */
export const GREETING = {
  latencyMinS: 1,
  latencyMaxS: 3,
  shyLatencyS: 4,
  stayMinS: 20,
  stayMaxS: 60,
  spreadBodyLengths: 3,
  riseBodyLengths: 1,
  standoffBodyLengths: 0.75,
  approachSpeedFactor: 1.3,
  catchUpS: 1.5,
  schoolFactor: 0.5,
  arrivedBodyLengths: 1,
  familiarityTauDays: 4,
} as const;

/**
 * How well the fish know the owner, 0 to 1, from `recentVisitDays`: the distinct days in the last
 * `VISIT_WINDOW_DAYS` on which they opened the tank, today included. Today's visit teaches nothing
 * yet, so one day is a stranger; each earlier day adds less than the one before (a negatively
 * accelerated learning curve), reaching 1 for a visit on all `VISIT_WINDOW_DAYS` days.
 */
export function familiarityFromVisits(recentVisitDays: number): number {
  if (
    !Number.isInteger(recentVisitDays) ||
    recentVisitDays < 0 ||
    recentVisitDays > VISIT_WINDOW_DAYS
  ) {
    throw new RangeError(
      `visitor: recentVisitDays must be a whole number within 0 to ${VISIT_WINDOW_DAYS}, got ${String(recentVisitDays)}`,
    );
  }
  const learnt = Math.max(0, recentVisitDays - 1);
  const tau = GREETING.familiarityTauDays;
  return -Math.expm1(-learnt / tau) / -Math.expm1(-(VISIT_WINDOW_DAYS - 1) / tau);
}

/**
 * The owner at the tank. `recentVisitDays` is the tank response's field of that name, 0 to
 * `VISIT_WINDOW_DAYS`; see `familiarityFromVisits`. `at` is where they stand, as x and height on
 * the front glass in the world's frame, the middle of the pane when left out.
 */
export interface Visitor {
  readonly recentVisitDays: number;
  readonly at?: readonly [x: number, y: number];
}

const Phase = { None: 0, Waiting: 1, Coming: 2, Done: 3 } as const;

const DT = 1 / 30;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * Fish that know their owner come to the front glass when the owner turns up, as fish fed by
 * people learn to approach them. When a visitor arrives each swimmer decides once, from the
 * familiarity, its own boldness and its hunger, whether to come; one that does waits a moment,
 * then stays a while at the glass before going back to what it was doing. It decides again only
 * on the next visit. `Behaviour` fills `eligible` before every `update` and turns `active` into
 * plans afterwards.
 */
export class Greeting {
  private _eligible: Uint8Array;
  private _active: Uint8Array;
  private _offset: Float64Array;
  private phase: Uint8Array;
  private timer: Float64Array;
  private stay: Float64Array;

  private readonly host: BehaviourHost;
  private present = false;
  private arrived = false;
  private _familiarity = 0;
  private readonly _point = new Float64Array(2);

  /** 1 when the fish may come to the glass this step. */
  get eligible(): Uint8Array {
    return this._eligible;
  }

  /** 1 while the fish is coming to or waiting at the glass. */
  get active(): Uint8Array {
    return this._active;
  }

  /** Per fish, sideways and upward offsets in body lengths from the visitor's spot on the glass. */
  get offset(): Float64Array {
    return this._offset;
  }

  /** Where the visitor stands: x and height on the front glass. */
  get point(): Float64Array {
    return this._point;
  }

  get visitorPresent(): boolean {
    return this.present;
  }

  get familiarity(): number {
    return this._familiarity;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    this._eligible = new Uint8Array(n);
    this._active = new Uint8Array(n);
    this._offset = new Float64Array(n * 2);
    this.phase = new Uint8Array(n);
    this.timer = new Float64Array(n);
    this.stay = new Float64Array(n);
  }

  /** A fish joining while the visitor is there was not in the tank when they came. */
  resize(edit: FishResize): void {
    this._eligible = edit.array(this.eligible);
    this._active = edit.array(this.active);
    this._offset = edit.array(this.offset, 2);
    this.phase = edit.array(this.phase, 1, this.present ? Phase.Done : Phase.None);
    this.timer = edit.array(this.timer);
    this.stay = edit.array(this.stay);
  }

  /**
   * The owner arrives, moves along the glass or leaves (null). Fish decide whether to come only
   * on arrival; while the visitor stays, a new spot or visit count changes where the fish go and
   * nothing else.
   */
  setVisitor(visitor: Visitor | null): void {
    if (visitor === null) {
      this.present = false;
      this.arrived = false;
      this.phase.fill(Phase.None);
      this.active.fill(0);
      return;
    }
    const raw: unknown = visitor;
    if (typeof raw !== 'object' || raw === null) {
      throw new RangeError('visitor must be an object or null');
    }
    const familiarity = familiarityFromVisits(visitor.recentVisitDays);
    const spot = visitor.at;
    if (
      spot !== undefined &&
      !(Array.isArray(spot) && spot.length === 2 && spot.every(Number.isFinite))
    ) {
      throw new RangeError('visitor: at must be a finite [x, y] array on the front glass');
    }
    const { basin } = this.host;
    const x = clamp(spot?.[0] ?? 0.5 * (basin.minX + basin.maxX), basin.minX, basin.maxX);
    const ground = basin.ground(x, basin.maxZ);
    this._point[0] = x;
    this._point[1] = clamp(spot?.[1] ?? 0.5 * (ground + basin.maxY), ground, basin.maxY);
    this._familiarity = familiarity;
    if (!this.present) this.arrived = true;
    this.present = true;
  }

  /**
   * `boldness` and `hunger` give each fish's effective boldness and feeding motivation, both 0 to
   * 1; they are read only on the step the visitor arrives.
   */
  update(boldness: (i: number) => number, hunger: (i: number) => number): void {
    const n = this.host.count;
    if (this.arrived) {
      this.arrived = false;
      this.decide(boldness, hunger);
    }
    for (let i = 0; i < n; i++) {
      const phase = this.phase[i];
      if (phase === Phase.Waiting || phase === Phase.Coming) {
        const left = at(this.timer, i) - DT;
        this.timer[i] = left;
        if (left <= 0 && phase === Phase.Waiting) {
          this.phase[i] = Phase.Coming;
          this.timer[i] = at(this.stay, i);
        } else if (left <= 0) {
          this.phase[i] = Phase.Done;
        }
      }
      this.active[i] = this.phase[i] === Phase.Coming && this.eligible[i] === 1 ? 1 : 0;
    }
  }

  /**
   * Draws from the world RNG only when someone familiar arrives, so a tank nobody visits keeps
   * the trajectory it had before greeting existed.
   */
  private decide(boldness: (i: number) => number, hunger: (i: number) => number): void {
    const { rng, species, speciesIndex } = this.host;
    const familiarity = this._familiarity;
    for (let i = 0; i < this.host.count; i++) {
      const walker = (species[at(speciesIndex, i)]?.walking ?? null) !== null;
      if (familiarity <= 0 || walker) {
        this.phase[i] = Phase.Done;
        continue;
      }
      const b = boldness(i);
      const p = familiarity * (0.5 + 0.5 * b) * (0.5 + 0.5 * hunger(i));
      if (rng.next() >= p) {
        this.phase[i] = Phase.Done;
        continue;
      }
      this.phase[i] = Phase.Waiting;
      this.timer[i] =
        rng.range(GREETING.latencyMinS, GREETING.latencyMaxS) + GREETING.shyLatencyS * (1 - b);
      this.stay[i] = rng.range(GREETING.stayMinS, GREETING.stayMaxS);
      this.offset[i * 2] = GREETING.spreadBodyLengths * rng.signed();
      this.offset[i * 2 + 1] = GREETING.riseBodyLengths * rng.signed();
    }
  }
}
