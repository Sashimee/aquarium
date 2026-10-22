import type { Basin } from './basin.ts';
import { CURIOSITY, Curiosity } from './curiosity.ts';
import type { Point3 } from './decor.ts';
import { FEEDING, Feeding, feedingHeight } from './feeding.ts';
import type { FishResize } from './fishArrays.ts';
import type { FoodStore } from './food.ts';
import { GREETING, Greeting, type Visitor } from './greeting.ts';
import { clamp, DEG, wrapAngle } from './math.ts';
import { selectNearest } from './neighbours.ts';
import { Night } from './night.ts';
import { Personalities } from './personality.ts';
import type { Rng } from './rng.ts';
import type { Sdf } from './sdf.ts';
import { FishState } from './snapshot.ts';
import type { SimSpecies, SimWalking } from './species.ts';
import { TOYS, Toys, type SimToy } from './toys.ts';
import { BROOD, Brood, type SimBrood } from './brood.ts';

/** Every tunable of the species behaviours; sources are in BEHAVIOUR.md. */
export const BEHAVIOUR = {
  burstSpeedFactor: 1.35,
  burstResponseS: 0.1,
  burstMaxS: 0.2,
  coastReleaseFactor: 0.75,
  coastMaxS: 1.2,
  glideDragFactor: 1 / 3,
  coastTurnGain: 0.3,

  stimulusRangeM: 0.4,
  cBendTurnRateRadPerS: 3000 * DEG,
  cBendMaxS: 0.1,
  cBendDoneRad: 10 * DEG,
  escapeBurstS: 0.4,
  fleeS: 1,
  fleeSpeedFraction: 0.6,
  escapeAwayShare: 0.5,
  escapeOffsetRad: 50 * DEG,
  escapeNoiseRad: 15 * DEG,
  boldnessDamping: 0.5,
  relayNeighbours: 6,
  relayIntercept: 0.302,
  relayLogDistance: -1.421,
  relayRank: -0.126,
  relayNoiseRad: 20 * DEG,
  refractoryS: 3,
  tightenS: 15,
  tightenCohesion: 2,
  tightenSeparation: 0.6,
  habituationPerResponse: 0.5,
  habituationTauS: 120,
  restStartleDamping: 0.5,

  restTauS: 30,
  restTauJitter: 0.3,
  restSpeedFactor: 0.2,
  restSchoolFactor: 0.2,
  restBandDrop: 0.15,

  shoalAlignment: 0.3,
  shoalCohesion: 0.6,
  cruiseSpeedFloor: 0.5,

  stationRadiusBodyLengths: 1.5,
  restationMinS: 20,
  restationMaxS: 60,
  stationCruiseFactor: 0.3,
  stationCandidates: 6,
  stationDecorBodyLengths: 1.5,
  stationTravelWeight: 0.3,

  hostLeashBodyLengths: 1.5,
  excursionMeanIntervalS: 25,
  excursionMinS: 3,
  excursionMaxS: 6,
  excursionBodyLengths: 3,
  caveMouthBodyLengths: 1,
  caveLeashBodyLengths: 2.5,
  shelterAfterStartleS: 20,
  shelterComfort: 0.4,
  bellyReachBodyLengths: 1.2,

  forageBandLowBodyLengths: 0.3,
  forageBandHighBodyLengths: 0.4,
  siftMinS: 1,
  siftMaxS: 4,
  moveMinS: 2,
  moveMaxS: 6,
  siftPitchRad: -25 * DEG,
  siftSpeedFactor: 0.15,
  gulpsPerHour: 6,
  gulpAscentSpeedFraction: 0.6,
  gulpTopBodyLengths: 0.55,
  gulpArriveBodyLengths: 0.65,
  gulpHoldS: 0.3,
  gulpTimeoutS: 10,

  grazeMeanIntervalS: 20,
  grazeMinS: 1.5,
  grazeMaxS: 4,
  grazeApproachTimeoutS: 8,
  grazeStandoffBodyLengths: 0.3,
  grazeBackRoomBodyLengths: 0.5,
  grazeComfort: 0.2,
  grazeSpeedFactor: 0.25,
  glassStandoffThickness: 1.3,
  glassCrawlFactor: 0.15,
  glassStayMinS: 5,
  glassStayMaxS: 15,
  glassRoamMinS: 2,
  glassRoamMaxS: 5,
  minComfort: 0.05,

  territoryCheckS: 0.5,
  intruderSizeRatio: 0.7,
  intruderMaxSizeRatio: 1.5,
  territoryBodyLengths: 4,
  anchorTerritoryBodyLengths: 3,
  approachS: 3,
  flareMinS: 2,
  flareMaxS: 5,
  chargeS: 0.6,
  chargeSpeedFraction: 0.7,
  cooldownMinS: 5,
  cooldownMaxS: 15,
  chargeYieldProbability: 0.7,
  yieldS: 1.5,
  yieldCruiseFactor: 2.5,
  maxQueuedStimuli: 16,

  walkerFreezeMinS: 1,
  walkerFreezeMaxS: 3,
  walkerPickMinS: 1,
  walkerPickMaxS: 3,
  walkerWalkMinS: 2,
  walkerWalkMaxS: 6,
  grazerPickMinS: 2,
  grazerPickMaxS: 8,
  grazerWalkMinS: 1,
  grazerWalkMaxS: 4,
  /** A cave takes this many walkers per (cave radius / body length)², and at least one. */
  walkerCaveShare: 2,
  walkerNookCandidates: 8,
  walkerNookRingBodyLengths: 1,
  walkerNookOutBodyLengths: 0.5,
  walkerNookArriveBodyLengths: 0.5,
  walkerNookDecorBodyLengths: 1.5,
  walkerNookGiveUpS: 60,
  /** Another walker's nook closer than this, in plan view, is taken. */
  walkerNookSpacingBodyLengths: 1,
  /** A walker that gets no closer to its cave or nook than this in the give-up time lets it go. */
  walkerSeekProgressBodyLengths: 0.5,
  walkerCaveGiveUpS: 60,

  /** Fish body as a chain of spheres along the spine, in body lengths. */
  bodyThicknessBodyLengths: 0.12,
  bodySampleOffsets: [0.38, 0.19, 0, -0.19, -0.38],
} as const;

/** A scene point a species is drawn to: an anemone for clownfish, a cave for royal gramma. */
export interface Anchor {
  readonly id: string;
  readonly kind: 'anemone' | 'cave';
  /** A point in free water: the anemone's centre or the cave's interior. */
  readonly position: Point3;
  readonly radius: number;
  /** Outward direction of a cave mouth. */
  readonly facing?: Point3;
}

export interface Stimulus {
  readonly position: Point3;
  /** 0 to 1: a soft glass tap is ~0.5, a hard tap or fast pointer swipe 1. */
  readonly intensity: number;
}

/** What `World` exposes to the behaviour layer. */
export interface BehaviourHost {
  readonly count: number;
  readonly fishIds: readonly string[];
  readonly basin: Basin;
  readonly species: readonly SimSpecies[];
  readonly speciesIndex: Int32Array;
  readonly position: Float64Array;
  readonly forward: Float64Array;
  readonly yaw: Float64Array;
  readonly speed: Float64Array;
  readonly bodyLength: Float64Array;
  readonly radius: Float64Array;
  readonly maxSpeed: Float64Array;
  readonly cruiseSpeed: Float64Array;
  readonly distSq: Float64Array;
  readonly tick: number;
  readonly rng: Rng;
  /** Tank and hard decor. */
  readonly sceneSdf: Sdf;
  /** Tank without the water surface, and hard decor: the surfaces a fish can graze. */
  readonly substrateSdf: Sdf;
  /** Hard decor alone, or null when the tank is bare. */
  readonly decorSdf: Sdf | null;
  /** Plants and other soft decor, or null when there are none. */
  readonly plantSdf: Sdf | null;
  /** Per fish `StageCode`. */
  readonly stage: Uint8Array;
  /** Per fish `SexCode`. */
  readonly sex: Uint8Array;
  readonly food: FoodStore;
  /** 1 per fish seeking a refuge from the wave maker's flow. */
  readonly flowShelter: Uint8Array;
  /**
   * Whether fish `i`, holding station beside the glass or rock at (x, y, z), has a level disc
   * of its own length clear to turn round in.
   */
  canTurnAt(i: number, x: number, y: number, z: number): boolean;
  /** The tightest arc fish `i` turns on while swimming, before it brakes to pivot. */
  cruiseTurnRadius(i: number): number;
}

/** One fish's intent for this step, consumed by steering and integration. */
export class Plan {
  state: FishState = FishState.Cruise;
  wander = 1;
  align = 1;
  cohesion = 1;
  separation = 1;
  cruiseScale = 1;
  bandLo = 0;
  bandHi = 0;
  seekWeight = 0;
  seekX = 0;
  seekY = 0;
  seekZ = 0;
  seekSpeed = 0;
  seekTau = 1;
  /**
   * How far out from a seek point lying against glass or rock the fish holds station, facing it
   * with its mouth in reach; 0 when it swims straight for the point.
   */
  arrival = 0;
  comfort = 1;
  floor = true;
  surface = true;
  speedCap = Infinity;
  speedFloor = 0;
  yaw = NaN;
  pitch = NaN;
  turnRate = NaN;
  roll = NaN;
  continuous = false;
  pivot = false;
  /** The seek point is the fish's cave, which it works round rock to reach. */
  homing = false;
  /** A point to keep `shunRadius` away from, pushed off with `shunWeight`; radius 0 for none. */
  shunX = 0;
  shunY = 0;
  shunZ = 0;
  shunRadius = 0;
  shunWeight = 0;
  /** 0 to 1: how far the fins are spread in display. */
  display = 0;
  /** 0 to 1: how far the gill covers are raised in display. */
  gillFlare = 0;
  /** 0 to 1: pectoral fanning over a clutch. */
  fan = 0;

  reset(bandLo: number, bandHi: number): void {
    this.state = FishState.Cruise;
    this.wander = 1;
    this.align = 1;
    this.cohesion = 1;
    this.separation = 1;
    this.cruiseScale = 1;
    this.bandLo = bandLo;
    this.bandHi = bandHi;
    this.seekWeight = 0;
    this.seekSpeed = 0;
    this.seekTau = 1;
    this.arrival = 0;
    this.comfort = 1;
    this.floor = true;
    this.surface = true;
    this.speedCap = Infinity;
    this.speedFloor = 0;
    this.yaw = NaN;
    this.pitch = NaN;
    this.turnRate = NaN;
    this.roll = NaN;
    this.continuous = false;
    this.pivot = false;
    this.homing = false;
    this.shunRadius = 0;
    this.display = 0;
    this.gillFlare = 0;
    this.fan = 0;
  }

  seek(x: number, y: number, z: number, speed: number, tau: number, weight = 1): void {
    this.seekX = x;
    this.seekY = y;
    this.seekZ = z;
    this.seekSpeed = speed;
    this.seekTau = tau;
    this.seekWeight = weight;
  }

  shun(x: number, y: number, z: number, radius: number, weight: number): void {
    this.shunX = x;
    this.shunY = y;
    this.shunZ = z;
    this.shunRadius = radius;
    this.shunWeight = weight;
  }
}

const StartlePhase = { None: 0, Bend: 1, Burst: 2, Flee: 3 } as const;
const TerritoryPhase = { Idle: 0, Approach: 1, Flare: 2, Charge: 3 } as const;
const GulpPhase = { None: 0, Ascend: 1, Hold: 2, Descend: 3 } as const;
const GrazePhase = { None: 0, Approach: 1, Graze: 2, Roam: 3 } as const;

const DT = 1 / 30;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Per-fish behaviour state machines. Each step `update` advances timers, turns stimuli into
 * scheduled startles, fires the startles due this tick (relaying them to neighbours on later
 * ticks, so the result does not depend on fish order), then writes one `Plan` per fish.
 */
export class Behaviour {
  readonly plans: Plan[];
  readonly feeding: Feeding;
  readonly curiosity: Curiosity;
  readonly toys: Toys;
  readonly brood: Brood;
  readonly personality: Personalities;
  readonly greeting: Greeting;
  readonly lighting = new Night();

  private readonly host: BehaviourHost;
  private anchors: readonly Anchor[] = [];
  private readonly stimuli: Stimulus[] = [];

  private startlePhase: Uint8Array;
  private startleTimer: Float64Array;
  private startleElapsed: Float64Array;
  private escapeYaw: Float64Array;
  private escapePitch: Float64Array;
  private startleAt: Float64Array;
  private scheduledYaw: Float64Array;
  private scheduledPitch: Float64Array;
  private refractory: Float64Array;
  private _tighten: Float64Array;
  private habituation: Float64Array;
  private _startledAt: Float64Array;

  private _rest: Float64Array;
  private restTau: Float64Array;
  private restSpot: Float64Array;
  /**
   * Swimmers: 1 once a rest station is chosen. Walkers: 0 unchosen, 1 a nook, 2 none found or
   * given up, 3 on the way to a cave.
   */
  private restSpotSet: Uint8Array;
  private seekTimer: Float64Array;
  /** Walkers on the way to a cave or nook: the closest they have got to it, in plan view. */
  private seekClosest: Float64Array;

  private home: Float64Array;
  private homeTimer: Float64Array;
  private _anchor: Int32Array;
  private _shelterTimer: Float64Array;

  private territoryPhase: Uint8Array;
  private territoryTimer: Float64Array;
  private territoryCheck: Float64Array;
  private territoryCooldown: Float64Array;
  private _yieldTimer: Float64Array;
  private yieldYaw: Float64Array;
  private _territoryTarget: Int32Array;

  private gulpPhase: Uint8Array;
  private gulpTimer: Float64Array;

  private grazePhase: Uint8Array;
  private grazeTimer: Float64Array;
  private grazeNext: Float64Array;
  private grazeTarget: Float64Array;
  private grazeYaw: Float64Array;
  private crawlSign: Float64Array;

  private sifting: Uint8Array;
  private forageTimer: Float64Array;

  private excursion: Uint8Array;
  private excursionTimer: Float64Array;
  private excursionTarget: Float64Array;

  private readonly groupHome: Float64Array;
  private readonly groupTimer: Float64Array;
  private readonly groupSize: Int32Array;
  private readonly groupLeader: Int32Array;

  private readonly nbr: Int32Array;
  private readonly nbrDist: Float64Array;
  private _display: Float64Array;
  private _gillFlare: Float64Array;

  private readonly n3 = new Float64Array(3);
  private readonly greetBoldness = (i: number): number =>
    this.personality.effectiveBoldness(i, this.speciesOf(i).boldness);
  private readonly greetHunger = (i: number): number => this.feeding.motivation(i);
  private bandLo = 0;
  private bandHi = 0;

  get tighten(): Float64Array {
    return this._tighten;
  }

  /** Tick at which each fish last began a startle, or -1. */
  get startledAt(): Float64Array {
    return this._startledAt;
  }

  get rest(): Float64Array {
    return this._rest;
  }

  get anchor(): Int32Array {
    return this._anchor;
  }

  /** Seconds each fish has left hiding in shelter after a startle. */
  get shelterTimer(): Float64Array {
    return this._shelterTimer;
  }

  get yieldTimer(): Float64Array {
    return this._yieldTimer;
  }

  get territoryTarget(): Int32Array {
    return this._territoryTarget;
  }

  /** 0 to 1 per fish: fin spread in display, eased in and out. */
  get display(): Float64Array {
    return this._display;
  }

  /** 0 to 1 per fish: gill covers raised in display, eased in and out. */
  get gillFlare(): Float64Array {
    return this._gillFlare;
  }

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    const s = host.species.length;
    this.plans = Array.from({ length: n }, () => new Plan());
    this.personality = new Personalities(n);
    this.feeding = new Feeding(host, this.personality);
    this.curiosity = new Curiosity(host);
    this.toys = new Toys(host, this.personality);
    this.brood = new Brood(host);
    this.greeting = new Greeting(host);
    this.startlePhase = new Uint8Array(n);
    this.startleTimer = new Float64Array(n);
    this.startleElapsed = new Float64Array(n);
    this.escapeYaw = new Float64Array(n);
    this.escapePitch = new Float64Array(n);
    this.startleAt = new Float64Array(n).fill(-1);
    this.scheduledYaw = new Float64Array(n);
    this.scheduledPitch = new Float64Array(n);
    this.refractory = new Float64Array(n);
    this._tighten = new Float64Array(n);
    this.habituation = new Float64Array(n);
    this._startledAt = new Float64Array(n).fill(-1);
    this._rest = new Float64Array(n);
    this.restTau = new Float64Array(n);
    this.restSpot = new Float64Array(n * 3);
    this.restSpotSet = new Uint8Array(n);
    this.seekTimer = new Float64Array(n);
    this.seekClosest = new Float64Array(n);
    this.home = new Float64Array(n * 3);
    this.homeTimer = new Float64Array(n);
    this._anchor = new Int32Array(n).fill(-1);
    this._shelterTimer = new Float64Array(n);
    this.territoryPhase = new Uint8Array(n);
    this.territoryTimer = new Float64Array(n);
    this.territoryCheck = new Float64Array(n);
    this.territoryCooldown = new Float64Array(n);
    this._yieldTimer = new Float64Array(n);
    this.yieldYaw = new Float64Array(n);
    this._territoryTarget = new Int32Array(n).fill(-1);
    this.gulpPhase = new Uint8Array(n);
    this.gulpTimer = new Float64Array(n);
    this.grazePhase = new Uint8Array(n);
    this.grazeTimer = new Float64Array(n);
    this.grazeNext = new Float64Array(n);
    this.grazeTarget = new Float64Array(n * 3);
    this.grazeYaw = new Float64Array(n);
    this.crawlSign = new Float64Array(n).fill(1);
    this.sifting = new Uint8Array(n);
    this.forageTimer = new Float64Array(n);
    this.excursion = new Uint8Array(n);
    this.excursionTimer = new Float64Array(n);
    this.excursionTarget = new Float64Array(n * 3);
    this._display = new Float64Array(n);
    this._gillFlare = new Float64Array(n);
    this.groupHome = new Float64Array(s * 3);
    this.groupTimer = new Float64Array(s);
    this.groupSize = new Int32Array(s);
    this.groupLeader = new Int32Array(s).fill(-1);
    this.nbr = new Int32Array(BEHAVIOUR.relayNeighbours);
    this.nbrDist = new Float64Array(BEHAVIOUR.relayNeighbours);
  }

  /** Draws each fish's private timers; call once positions are spawned. */
  init(): void {
    for (let i = 0; i < this.host.count; i++) this.drawTimers(i);
    for (let i = 0; i < this.host.count; i++) this.pickHome(i);
  }

  /**
   * Starts fish `i`, just appended by `resize`, as `init` starts every fish, and gives it an
   * anemone or cave if one has room, without moving any other fish from its own.
   */
  addFish(i: number): void {
    this.drawTimers(i);
    this.pickHome(i);
    this.anchor[i] = this.freeAnchor(i);
  }

  /**
   * Follows a fish joining or leaving. A fish whose rival left calls off the contest, and a
   * station group that lost its leader follows its next member.
   */
  resize(edit: FishResize): void {
    if (edit.removed >= 0) this.plans.splice(edit.removed, 1);
    else this.plans.push(new Plan());
    this.startlePhase = edit.array(this.startlePhase);
    this.startleTimer = edit.array(this.startleTimer);
    this.startleElapsed = edit.array(this.startleElapsed);
    this.escapeYaw = edit.array(this.escapeYaw);
    this.escapePitch = edit.array(this.escapePitch);
    this.startleAt = edit.array(this.startleAt, 1, -1);
    this.scheduledYaw = edit.array(this.scheduledYaw);
    this.scheduledPitch = edit.array(this.scheduledPitch);
    this.refractory = edit.array(this.refractory);
    this._tighten = edit.array(this.tighten);
    this.habituation = edit.array(this.habituation);
    this._startledAt = edit.array(this.startledAt, 1, -1);
    this._rest = edit.array(this.rest);
    this.restTau = edit.array(this.restTau);
    this.restSpot = edit.array(this.restSpot, 3);
    this.restSpotSet = edit.array(this.restSpotSet);
    this.seekTimer = edit.array(this.seekTimer);
    this.seekClosest = edit.array(this.seekClosest);
    this.home = edit.array(this.home, 3);
    this.homeTimer = edit.array(this.homeTimer);
    this._anchor = edit.array(this.anchor, 1, -1);
    this._shelterTimer = edit.array(this._shelterTimer);
    this.territoryPhase = edit.array(this.territoryPhase);
    this.territoryTimer = edit.array(this.territoryTimer);
    this.territoryCheck = edit.array(this.territoryCheck);
    this.territoryCooldown = edit.array(this.territoryCooldown);
    this._yieldTimer = edit.array(this.yieldTimer);
    this.yieldYaw = edit.array(this.yieldYaw);
    this._territoryTarget = edit.array(this.territoryTarget, 1, -1);
    this.gulpPhase = edit.array(this.gulpPhase);
    this.gulpTimer = edit.array(this.gulpTimer);
    this.grazePhase = edit.array(this.grazePhase);
    this.grazeTimer = edit.array(this.grazeTimer);
    this.grazeNext = edit.array(this.grazeNext);
    this.grazeTarget = edit.array(this.grazeTarget, 3);
    this.grazeYaw = edit.array(this.grazeYaw);
    this.crawlSign = edit.array(this.crawlSign, 1, 1);
    this.sifting = edit.array(this.sifting);
    this.forageTimer = edit.array(this.forageTimer);
    this.excursion = edit.array(this.excursion);
    this.excursionTimer = edit.array(this.excursionTimer);
    this.excursionTarget = edit.array(this.excursionTarget, 3);
    this._display = edit.array(this.display);
    this._gillFlare = edit.array(this.gillFlare);
    this.feeding.resize(edit);
    this.curiosity.resize(edit);
    this.toys.resize(edit);
    this.brood.resize(edit);
    this.personality.resize(edit);
    this.greeting.resize(edit);
    if (edit.removed < 0) return;
    for (let i = 0; i < this.territoryTarget.length; i++) {
      const j = edit.index(at(this.territoryTarget, i));
      this.territoryTarget[i] = j;
      // Not `endTerritory`: that draws a cooldown, and the rival only left the tank.
      if (j < 0) this.territoryPhase[i] = TerritoryPhase.Idle;
    }
    const leaders = this.groupLeader;
    for (let s = 0; s < leaders.length; s++) leaders[s] = edit.index(at(leaders, s));
    this.groupSize.fill(0);
    for (let i = 0; i < this.host.count; i++) {
      const sp = this.speciesOf(i);
      if (sp.home !== 'station' || !sp.schooling) continue;
      const si = at(this.host.speciesIndex, i);
      this.groupSize[si] = at(this.groupSize, si) + 1;
      if (at(leaders, si) < 0) leaders[si] = i;
    }
  }

  private drawTimers(i: number): void {
    const { rng } = this.host;
    const sp = this.speciesOf(i);
    const si = at(this.host.speciesIndex, i);
    this.restTau[i] = BEHAVIOUR.restTauS * (1 + BEHAVIOUR.restTauJitter * rng.signed());
    this.territoryCheck[i] = rng.range(0, BEHAVIOUR.territoryCheckS);
    this.grazeNext[i] = rng.range(0, sp.grazeMeanIntervalS);
    this.crawlSign[i] = rng.next() < 0.5 ? -1 : 1;
    this.forageTimer[i] = rng.range(BEHAVIOUR.moveMinS, BEHAVIOUR.moveMaxS);
    this.excursionTimer[i] = rng.range(0, 2 * sp.excursionMeanIntervalS);
    if (sp.home === 'station' && sp.schooling) {
      this.groupSize[si] = at(this.groupSize, si) + 1;
      if (at(this.groupLeader, si) < 0) this.groupLeader[si] = i;
    }
  }

  /**
   * The anchor a newly added fish takes: the anemone holding the fewest of its species (they
   * live in pairs, as `setAnchors` deals them out), or a cave none of its species holds; -1 if
   * there is none. Walkers share caves instead (see `walkerCave`).
   */
  private freeAnchor(i: number): number {
    const sp = this.speciesOf(i);
    if (sp.walking !== null) return sp.home === 'cave' ? this.walkerCave(i) : -1;
    const kind = sp.home === 'anemone' || sp.home === 'cave' ? sp.home : null;
    if (kind === null) return -1;
    const own = at(this.host.speciesIndex, i);
    let best = -1;
    let bestHeld = Infinity;
    for (let k = 0; k < this.anchors.length; k++) {
      if (this.anchors[k]?.kind !== kind) continue;
      let held = 0;
      for (let j = 0; j < this.host.count; j++) {
        if (j !== i && at(this.anchor, j) === k && at(this.host.speciesIndex, j) === own) held++;
      }
      if (held < bestHeld) {
        best = k;
        bestHeld = held;
      }
    }
    return kind === 'cave' && bestHeld > 0 ? -1 : best;
  }

  /**
   * The cave walker `i` moves into: the nearest in plan view with room for another walker, the
   * one holding fewer on a tie, then the lower index; -1 when every cave is full. Room grows with
   * the cave's floor area over the species' size, since shrimp crowd into a shared refuge rather
   * than defend one.
   */
  private walkerCave(i: number): number {
    const length = this.speciesOf(i).bodyLength;
    const px = at(this.host.position, i * 3);
    const pz = at(this.host.position, i * 3 + 2);
    let best = -1;
    let bestDist = Infinity;
    let bestHeld = Infinity;
    for (let k = 0; k < this.anchors.length; k++) {
      const a = this.anchors[k];
      if (a?.kind !== 'cave') continue;
      const room = Math.max(1, Math.floor(BEHAVIOUR.walkerCaveShare * (a.radius / length) ** 2));
      let held = 0;
      for (let j = 0; j < this.host.count; j++) {
        if (j !== i && at(this.anchor, j) === k && this.speciesOf(j).walking !== null) held++;
      }
      if (held >= room) continue;
      const dist = Math.hypot(a.position[0] - px, a.position[2] - pz);
      if (dist < bestDist || (dist === bestDist && held < bestHeld)) {
        best = k;
        bestDist = dist;
        bestHeld = held;
      }
    }
    return best;
  }

  setAnchors(anchors: readonly Anchor[]): void {
    const { basin } = this.host;
    const ids = new Set<string>();
    for (const a of anchors) {
      if (typeof a.id !== 'string' || a.id === '') {
        throw new RangeError(`anchor id must be a non-empty string, got ${String(a.id)}`);
      }
      if (ids.has(a.id)) throw new Error(`anchor ids must be unique, "${a.id}" repeats`);
      ids.add(a.id);
      if (a.kind !== 'anemone' && a.kind !== 'cave') {
        throw new RangeError(
          `anchor "${a.id}": kind must be "anemone" or "cave", got ${String(a.kind)}`,
        );
      }
      if (!Array.isArray(a.position) || a.position.length !== 3) {
        throw new RangeError(`anchor "${a.id}": position must be an [x, y, z] array`);
      }
      if (a.facing !== undefined) {
        const f = a.facing;
        const valid =
          Array.isArray(f) && f.length === 3 && f.every(Number.isFinite) && Math.hypot(...f) > 1e-9;
        if (!valid) {
          throw new RangeError(`anchor "${a.id}": facing must be a finite, non-zero [x, y, z]`);
        }
      }
      const [x, y, z] = a.position;
      const inside =
        x > basin.minX &&
        x < basin.maxX &&
        z > basin.minZ &&
        z < basin.maxZ &&
        y > basin.ground(x, z) &&
        y < basin.maxY;
      if (!inside) throw new RangeError(`anchor "${a.id}" lies outside the tank`);
      if (!(Number.isFinite(a.radius) && a.radius > 0)) {
        throw new RangeError(`anchor "${a.id}": radius must be positive, got ${a.radius}`);
      }
    }
    this.anchors = anchors;
    this.anchor.fill(-1);
    // A swimmer's rest station does not depend on the anchors, so only walkers choose again.
    for (let i = 0; i < this.host.count; i++) {
      if (this.speciesOf(i).walking !== null) this.restSpotSet[i] = 0;
    }
    const ordinal = new Map<string, number>();
    for (let i = 0; i < this.host.count; i++) {
      const sp = this.speciesOf(i);
      const kind = sp.home === 'anemone' || sp.home === 'cave' ? sp.home : null;
      if (kind === null) continue;
      if (sp.walking !== null) {
        this.anchor[i] = this.walkerCave(i);
        continue;
      }
      const matching = anchors.flatMap((a, k) => (a.kind === kind ? [k] : []));
      if (matching.length === 0) continue;
      const k = ordinal.get(sp.id) ?? 0;
      ordinal.set(sp.id, k + 1);
      // Clownfish live in pairs per anemone; gramma each take a cave of their own.
      const pick = kind === 'anemone' ? Math.floor(k / 2) : k;
      // A gramma without a cave of its own holds a mid-water station instead of fighting for one.
      if (kind === 'cave' && pick >= matching.length) continue;
      this.anchor[i] = matching[pick % matching.length] ?? -1;
    }
  }

  startle(stimulus: Stimulus): void {
    const [x, y, z] = stimulus.position;
    if (![x, y, z, stimulus.intensity].every(Number.isFinite)) {
      throw new RangeError('startle: position and intensity must be finite numbers');
    }
    if (stimulus.intensity < 0 || stimulus.intensity > 1) {
      throw new RangeError(`startle: intensity must be within [0, 1], got ${stimulus.intensity}`);
    }
    // Taps queued while the host is stopped are stale by the time it runs again; keep the newest.
    if (this.stimuli.length >= BEHAVIOUR.maxQueuedStimuli) this.stimuli.shift();
    this.stimuli.push(stimulus);
  }

  setLure(position: Point3 | null): void {
    this.curiosity.setLure(position);
  }

  setToys(toys: readonly SimToy[]): void {
    this.toys.setToys(toys);
  }

  setBrood(brood: SimBrood): void {
    this.brood.setBrood(brood);
  }

  /**
   * A spot for the clutch of the parents at `indices`: beside the anemone or cave of the first
   * that has one, else its station or where it is.
   */
  nestSite(indices: readonly number[]): Point3 | null {
    const first = indices[0];
    if (first === undefined) throw new RangeError('nestSite: needs at least one parent');
    let length = 0;
    for (const i of indices) length = Math.max(length, at(this.host.bodyLength, i));
    for (const i of indices) {
      const a = this.anchors[at(this.anchor, i)];
      if (a === undefined) continue;
      return this.brood.nestSite(...a.position, a.radius + length, length);
    }
    const src = this.speciesOf(first).home === 'none' ? this.host.position : this.home;
    return this.brood.nestSite(
      at(src, first * 3),
      at(src, first * 3 + 1),
      at(src, first * 3 + 2),
      2 * length,
      length,
    );
  }

  setVisitor(visitor: Visitor | null): void {
    this.greeting.setVisitor(visitor);
  }

  get light(): number {
    return this.lighting.light;
  }

  setLight(level: number): void {
    this.lighting.setLight(level);
  }

  isStartled(i: number): boolean {
    return at(this.startlePhase, i) !== StartlePhase.None;
  }

  update(): void {
    const n = this.host.count;
    const shock = this.lighting.step();
    const habDecay = Math.exp(-DT / BEHAVIOUR.habituationTauS);
    for (let i = 0; i < n; i++) {
      this.refractory[i] = Math.max(0, at(this.refractory, i) - DT);
      this.tighten[i] = Math.max(0, at(this.tighten, i) - DT);
      this._shelterTimer[i] = Math.max(0, at(this._shelterTimer, i) - DT);
      this.habituation[i] = at(this.habituation, i) * habDecay;
      const r = at(this.rest, i);
      const restTarget = this.lighting.restTarget(this.speciesOf(i).activity);
      this.rest[i] = r + (restTarget - r) * (1 - Math.exp(-DT / at(this.restTau, i)));
    }
    this.updateGroups();
    if (shock > 0) this.applyLightStartle(shock);
    for (const s of this.stimuli) this.applyStimulus(s);
    this.stimuli.length = 0;
    const tick = this.host.tick;
    for (let i = 0; i < n; i++) {
      if (at(this.startleAt, i) === tick) {
        this.startleAt[i] = -1;
        this.beginStartle(i, at(this.scheduledYaw, i), at(this.scheduledPitch, i));
      }
    }
    this.brood.update(this.rest);
    this.prepareFeeding();
    this.feeding.update();
    this.prepareCuriosity();
    this.curiosity.update(this.feeding);
    this.toys.update(this.curiosity.follow);
    this.greeting.update(this.greetBoldness, this.greetHunger);
    const ease = 1 - Math.exp(-DT / TOYS.displayTauS);
    for (let i = 0; i < n; i++) {
      this.plan(i);
      const plan = this.plans[i];
      if (plan === undefined) throw new RangeError(`no plan for fish ${i}`);
      if (plan.state !== FishState.Startle && plan.state !== FishState.Feed) {
        this.toys.shun(i, this.speciesOf(i), plan);
      }
      if (plan.state !== FishState.Startle) this.brood.shunPredator(i, plan);
      this.brood.ease(i, plan);
      const d = at(this.display, i);
      this.display[i] = d + (plan.display - d) * ease;
      const g = at(this.gillFlare, i);
      this.gillFlare[i] = g + (plan.gillFlare - g) * ease;
    }
  }

  /** Who may feed this step, and how far an anchored fish will leave its anemone or cave. */
  private prepareFeeding(): void {
    const { eligible, leash } = this.feeding;
    for (let i = 0; i < this.host.count; i++) {
      eligible[i] =
        at(this.startlePhase, i) === StartlePhase.None &&
        at(this.startleAt, i) < 0 &&
        at(this.yieldTimer, i) <= 0 &&
        at(this.gulpPhase, i) === GulpPhase.None &&
        at(this._shelterTimer, i) <= 0 &&
        (at(this.rest, i) <= 0.5 || this.lighting.restsInLight(this.speciesOf(i).activity))
          ? 1
          : 0;
      if (this.brood.fryLeash(i, leash)) continue;
      const a = this.anchors[at(this.anchor, i)];
      const o = i * 4;
      if (a === undefined) {
        const c = this.brood.clutchPoint(i);
        if (c === null) {
          leash[o + 3] = Infinity;
          continue;
        }
        leash.set(c, o);
        leash[o + 3] = FEEDING.leashBodyLengths * at(this.host.bodyLength, i);
        continue;
      }
      leash[o] = a.position[0];
      leash[o + 1] = a.position[1];
      leash[o + 2] = a.position[2];
      leash[o + 3] = a.radius + FEEDING.leashBodyLengths * at(this.host.bodyLength, i);
    }
  }

  /**
   * A fish busy with food, a rival or anything that already stops it feeding has no attention
   * for a lure, a toy or its feeding spot, and one playing with a toy none for a lure; an
   * anchored fish goes no further for them than an excursion.
   */
  private prepareCuriosity(): void {
    const f = this.feeding;
    const { eligible, leash } = this.curiosity;
    const toys = this.toys;
    for (let i = 0; i < this.host.count; i++) {
      const free =
        this.speciesOf(i).walking === null &&
        at(f.eligible, i) === 1 &&
        at(f.target, i) < 0 &&
        at(f.follow, i) < 0 &&
        at(f.handling, i) <= 0 &&
        at(this.territoryPhase, i) === TerritoryPhase.Idle &&
        !this.brood.busy(i);
      eligible[i] = free && !toys.engaged(i) ? 1 : 0;
      toys.eligible[i] = free ? 1 : 0;
      this.greeting.eligible[i] = eligible[i] ?? 0;
      const a = this.anchors[at(this.anchor, i)];
      const o = i * 4;
      if (a === undefined) {
        leash[o + 3] = Infinity;
        toys.leash[o + 3] = Infinity;
        continue;
      }
      leash[o] = a.position[0];
      leash[o + 1] = a.position[1];
      leash[o + 2] = a.position[2];
      leash[o + 3] = a.radius + CURIOSITY.lureLeashBodyLengths * at(this.host.bodyLength, i);
      toys.leash.set(leash.subarray(o, o + 4), o);
    }
  }

  private speciesOf(i: number): SimSpecies {
    const s = this.host.species[at(this.host.speciesIndex, i)];
    if (s === undefined) throw new RangeError(`no fish at index ${i}`);
    return s;
  }

  /** The species' depth band over (x, z), as heights: fractions of the water column above the sand there. */
  private bandAt(i: number, x: number, z: number): void {
    const sp = this.speciesOf(i);
    const { basin } = this.host;
    const g = basin.ground(x, z);
    const h = basin.maxY - g;
    const drop = BEHAVIOUR.restBandDrop * at(this.rest, i) * h;
    this.bandLo = g + Math.max(0, sp.depthLow * h - drop);
    this.bandHi = g + Math.max(0, sp.depthHigh * h - drop);
  }

  private updateGroups(): void {
    const { species } = this.host;
    for (let s = 0; s < species.length; s++) {
      const leader = at(this.groupLeader, s);
      if (leader < 0) continue;
      const left = at(this.groupTimer, s) - DT;
      this.groupTimer[s] = left;
      if (left > 0) continue;
      this.chooseStation(leader, this.groupHome, s * 3);
      const sp = this.speciesOf(leader);
      this.groupTimer[s] = this.host.rng.range(sp.restationMinS, sp.restationMaxS);
    }
  }

  private pickHome(i: number): void {
    const sp = this.speciesOf(i);
    if (sp.home === 'none') return;
    this.chooseStation(i, this.home, i * 3);
    this.homeTimer[i] = this.host.rng.range(sp.restationMinS, sp.restationMaxS);
  }

  /**
   * Hard decor moved: any station, group station, swimmer rest spot or hiding spot the decor now
   * covers is chosen again soon. Walker nooks are rechecked every step by `nookHolds`.
   */
  decorMoved(): void {
    const { count, species } = this.host;
    for (let s = 0; s < species.length; s++) {
      const leader = at(this.groupLeader, s);
      if (leader >= 0 && this.covered(leader, this.groupHome, s * 3)) this.groupTimer[s] = 0;
    }
    for (let i = 0; i < count; i++) {
      const sp = this.speciesOf(i);
      if (sp.home !== 'none' && this.covered(i, this.home, i * 3)) this.homeTimer[i] = 0;
      if (
        sp.walking === null &&
        this.restSpotSet[i] === 1 &&
        this.covered(i, this.restSpot, i * 3)
      ) {
        this.restSpotSet[i] = 0;
      }
    }
    this.brood.decorMoved();
  }

  private covered(i: number, spots: Float64Array, o: number): boolean {
    const d = this.host.sceneSdf.sample(at(spots, o), at(spots, o + 1), at(spots, o + 2), this.n3);
    return d < at(this.host.radius, i);
  }

  /**
   * Picks a hovering spot inside the band: clear of geometry, preferably about 1.5 body lengths
   * from hard decor (fish hold station by structure), and not far from where the fish is.
   */
  private chooseStation(i: number, out: Float64Array, o: number): void {
    const { basin, rng, sceneSdf, decorSdf, position } = this.host;
    const length = at(this.host.bodyLength, i);
    const radius = at(this.host.radius, i);
    const margin = radius + length;
    const n3 = this.n3;
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    let best = Infinity;
    let bx = px;
    let by = py;
    let bz = pz;
    for (let c = 0; c < BEHAVIOUR.stationCandidates; c++) {
      const x = rng.range(basin.minX + margin, basin.maxX - margin);
      // Drawn before z (the band depends on the sand under x, z), but consumed as y.
      const t = rng.next();
      const z = rng.range(basin.minZ + margin, basin.maxZ - margin);
      this.bandAt(i, x, z);
      const yLo = Math.max(this.bandLo, basin.ground(x, z) + margin);
      const yHi = Math.max(yLo, Math.min(this.bandHi, basin.maxY - margin));
      const y = yLo + (yHi - yLo) * t;
      if (sceneSdf.sample(x, y, z, n3) < margin) continue;
      const toDecor =
        decorSdf === null
          ? 0
          : Math.abs(decorSdf.sample(x, y, z, n3) - BEHAVIOUR.stationDecorBodyLengths * length);
      const score = toDecor + BEHAVIOUR.stationTravelWeight * Math.hypot(x - px, y - py, z - pz);
      if (score < best) {
        best = score;
        bx = x;
        by = y;
        bz = z;
      }
    }
    out[o] = bx;
    out[o + 1] = by;
    out[o + 2] = bz;
  }

  private responsiveness(i: number): number {
    return (
      (1 - BEHAVIOUR.restStartleDamping * at(this.rest, i)) /
      (1 + BEHAVIOUR.habituationPerResponse * at(this.habituation, i))
    );
  }

  private canStartle(i: number): boolean {
    return (
      at(this.refractory, i) <= 0 &&
      at(this.startlePhase, i) === StartlePhase.None &&
      at(this.startleAt, i) < 0
    );
  }

  private schedule(i: number, tick: number, yaw: number, pitch: number): void {
    this.startleAt[i] = tick;
    this.scheduledYaw[i] = yaw;
    this.scheduledPitch[i] = pitch;
  }

  private applyStimulus(s: Stimulus): void {
    const { position, rng } = this.host;
    const [sx, sy, sz] = s.position;
    const range = BEHAVIOUR.stimulusRangeM;
    for (let i = 0; i < this.host.count; i++) {
      if (!this.canStartle(i)) continue;
      const dx = at(position, i * 3) - sx;
      const dy = at(position, i * 3 + 1) - sy;
      const dz = at(position, i * 3 + 2) - sz;
      const d = Math.hypot(dx, dy, dz);
      if (d >= range) continue;
      const sp = this.speciesOf(i);
      const p =
        s.intensity *
        (1 - d / range) *
        (1 - BEHAVIOUR.boldnessDamping * this.personality.effectiveBoldness(i, sp.boldness)) *
        this.responsiveness(i);
      if (rng.next() >= p) continue;
      // Escape trajectories are bimodal, straight away (~180°) or ~130° from the stimulus.
      const away = Math.atan2(dx, dz);
      const own = at(this.host.yaw, i);
      let yaw = away;
      if (rng.next() >= BEHAVIOUR.escapeAwayShare) {
        const side = wrapAngle(own - away) >= 0 ? 1 : -1;
        yaw = away + side * BEHAVIOUR.escapeOffsetRad;
      }
      yaw = wrapAngle(yaw + BEHAVIOUR.escapeNoiseRad * rng.gaussian());
      const pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -sp.maxPitch, sp.maxPitch) * 0.5;
      this.schedule(i, this.host.tick, yaw, pitch);
    }
  }

  /**
   * A sudden change of the tank light: every swimmer that can see it may C-start, `intensity`
   * playing the part of a tap's strength at the fish. With no point source each turns away from
   * its own heading to a random side, so the school scatters, and the relay spreads it on.
   */
  private applyLightStartle(intensity: number): void {
    const { rng, yaw } = this.host;
    for (let i = 0; i < this.host.count; i++) {
      const sp = this.speciesOf(i);
      if (sp.walking !== null || !this.canStartle(i)) continue;
      const p =
        intensity *
        (1 - BEHAVIOUR.boldnessDamping * this.personality.effectiveBoldness(i, sp.boldness)) *
        this.responsiveness(i);
      if (rng.next() >= p) continue;
      const side = rng.next() < 0.5 ? -1 : 1;
      const turn = rng.range(BEHAVIOUR.escapeOffsetRad, Math.PI);
      this.schedule(i, this.host.tick, wrapAngle(at(yaw, i) + side * turn), 0);
    }
  }

  private beginStartle(i: number, yaw: number, pitch: number): void {
    if (at(this.refractory, i) > 0 || at(this.startlePhase, i) !== StartlePhase.None) return;
    const sp = this.speciesOf(i);
    const w = sp.walking;
    if (w === null) {
      this.startlePhase[i] = StartlePhase.Bend;
      this.startleTimer[i] = BEHAVIOUR.cBendMaxS;
      this.refractory[i] = BEHAVIOUR.refractoryS;
    } else if (w.escape === 'tail-flip') {
      // A walker has no C-bend: its tail-flip is the whole burst.
      this.startlePhase[i] = StartlePhase.Burst;
      this.startleTimer[i] = w.flipDurationS;
      this.refractory[i] = w.flipRefractoryS;
    } else {
      // Withdrawn into its shell it feels no further tap, so the time inside is the refractory.
      this.startlePhase[i] = StartlePhase.Flee;
      this.startleTimer[i] = this.host.rng.range(w.withdrawMinS, w.withdrawMaxS);
      this.refractory[i] = 0;
    }
    this.startleElapsed[i] = 0;
    this.escapeYaw[i] = yaw;
    this.escapePitch[i] = pitch;
    if (sp.tightenWhenStartled) this.tighten[i] = BEHAVIOUR.tightenS;
    this.habituation[i] = at(this.habituation, i) + 1;
    this.startledAt[i] = this.host.tick;
    this.territoryPhase[i] = TerritoryPhase.Idle;
    this.gulpPhase[i] = GulpPhase.None;
    if (this.grazePhase[i] !== GrazePhase.Roam) this.grazePhase[i] = GrazePhase.None;
    this.excursion[i] = 0;
    if (sp.home === 'cave') {
      this._shelterTimer[i] = sp.shelterAfterStartleS * this.personality.shelter(i);
    }
    this.relay(i, yaw, pitch);
  }

  /**
   * Neighbours that can see the startled fish copy its escape a step or two later, with a
   * probability that falls with log distance and neighbour rank (Rosenthal et al. 2015).
   */
  private relay(i: number, yaw: number, pitch: number): void {
    const { position, forward, distSq, rng, count } = this.host;
    const k = selectNearest(
      distSq,
      count,
      i,
      BEHAVIOUR.relayNeighbours,
      null,
      Infinity,
      this.nbr,
      0,
      this.nbrDist,
    );
    const ix = at(position, i * 3);
    const iy = at(position, i * 3 + 1);
    const iz = at(position, i * 3 + 2);
    for (let m = 0; m < k; m++) {
      const j = at(this.nbr, m);
      if (!this.canStartle(j)) continue;
      const sj = this.speciesOf(j);
      const dx = ix - at(position, j * 3);
      const dy = iy - at(position, j * 3 + 1);
      const dz = iz - at(position, j * 3 + 2);
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-9 && sj.perceptionFov < 2 * Math.PI) {
        const cos =
          (dx * at(forward, j * 3) + dy * at(forward, j * 3 + 1) + dz * at(forward, j * 3 + 2)) / d;
        if (cos < Math.cos(sj.perceptionFov / 2)) continue;
      }
      const lj = at(this.host.bodyLength, j);
      const logit =
        BEHAVIOUR.relayIntercept +
        BEHAVIOUR.relayLogDistance * Math.log(Math.max(d, 1e-3) / lj) +
        BEHAVIOUR.relayRank * m;
      if (rng.next() >= sigmoid(logit) * this.responsiveness(j)) continue;
      const latency = rng.next() < 0.5 ? 1 : 2;
      this.schedule(
        j,
        this.host.tick + latency,
        wrapAngle(yaw + BEHAVIOUR.relayNoiseRad * rng.gaussian()),
        pitch,
      );
    }
  }

  private plan(i: number): void {
    const sp = this.speciesOf(i);
    const plan = this.plans[i];
    if (plan === undefined) throw new RangeError(`no plan for fish ${i}`);
    this.bandAt(i, at(this.host.position, i * 3), at(this.host.position, i * 3 + 2));
    plan.reset(this.bandLo, this.bandHi);
    const rest = at(this.rest, i);
    const calm = 1 - (1 - BEHAVIOUR.restSpeedFactor) * rest;
    plan.cruiseScale = calm * this.personality.activity(i);
    plan.wander = calm;
    if (sp.walking !== null) {
      this.planWalker(i, sp.walking, plan, rest);
      return;
    }
    const school = 1 - (1 - BEHAVIOUR.restSchoolFactor) * rest;
    plan.align = school * (sp.shoal ? BEHAVIOUR.shoalAlignment : 1) * this.personality.alignment(i);
    plan.cohesion =
      school * (sp.shoal ? BEHAVIOUR.shoalCohesion : 1) * this.personality.cohesion(i);
    if (at(this.tighten, i) > 0) {
      plan.cohesion *= BEHAVIOUR.tightenCohesion;
      plan.separation *= BEHAVIOUR.tightenSeparation;
    }
    this.brood.adjust(i, plan);
    if (sp.gait === 'cruise') {
      plan.speedFloor =
        BEHAVIOUR.cruiseSpeedFloor * at(this.host.cruiseSpeed, i) * plan.cruiseScale;
    }

    if (at(this.startlePhase, i) !== StartlePhase.None) {
      this.planStartle(i, sp, plan);
      return;
    }
    if (at(this.yieldTimer, i) > 0) {
      this.planYield(i, plan);
      return;
    }
    if (this.planFeed(i, sp, plan)) return;
    if (sp.territorial) this.updateTerritory(i, sp);
    if (at(this.territoryPhase, i) !== TerritoryPhase.Idle) {
      this.planTerritory(i, sp, plan);
      return;
    }
    if (at(this.gulpPhase, i) !== GulpPhase.None) {
      this.planGulp(i, plan);
      return;
    }
    if (this.planShelter(i, sp, plan)) return;
    if (this.brood.planTend(i, plan)) return;
    if (this.brood.hides(i)) {
      this.planHide(i, plan);
      return;
    }
    if (this.toys.planMirror(i, sp, plan)) return;
    if (this.toys.planBall(i, sp, plan)) return;
    if (this.planLure(i, sp, plan)) return;
    if (this.planGreet(i, sp, plan)) return;
    if (this.planSpot(i, sp, plan)) return;
    const guard = at(this.anchor, i) < 0 ? this.brood.guard(i) : null;
    if (guard !== null) {
      const [gx, gy, gz] = guard;
      const length = at(this.host.bodyLength, i);
      this.holdStation(
        i,
        plan,
        gx,
        gy + length,
        gz,
        BROOD.guardBodyLengths * length,
        FishState.Station,
      );
    } else if (sp.gait === 'forage' && !this.grazesInsteadOfForaging(i, sp, rest)) {
      this.grazePhase[i] = GrazePhase.None;
      this.planForage(i, sp, plan);
    } else if (sp.grazer === 'glass') {
      this.planGlassGrazer(i, plan, rest);
    } else if (at(this.anchor, i) >= 0) {
      this.planAnchored(i, sp, plan);
    } else if (sp.home !== 'none') {
      this.planStation(i, sp, plan);
    } else {
      this.planFree(i, sp, plan);
    }
    if (rest > 0.5 && (plan.state === FishState.Cruise || plan.state === FishState.Station)) {
      plan.state = FishState.Rest;
    }
  }

  /**
   * Swims to the food particle the feeding layer assigned, or towards a neighbour that is feeding.
   * Feeding loosens the school but keeps separation, and lets the fish reach food lying on the
   * substrate or floating at the surface.
   */
  private planFeed(i: number, sp: SimSpecies, plan: Plan): boolean {
    const f = this.feeding;
    const k = at(f.target, i);
    const j = at(f.follow, i);
    const handling = at(f.handling, i) > 0;
    if (k < 0 && j < 0 && !handling) return false;
    if (at(this.gulpPhase, i) !== GulpPhase.None) return false;
    if (at(this.territoryPhase, i) !== TerritoryPhase.Idle) this.endTerritory(i);
    const { position, food, basin } = this.host;
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    const motivation = f.motivation(i);
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    plan.align *= FEEDING.schoolFactor;
    plan.cohesion *= FEEDING.schoolFactor;
    plan.wander *= 0.3;
    const pursuit = cruise + (FEEDING.pursuitSpeedFraction * vmax - cruise) * motivation;
    if (k < 0 && !handling) {
      const tx = at(position, j * 3);
      const ty = at(position, j * 3 + 1);
      const tz = at(position, j * 3 + 2);
      this.widenBand(plan, ty, length);
      plan.seek(tx, ty, tz, Math.max(cruise, 0.5 * pursuit), 0.5, 0.5);
      return true;
    }
    plan.state = FishState.Feed;
    plan.speedFloor = 0;
    if (k < 0) {
      plan.speedCap = FEEDING.grazeSpeedFactor * cruise;
      plan.wander = 0;
      return true;
    }
    const fx = at(food.position, k * 3);
    const fy = at(food.position, k * 3 + 1);
    const fz = at(food.position, k * 3 + 2);
    const floorY = basin.ground(fx, fz);
    const ty = feedingHeight(fy, length, floorY, basin.maxY);
    this.widenBand(plan, ty, length);
    const d = Math.hypot(fx - px, ty - py, fz - pz);
    if (d < 2 * length) plan.comfort = FEEDING.approachComfort;
    if (sp.gait === 'forage' && fy - floorY < length) {
      plan.floor = false;
      if (d < 2 * length) plan.pitch = Math.max(BEHAVIOUR.siftPitchRad, -sp.maxPitch);
    }
    if (f.grazes(k)) {
      plan.arrival = (FEEDING.mouthBodyLengths + 0.75 * FEEDING.biteReachBodyLengths) * length;
    }
    if (handling) {
      plan.speedCap = FEEDING.grazeSpeedFactor * cruise;
      plan.seek(fx, ty, fz, FEEDING.grazeSpeedFactor * cruise, 0.5);
      return true;
    }
    plan.seek(fx, ty, fz, pursuit, 0.25);
    const brake = FEEDING.brakeBodyLengths * length;
    if (d < brake) {
      // The final approach is slow, steady swimming with the full will to turn, so a fish comes
      // round onto food beside it instead of circling it; arriving at speed would also carry
      // the snout into the sand or glass the food lies against.
      const slow = FEEDING.strikeSpeedFactor * cruise;
      plan.speedCap = slow + (pursuit - slow) * (d / brake);
      plan.continuous = true;
      plan.wander = 0;
      // Browsers work an attached item (a nori clip, a wafer) head-on, manoeuvring on the spot
      // with their fins as they do over rock rather than swimming arcs past it.
      const grazed = f.grazes(k);
      plan.pivot = grazed && d < length;
      const facing = grazed ? NaN : this.facingInsideTurnCircle(i, fx, fz);
      if (!Number.isNaN(facing)) {
        // Swimming on at any speed past food abeam only circles it; the fish holds back until
        // the turn on the spot has brought the food round in front of it.
        plan.pivot = true;
        plan.speedCap *= Math.max(0, facing);
      }
    } else if (sp.gait === 'forage') {
      // Food smelt behind a bottom forager: it turns round on the spot over the sand, as a cory
      // does, where swinging a cruising arc near the floor loses way and dithers.
      const o = i * 3;
      const hx = at(this.host.forward, o);
      const hz = at(this.host.forward, o + 2);
      const ahead =
        (hx * (fx - px) + hz * (fz - pz)) /
        (Math.hypot(hx, hz) * Math.hypot(fx - px, fz - pz) || 1);
      if (ahead < 0) {
        plan.pivot = true;
        plan.speedCap = 0;
      }
    }
    return true;
  }

  /**
   * For (x, z) inside either circle fish `i` sweeps turning on its cruising arc, the cosine of its
   * bearing off the heading; NaN outside them. Food there can never be brought onto the heading by
   * swimming on, so the fish brakes and turns on the spot instead, as fish do in a strike turn.
   */
  private facingInsideTurnCircle(i: number, x: number, z: number): number {
    const o = i * 3;
    const fx = at(this.host.forward, o);
    const fz = at(this.host.forward, o + 2);
    const h = Math.hypot(fx, fz);
    const rx = x - at(this.host.position, o);
    const rz = z - at(this.host.position, o + 2);
    const d = Math.hypot(rx, rz);
    if (h < 1e-9 || d < 1e-9) return NaN;
    const ahead = (rx * fx + rz * fz) / h;
    const side = Math.abs(rx * fz - rz * fx) / h;
    const r = this.host.cruiseTurnRadius(i);
    return (side - r) * (side - r) + ahead * ahead < r * r ? ahead / d : NaN;
  }

  /**
   * Closes on the lure as the fish last saw it and holds a little way off it, facing it: against
   * the glass the stand-off is taken from the pane, in open water the fish slows to a hover.
   */
  private planLure(i: number, sp: SimSpecies, plan: Plan): boolean {
    const c = this.curiosity;
    if (at(c.follow, i) !== 1) return false;
    const o = i * 3;
    const sx = at(c.seen, o);
    const sy = at(c.seen, o + 1);
    const sz = at(c.seen, o + 2);
    const { position } = this.host;
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    const d = Math.hypot(sx - at(position, o), sy - at(position, o + 1), sz - at(position, o + 2));
    plan.align *= CURIOSITY.lureSchoolFactor;
    plan.cohesion *= CURIOSITY.lureSchoolFactor;
    plan.wander *= 0.3;
    this.widenBand(plan, sy, length);
    plan.arrival = (FEEDING.mouthBodyLengths + CURIOSITY.lureStandoffBodyLengths) * length;
    const speed = Math.min(
      FEEDING.pursuitSpeedFraction * vmax,
      Math.max(cruise * (1 + sp.curiosity), (d - plan.arrival) / CURIOSITY.lureCatchUpS),
    );
    plan.seek(sx, sy, sz, speed, 0.5);
    plan.speedFloor = 0;
    plan.speedCap = speed * clamp((d - plan.arrival) / (2 * length), 0, 1);
    return true;
  }

  /**
   * Comes to the front glass where the owner stands and hovers a little way off it, facing out;
   * bottom foragers come along the sand. A fish anchored too far from the spot stays home.
   */
  private planGreet(i: number, sp: SimSpecies, plan: Plan): boolean {
    const g = this.greeting;
    if (at(g.active, i) !== 1) return false;
    const { basin, position } = this.host;
    const length = at(this.host.bodyLength, i);
    const x = clamp(
      at(g.point, 0) + at(g.offset, i * 2) * length,
      basin.minX + length,
      basin.maxX - length,
    );
    if (sp.gait === 'forage') {
      // Seeking the corner where sand meets glass drives a bottom forager's snout into one or
      // the other, so it holds station on the sand a little way back from the pane instead.
      const z = basin.maxZ - (FEEDING.mouthBodyLengths + GREETING.standoffBodyLengths + 1) * length;
      const ground = basin.ground(at(position, i * 3), at(position, i * 3 + 2));
      const mid = 0.5 * (BEHAVIOUR.forageBandLowBodyLengths + BEHAVIOUR.forageBandHighBodyLengths);
      const y = basin.ground(x, z) + mid * length;
      if (!this.withinCuriosityLeash(i, x, y, z)) return false;
      plan.floor = false;
      plan.bandLo = ground + BEHAVIOUR.forageBandLowBodyLengths * length;
      plan.bandHi = ground + BEHAVIOUR.forageBandHighBodyLengths * length;
      plan.align *= GREETING.schoolFactor;
      plan.cohesion *= GREETING.schoolFactor;
      this.holdStation(i, plan, x, y, z, GREETING.arrivedBodyLengths * length, FishState.Station);
      return true;
    }
    const z = basin.maxZ;
    this.bandAt(i, x, z);
    const y = clamp(at(g.point, 1) + at(g.offset, i * 2 + 1) * length, this.bandLo, this.bandHi);
    if (!this.withinCuriosityLeash(i, x, y, z)) return false;
    const o = i * 3;
    const d = Math.hypot(x - at(position, o), y - at(position, o + 1), z - at(position, o + 2));
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    plan.align *= GREETING.schoolFactor;
    plan.cohesion *= GREETING.schoolFactor;
    plan.wander *= 0.3;
    this.widenBand(plan, y, length);
    plan.arrival = (FEEDING.mouthBodyLengths + GREETING.standoffBodyLengths) * length;
    const speed = Math.min(
      FEEDING.pursuitSpeedFraction * vmax,
      Math.max(cruise * GREETING.approachSpeedFactor, (d - plan.arrival) / GREETING.catchUpS),
    );
    plan.seek(x, y, z, speed, 0.5);
    plan.speedFloor = 0;
    plan.speedCap = speed * clamp((d - plan.arrival) / (2 * length), 0, 1);
    if (d < plan.arrival + GREETING.arrivedBodyLengths * length) plan.state = FishState.Station;
    return true;
  }

  private withinCuriosityLeash(i: number, x: number, y: number, z: number): boolean {
    const { leash } = this.curiosity;
    const o = i * 4;
    const r = at(leash, o + 3);
    if (r === Infinity) return true;
    return Math.hypot(x - at(leash, o), y - at(leash, o + 1), z - at(leash, o + 2)) <= r;
  }

  /**
   * As its next meal comes due, a fish that has learnt where food comes in waits there, at the
   * top of its band, or on the sand below for a bottom forager (time-place learning).
   */
  private planSpot(i: number, sp: SimSpecies, plan: Plan): boolean {
    const c = this.curiosity;
    const w = at(c.anticipation, i);
    if (w < CURIOSITY.anticipationMinWeight) return false;
    const { basin, position } = this.host;
    const length = at(this.host.bodyLength, i);
    const x = at(c.spot, i * 2);
    const z = at(c.spot, i * 2 + 1);
    let y: number;
    if (sp.gait === 'forage') {
      const ground = basin.ground(at(position, i * 3), at(position, i * 3 + 2));
      const mid = 0.5 * (BEHAVIOUR.forageBandLowBodyLengths + BEHAVIOUR.forageBandHighBodyLengths);
      plan.floor = false;
      plan.bandLo = ground + BEHAVIOUR.forageBandLowBodyLengths * length;
      plan.bandHi = ground + BEHAVIOUR.forageBandHighBodyLengths * length;
      y = basin.ground(x, z) + mid * length;
    } else {
      this.bandAt(i, x, z);
      y = Math.max(this.bandLo, Math.min(this.bandHi, basin.maxY - length));
    }
    this.holdStation(
      i,
      plan,
      x,
      y,
      z,
      CURIOSITY.anticipationRadiusBodyLengths * length,
      FishState.Station,
    );
    plan.seekWeight *= Math.min(1, w);
    return true;
  }

  private planYield(i: number, plan: Plan): void {
    this.yieldTimer[i] = at(this.yieldTimer, i) - DT;
    const yaw = at(this.yieldYaw, i);
    const speed = Math.min(
      at(this.host.maxSpeed, i),
      BEHAVIOUR.yieldCruiseFactor * at(this.host.cruiseSpeed, i),
    );
    plan.continuous = true;
    plan.speedCap = speed;
    plan.align = 0;
    plan.cohesion = 0;
    plan.wander *= 0.3;
    plan.seek(
      at(this.host.position, i * 3) + Math.sin(yaw),
      at(this.host.position, i * 3 + 1),
      at(this.host.position, i * 3 + 2) + Math.cos(yaw),
      speed,
      0.3,
    );
  }

  private planStartle(i: number, sp: SimSpecies, plan: Plan): void {
    const vmax = at(this.host.maxSpeed, i);
    const phase = at(this.startlePhase, i);
    const left = at(this.startleTimer, i) - DT;
    this.startleElapsed[i] = at(this.startleElapsed, i) + DT;
    const yaw = at(this.escapeYaw, i);
    const pitch = at(this.escapePitch, i);
    plan.state = FishState.Startle;
    plan.continuous = true;
    plan.wander = 0;
    plan.align = 0;
    plan.cohesion = 0;
    const px = at(this.host.position, i * 3);
    const py = at(this.host.position, i * 3 + 1);
    const pz = at(this.host.position, i * 3 + 2);
    const cp = Math.cos(pitch);
    const ex = px + Math.sin(yaw) * cp;
    const ey = py + Math.sin(pitch);
    const ez = pz + Math.cos(yaw) * cp;
    if (phase === StartlePhase.Bend) {
      plan.yaw = yaw;
      plan.pitch = pitch;
      plan.turnRate = BEHAVIOUR.cBendTurnRateRadPerS;
      plan.seek(ex, ey, ez, vmax, 0.1);
      plan.speedFloor = vmax;
      const done = Math.abs(wrapAngle(at(this.host.yaw, i) - yaw)) < BEHAVIOUR.cBendDoneRad;
      if (done || left <= 0) {
        this.startlePhase[i] = StartlePhase.Burst;
        this.startleTimer[i] = BEHAVIOUR.escapeBurstS;
      } else {
        this.startleTimer[i] = left;
      }
      return;
    }
    if (phase === StartlePhase.Burst) {
      plan.seek(ex, ey, ez, vmax, 0.1);
      plan.speedFloor = 0.8 * vmax;
      if (left <= 0) {
        this.startlePhase[i] = StartlePhase.Flee;
        this.startleTimer[i] = BEHAVIOUR.fleeS;
      } else {
        this.startleTimer[i] = left;
      }
      return;
    }
    const speed = BEHAVIOUR.fleeSpeedFraction * vmax;
    const a = this.anchors[at(this.anchor, i)];
    if (this.brood.hides(i)) {
      const { cover } = this.brood;
      plan.seek(at(cover, i * 3), at(cover, i * 3 + 1), at(cover, i * 3 + 2), speed, 0.3);
      plan.comfort = BEHAVIOUR.shelterComfort;
    } else if (a !== undefined) {
      const [tx, ty, tz] = this.approach(i, a);
      plan.seek(tx, ty, tz, speed, 0.3);
      plan.homing = a.kind === 'cave';
      plan.comfort = BEHAVIOUR.shelterComfort;
      this.widenBand(plan, a.position[1], a.radius);
    } else if (sp.home === 'station') {
      const o = i * 3;
      plan.seek(at(this.home, o), at(this.home, o + 1), at(this.home, o + 2), speed, 0.3);
    } else {
      plan.seek(ex, ey, ez, speed, 0.3);
    }
    if (left <= 0) this.startlePhase[i] = StartlePhase.None;
    else this.startleTimer[i] = left;
  }

  /**
   * A walker's plan: the tail-flip and the freeze after it or the time withdrawn into its shell,
   * picking food it has found, sheltering in its cave, and otherwise alternating bouts of walking
   * and of picking at the surface.
   * `Walkers` turns it into steps along the surface.
   */
  private planWalker(i: number, w: SimWalking, plan: Plan, rest: number): void {
    const { position, rng } = this.host;
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    const length = at(this.host.bodyLength, i);
    plan.state = FishState.Walk;
    plan.align = 0;
    plan.cohesion = 0;
    const phase = at(this.startlePhase, i);
    if (phase !== StartlePhase.None) {
      const left = at(this.startleTimer, i) - DT;
      this.startleElapsed[i] = at(this.startleElapsed, i) + DT;
      plan.speedCap = 0;
      plan.wander = 0;
      if (phase === StartlePhase.Burst) {
        const yaw = at(this.escapeYaw, i);
        plan.state = FishState.TailFlip;
        plan.seek(px + Math.sin(yaw), py, pz + Math.cos(yaw), 0, 1);
        if (left <= 0) {
          this.startlePhase[i] = StartlePhase.Flee;
          this.startleTimer[i] = rng.range(BEHAVIOUR.walkerFreezeMinS, BEHAVIOUR.walkerFreezeMaxS);
        } else {
          this.startleTimer[i] = left;
        }
        return;
      }
      plan.state = FishState.Shelter;
      if (left <= 0) this.startlePhase[i] = StartlePhase.None;
      else this.startleTimer[i] = left;
      return;
    }

    const f = this.feeding;
    const k = at(f.target, i);
    if (at(f.handling, i) > 0) {
      plan.state = FishState.Pick;
      plan.speedCap = 0;
      plan.wander = 0;
      return;
    }
    if (k >= 0) {
      const { food } = this.host;
      plan.wander *= 0.3;
      plan.seek(
        at(food.position, k * 3),
        at(food.position, k * 3 + 1),
        at(food.position, k * 3 + 2),
        0,
        0.5,
      );
      return;
    }

    const sheltering = rest > 0.5 || at(this._shelterTimer, i) > 0;
    if (!sheltering) {
      this.restSpotSet[i] = 0;
    } else if (this.speciesOf(i).home === 'cave') {
      // A cave that emptied since the walker was turned away (a shrimp removed) is claimed anew.
      if (at(this.anchor, i) < 0 && this.restSpotSet[i] === 0) this.anchor[i] = this.walkerCave(i);
      const a = this.anchors[at(this.anchor, i)];
      if (a?.kind === 'cave') {
        if (this.planCave(i, a, plan, px, py, pz, length)) return;
      } else if (this.planNook(i, plan, px, pz, length)) {
        return;
      }
    }

    const left = at(this.forageTimer, i) - DT;
    if (left <= 0) {
      const pick = this.sifting[i] === 1 ? 0 : 1;
      this.sifting[i] = pick;
      const g = w.biofilmGrazer;
      this.forageTimer[i] =
        pick === 1
          ? g
            ? rng.range(BEHAVIOUR.grazerPickMinS, BEHAVIOUR.grazerPickMaxS)
            : rng.range(BEHAVIOUR.walkerPickMinS, BEHAVIOUR.walkerPickMaxS)
          : g
            ? rng.range(BEHAVIOUR.grazerWalkMinS, BEHAVIOUR.grazerWalkMaxS)
            : rng.range(BEHAVIOUR.walkerWalkMinS, BEHAVIOUR.walkerWalkMaxS);
    } else {
      this.forageTimer[i] = left;
    }
    if (this.sifting[i] === 1) {
      plan.state = FishState.Pick;
      plan.speedCap = 0;
    }
    if (rest > 0.5) plan.state = FishState.Rest;
  }

  /**
   * Walker `i` heads for cave `a` and shelters in its mouth. False once it has gone
   * `walkerCaveGiveUpS` without getting closer (the way is blocked) and finds no nook beside
   * it either: it lets the cave go and rests where it is.
   */
  private planCave(
    i: number,
    a: Anchor,
    plan: Plan,
    px: number,
    py: number,
    pz: number,
    length: number,
  ): boolean {
    // A walker comes in along the floor at its own height, so the mouth is judged in plan view.
    const [ax, , az] = a.position;
    const d = Math.hypot(px - ax, pz - az);
    if (this.restSpotSet[i] === 0) {
      this.restSpotSet[i] = 3;
      this.seekClosest[i] = Infinity;
    }
    if (this.restSpotSet[i] !== 3) return false;
    if (d <= a.radius + 0.5 * length) {
      this.seekClosest[i] = d;
      this.seekTimer[i] = BEHAVIOUR.walkerCaveGiveUpS;
      plan.state = FishState.Shelter;
      plan.speedCap = 0;
      plan.wander = 0;
      return true;
    }
    if (this.stalled(i, d, length, BEHAVIOUR.walkerCaveGiveUpS)) {
      this.restSpotSet[i] = 0;
      this.anchor[i] = -1;
      return this.planNook(i, plan, px, pz, length);
    }
    const [tx, ty, tz] = this.approach(i, a, py);
    plan.seek(tx, ty, tz, 0, 0.5);
    plan.homing = true;
    plan.wander *= 0.3;
    return true;
  }

  /**
   * A cave-dweller turned away from full caves shelters against the rock beside the nearest one,
   * as shrimp crowd into crevices round an occupied refuge. False when there is no such nook, or
   * it could not be reached in time: the walker then rests where it is.
   */
  private planNook(i: number, plan: Plan, px: number, pz: number, length: number): boolean {
    const o = i * 3;
    if (this.restSpotSet[i] === 1 && !this.nookHolds(i, length)) this.restSpotSet[i] = 0;
    if (this.restSpotSet[i] === 0) {
      this.restSpotSet[i] = this.pickNook(i, length) ? 1 : 2;
      this.seekClosest[i] = Infinity;
    }
    if (this.restSpotSet[i] !== 1) return false;
    const nx = at(this.restSpot, o);
    const nz = at(this.restSpot, o + 2);
    const d = Math.hypot(px - nx, pz - nz);
    if (d <= BEHAVIOUR.walkerNookArriveBodyLengths * length) {
      this.seekClosest[i] = d;
      this.seekTimer[i] = BEHAVIOUR.walkerNookGiveUpS;
      plan.state = FishState.Shelter;
      plan.speedCap = 0;
      plan.wander = 0;
      return true;
    }
    if (this.stalled(i, d, length, BEHAVIOUR.walkerNookGiveUpS)) {
      this.restSpotSet[i] = 2;
      return false;
    }
    plan.seek(nx, at(this.restSpot, o + 1), nz, 0, 0.5);
    plan.wander *= 0.3;
    return true;
  }

  /**
   * Counts down walker `i`'s give-up time, restarting it whenever the walker has got a little
   * closer to where it is heading; true once it runs out.
   */
  private stalled(i: number, d: number, length: number, giveUpS: number): boolean {
    if (d < at(this.seekClosest, i) - BEHAVIOUR.walkerSeekProgressBodyLengths * length) {
      this.seekClosest[i] = d;
      this.seekTimer[i] = giveUpS;
    }
    const left = at(this.seekTimer, i) - DT;
    this.seekTimer[i] = left;
    return left <= 0;
  }

  /** Whether walker `i`'s nook is still clear of rock and still beside it after decor moved. */
  private nookHolds(i: number, length: number): boolean {
    const { sceneSdf, decorSdf } = this.host;
    if (decorSdf === null) return false;
    const o = i * 3;
    const x = at(this.restSpot, o);
    const y = at(this.restSpot, o + 1);
    const z = at(this.restSpot, o + 2);
    const thickness = BEHAVIOUR.bodyThicknessBodyLengths * length;
    return (
      sceneSdf.sample(x, y, z, this.n3) >= 1.2 * thickness &&
      decorSdf.sample(x, y, z, this.n3) <= BEHAVIOUR.walkerNookDecorBodyLengths * length
    );
  }

  /**
   * Projects points on a ring round the nearest cave onto its rock and keeps the foot of the
   * flank nearest walker `i`, half a body length out from it, in `restSpot`. Draws nothing from
   * the RNG.
   */
  private pickNook(i: number, length: number): boolean {
    const { decorSdf, sceneSdf, basin, position } = this.host;
    if (decorSdf === null) return false;
    const o = i * 3;
    const px = at(position, o);
    const pz = at(position, o + 2);
    let cave: Anchor | undefined;
    let caveDist = Infinity;
    for (const a of this.anchors) {
      if (a.kind !== 'cave') continue;
      const d = Math.hypot(a.position[0] - px, a.position[2] - pz);
      if (d < caveDist) {
        cave = a;
        caveDist = d;
      }
    }
    if (cave === undefined) return false;
    const n3 = this.n3;
    const thickness = BEHAVIOUR.bodyThicknessBodyLengths * length;
    const ring = cave.radius + BEHAVIOUR.walkerNookRingBodyLengths * length;
    const out = BEHAVIOUR.walkerNookOutBodyLengths * length;
    const lift = 0.5 * length;
    let best = Infinity;
    for (let c = 0; c < BEHAVIOUR.walkerNookCandidates; c++) {
      const t = (2 * Math.PI * c) / BEHAVIOUR.walkerNookCandidates;
      let x = cave.position[0] + Math.sin(t) * ring;
      let z = cave.position[2] + Math.cos(t) * ring;
      let y = basin.ground(x, z) + lift;
      let d = Infinity;
      for (let k = 0; k < 8; k++) {
        d = decorSdf.sample(x, y, z, n3);
        x -= at(n3, 0) * d;
        y -= at(n3, 1) * d;
        z -= at(n3, 2) * d;
        if (Math.abs(d) < 1e-4) break;
      }
      if (Math.abs(d) > 1e-3) continue;
      decorSdf.sample(x, y, z, n3);
      const flank = Math.hypot(at(n3, 0), at(n3, 2));
      // The top of a rock is no hiding place.
      if (flank < 0.3) continue;
      const sx = x + (at(n3, 0) / flank) * out;
      const sz = z + (at(n3, 2) / flank) * out;
      const margin = length;
      if (sx < basin.minX + margin || sx > basin.maxX - margin) continue;
      if (sz < basin.minZ + margin || sz > basin.maxZ - margin) continue;
      const sy = basin.ground(sx, sz) + lift;
      if (sceneSdf.sample(sx, sy, sz, n3) < 1.2 * thickness) continue;
      if (decorSdf.sample(sx, sy, sz, n3) > BEHAVIOUR.walkerNookDecorBodyLengths * length) continue;
      if (this.nookTaken(i, sx, sz, length)) continue;
      const dist = Math.hypot(sx - px, sz - pz);
      if (dist < best) {
        best = dist;
        this.restSpot[o] = sx;
        this.restSpot[o + 1] = sy;
        this.restSpot[o + 2] = sz;
      }
    }
    return best < Infinity;
  }

  /** Whether another walker already holds a nook within spacing of (x, z), in plan view. */
  private nookTaken(i: number, x: number, z: number, length: number): boolean {
    const spacing = BEHAVIOUR.walkerNookSpacingBodyLengths * length;
    for (let j = 0; j < this.host.count; j++) {
      if (j === i || this.restSpotSet[j] !== 1 || this.speciesOf(j).walking === null) continue;
      const o = j * 3;
      if (Math.hypot(at(this.restSpot, o) - x, at(this.restSpot, o + 2) - z) < spacing) return true;
    }
    return false;
  }

  private territoryCentre(i: number, sp: SimSpecies): [number, number, number, number] {
    const length = at(this.host.bodyLength, i);
    const a = this.anchors[at(this.anchor, i)];
    if (a !== undefined) {
      const r = a.radius + BEHAVIOUR.anchorTerritoryBodyLengths * length;
      return [a.position[0], a.position[1], a.position[2], r];
    }
    const r = BEHAVIOUR.territoryBodyLengths * length;
    const clutch = this.brood.clutchPoint(i);
    if (clutch !== null) return [clutch[0], clutch[1], clutch[2], r];
    const src = sp.home === 'none' ? this.host.position : this.home;
    return [at(src, i * 3), at(src, i * 3 + 1), at(src, i * 3 + 2), r];
  }

  private updateTerritory(i: number, sp: SimSpecies): void {
    this.territoryCooldown[i] = at(this.territoryCooldown, i) - DT;
    if (at(this.territoryPhase, i) !== TerritoryPhase.Idle) return;
    const check = at(this.territoryCheck, i) - DT;
    if (check > 0) {
      this.territoryCheck[i] = check;
      return;
    }
    this.territoryCheck[i] = BEHAVIOUR.territoryCheckS;
    if (at(this.territoryCooldown, i) > 0 || at(this.rest, i) > 0.5) return;
    const { position, bodyLength, speciesIndex, count } = this.host;
    const [cx, cy, cz, r] = this.territoryCentre(i, sp);
    const own = at(speciesIndex, i);
    const home = at(this.anchor, i);
    const minLength = BEHAVIOUR.intruderSizeRatio * at(bodyLength, i);
    const maxLength = BEHAVIOUR.intruderMaxSizeRatio * at(bodyLength, i);
    let best = -1;
    let bestD = r;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      if (at(speciesIndex, j) === own) {
        // A mate sharing the anemone or cave is a partner, not a rival.
        if (home >= 0 && at(this.anchor, j) === home) continue;
      } else {
        const lj = at(bodyLength, j);
        if (lj < minLength || lj > maxLength) continue;
      }
      if (at(this.yieldTimer, j) > 0 || at(this.startlePhase, j) !== StartlePhase.None) continue;
      const d = Math.hypot(
        at(position, j * 3) - cx,
        at(position, j * 3 + 1) - cy,
        at(position, j * 3 + 2) - cz,
      );
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) return;
    this.territoryTarget[i] = best;
    this.territoryPhase[i] = TerritoryPhase.Approach;
    this.territoryTimer[i] = BEHAVIOUR.approachS;
  }

  private endTerritory(i: number): void {
    this.territoryPhase[i] = TerritoryPhase.Idle;
    this.territoryTarget[i] = -1;
    this.territoryCooldown[i] = this.host.rng.range(BEHAVIOUR.cooldownMinS, BEHAVIOUR.cooldownMaxS);
  }

  private planTerritory(i: number, sp: SimSpecies, plan: Plan): void {
    const { position, bodyLength, rng } = this.host;
    const j = at(this.territoryTarget, i);
    const [cx, cy, cz, r] = this.territoryCentre(i, sp);
    const jx = at(position, j * 3);
    const jy = at(position, j * 3 + 1);
    const jz = at(position, j * 3 + 2);
    const px = at(position, i * 3);
    const py = at(position, i * 3 + 1);
    const pz = at(position, i * 3 + 2);
    const left = at(this.territoryTimer, i) - DT;
    this.territoryTimer[i] = left;
    if (Math.hypot(jx - cx, jy - cy, jz - cz) > 1.5 * r) {
      this.endTerritory(i);
      return;
    }
    const li = at(bodyLength, i);
    const lj = at(bodyLength, j);
    const d = Math.hypot(jx - px, jy - py, jz - pz);
    const cruise = at(this.host.cruiseSpeed, i);
    const vmax = at(this.host.maxSpeed, i);
    plan.wander = 0.2;
    plan.align = 0;
    plan.cohesion = 0;
    this.widenBand(plan, jy, li);
    const phase = at(this.territoryPhase, i);
    if (phase === TerritoryPhase.Approach) {
      plan.seek(jx, jy, jz, Math.min(vmax, 2 * cruise), 0.5);
      if (d < 1.5 * (li + lj)) {
        if (sp.flare) {
          this.territoryPhase[i] = TerritoryPhase.Flare;
          this.territoryTimer[i] = rng.range(sp.flareMinS, sp.flareMaxS);
        } else {
          this.territoryPhase[i] = TerritoryPhase.Charge;
          this.territoryTimer[i] = BEHAVIOUR.chargeS;
        }
      } else if (left <= 0) {
        this.endTerritory(i);
      }
      return;
    }
    if (phase === TerritoryPhase.Flare) {
      plan.state = FishState.Display;
      plan.display = 1;
      plan.gillFlare = 1;
      plan.speedCap = BEHAVIOUR.siftSpeedFactor * cruise;
      plan.yaw = Math.atan2(jx - px, jz - pz);
      if (left <= 0) {
        this.territoryPhase[i] = TerritoryPhase.Charge;
        this.territoryTimer[i] = BEHAVIOUR.chargeS;
      }
      return;
    }
    plan.state = FishState.Display;
    plan.display = 1;
    plan.continuous = true;
    plan.seek(jx, jy, jz, BEHAVIOUR.chargeSpeedFraction * vmax, 0.2);
    if (d < 0.6 * (li + lj)) {
      // A chased rival swims off; it is not a predator strike, so no C-start and no relay.
      if (rng.next() < BEHAVIOUR.chargeYieldProbability) {
        this.yieldTimer[j] = BEHAVIOUR.yieldS;
        this.yieldYaw[j] = wrapAngle(Math.atan2(jx - px, jz - pz) + 0.3 * rng.gaussian());
        if (at(this.territoryPhase, j) !== TerritoryPhase.Idle) this.endTerritory(j);
      }
      this.endTerritory(i);
    } else if (left <= 0) {
      this.endTerritory(i);
    }
  }

  private widenBand(plan: Plan, y: number, r: number): void {
    plan.bandLo = Math.min(plan.bandLo, y - r);
    plan.bandHi = Math.max(plan.bandHi, y + r);
  }

  /**
   * Keeps close by a hiding spot. Unlike `holdStation` the pull never lets go and fades only as the
   * fish arrives, so a hider hangs by its plant rather than drifting off and being reeled back.
   */
  private planHide(i: number, plan: Plan): void {
    const { cover } = this.brood;
    const o = i * 3;
    const hx = at(cover, o);
    const hy = at(cover, o + 1);
    const hz = at(cover, o + 2);
    const length = at(this.host.bodyLength, i);
    const radius = BROOD.coverRadiusBodyLengths * length;
    const cruise = at(this.host.cruiseSpeed, i) * plan.cruiseScale;
    const d = Math.hypot(
      hx - at(this.host.position, o),
      hy - at(this.host.position, o + 1),
      hz - at(this.host.position, o + 2),
    );
    this.widenBand(plan, hy, radius);
    plan.wander *= BROOD.hideWander;
    plan.speedFloor = 0;
    plan.seek(
      hx,
      hy,
      hz,
      Math.min(cruise, d / BROOD.hideApproachS),
      0.5,
      clamp(d / radius, 0.2, 1),
    );
    if (d <= radius) {
      plan.cruiseScale *= BEHAVIOUR.stationCruiseFactor;
      plan.state = FishState.Shelter;
    }
  }

  /** Hover inside `radius` of a home point; outside it, swim back with a soft leash. */
  private holdStation(
    i: number,
    plan: Plan,
    hx: number,
    hy: number,
    hz: number,
    radius: number,
    state: FishState,
  ): void {
    const px = at(this.host.position, i * 3);
    const py = at(this.host.position, i * 3 + 1);
    const pz = at(this.host.position, i * 3 + 2);
    const d = Math.hypot(hx - px, hy - py, hz - pz);
    const cruise = at(this.host.cruiseSpeed, i) * plan.cruiseScale;
    this.widenBand(plan, hy, radius);
    plan.wander *= 0.5;
    if (d > radius) {
      plan.seek(
        hx,
        hy,
        hz,
        Math.max(cruise, 0.5 * at(this.host.cruiseSpeed, i)),
        1.5,
        clamp((d - radius) / radius, 0.3, 1),
      );
    } else {
      plan.cruiseScale *= BEHAVIOUR.stationCruiseFactor;
      plan.state = state;
    }
  }

  private planStation(i: number, sp: SimSpecies, plan: Plan): void {
    const length = at(this.host.bodyLength, i);
    const si = at(this.host.speciesIndex, i);
    if (sp.schooling && at(this.groupLeader, si) >= 0) {
      const size = at(this.groupSize, si);
      const radius = sp.stationRadiusBodyLengths * length + 0.5 * length * Math.sqrt(size);
      const o = si * 3;
      this.holdStation(
        i,
        plan,
        at(this.groupHome, o),
        at(this.groupHome, o + 1),
        at(this.groupHome, o + 2),
        radius,
        FishState.Station,
      );
      return;
    }
    const left = at(this.homeTimer, i) - DT;
    this.homeTimer[i] = left;
    if (left <= 0) this.pickHome(i);
    const o = i * 3;
    this.holdStation(
      i,
      plan,
      at(this.home, o),
      at(this.home, o + 1),
      at(this.home, o + 2),
      sp.stationRadiusBodyLengths * length,
      FishState.Station,
    );
  }

  private planAnchored(i: number, sp: SimSpecies, plan: Plan): void {
    const a = this.anchors[at(this.anchor, i)];
    if (a === undefined) throw new RangeError(`fish ${i} has no anchor`);
    const length = at(this.host.bodyLength, i);
    const [ax, ay, az] = a.position;
    const rest = at(this.rest, i);
    if (a.kind === 'anemone') {
      if (rest > 0.5) {
        this.excursion[i] = 0;
        this.holdStation(i, plan, ax, ay, az, a.radius, FishState.Rest);
        return;
      }
      if (this.excursion[i] === 1) {
        const left = at(this.excursionTimer, i) - DT;
        this.excursionTimer[i] = left;
        const o = i * 3;
        this.holdStation(
          i,
          plan,
          at(this.excursionTarget, o),
          at(this.excursionTarget, o + 1),
          at(this.excursionTarget, o + 2),
          length,
          FishState.Cruise,
        );
        if (left <= 0) {
          this.excursion[i] = 0;
          this.excursionTimer[i] = this.host.rng.range(0, 2 * sp.excursionMeanIntervalS);
        }
        return;
      }
      const left = at(this.excursionTimer, i) - DT;
      this.excursionTimer[i] = left;
      if (left <= 0) this.startExcursion(i, a, length);
      this.holdStation(
        i,
        plan,
        ax,
        ay,
        az,
        a.radius + sp.hostLeashBodyLengths * length,
        FishState.Host,
      );
      return;
    }
    let mx = ax;
    let my = ay;
    let mz = az;
    const f = a.facing;
    if (f !== undefined) {
      const fl = Math.hypot(f[0], f[1], f[2]);
      if (fl > 1e-9) {
        const s = (a.radius + BEHAVIOUR.caveMouthBodyLengths * length) / fl;
        mx += f[0] * s;
        my += f[1] * s;
        mz += f[2] * s;
      }
    }
    this.holdStation(
      i,
      plan,
      mx,
      my,
      mz,
      BEHAVIOUR.caveLeashBodyLengths * length,
      FishState.Station,
    );
    plan.homing = a.kind === 'cave';
    this.bellyToSurface(i, sp, plan);
  }

  /**
   * A cave-dweller hides in its cave at rest, after a startle and in more flow than it can
   * sustain, whatever its gait.
   */
  private planShelter(i: number, sp: SimSpecies, plan: Plan): boolean {
    const a = this.anchors[at(this.anchor, i)];
    if (a?.kind !== 'cave') return false;
    const calm = at(this.host.flowShelter, i) === 0;
    if (at(this.rest, i) <= 0.5 && at(this._shelterTimer, i) <= 0 && calm) return false;
    plan.comfort = BEHAVIOUR.shelterComfort;
    const length = at(this.host.bodyLength, i);
    let entryY = a.position[1];
    if (sp.gait === 'forage' || sp.grazer === 'glass') {
      // Substrate fish shelter on the cave floor, as plecos and corydoras lie under cover. They
      // stay down there on the way in too: rising to the mouth's mid-height off the sand pins
      // them against the floor and the cave wall.
      const { basin, position } = this.host;
      const mid = 0.5 * (BEHAVIOUR.forageBandLowBodyLengths + BEHAVIOUR.forageBandHighBodyLengths);
      const ground = basin.ground(at(position, i * 3), at(position, i * 3 + 2));
      plan.floor = false;
      plan.bandLo = ground + BEHAVIOUR.forageBandLowBodyLengths * length;
      plan.bandHi = ground + BEHAVIOUR.forageBandHighBodyLengths * length;
      entryY = basin.ground(a.position[0], a.position[2]) + mid * length;
    }
    const [tx, ty, tz] = this.approach(i, a, entryY);
    this.holdStation(
      i,
      plan,
      tx,
      ty,
      tz,
      Math.max(0.6 * a.radius, 0.5 * length),
      FishState.Shelter,
    );
    plan.homing = a.kind === 'cave';
    if (plan.state === FishState.Shelter) this.bellyToSurface(i, sp, plan);
    return true;
  }

  /**
   * Where to swim to reach an anchor: straight to it, except that a cave is entered through its
   * mouth, so a fish beside or behind the rock first goes round to the front.
   */
  private approach(i: number, a: Anchor, ay = a.position[1]): Point3 {
    const [ax, , az] = a.position;
    const f = a.facing;
    const fl = f === undefined ? 0 : Math.hypot(f[0], f[1], f[2]);
    if (a.kind !== 'cave' || f === undefined || fl < 1e-9) return [ax, ay, az];
    const ux = f[0] / fl;
    const uy = f[1] / fl;
    const uz = f[2] / fl;
    const rx = at(this.host.position, i * 3) - ax;
    const ry = at(this.host.position, i * 3 + 1) - ay;
    const rz = at(this.host.position, i * 3 + 2) - az;
    const along = rx * ux + ry * uy + rz * uz;
    const lateral = Math.hypot(rx - along * ux, ry - along * uy, rz - along * uz);
    if (Math.hypot(rx, ry, rz) <= a.radius || (along > 0 && lateral < a.radius))
      return [ax, ay, az];
    const out = a.radius + BEHAVIOUR.caveMouthBodyLengths * at(this.host.bodyLength, i);
    if (along < 0.5 * out && lateral >= a.radius) {
      // Beside the rock, the straight line to the mouth cuts through the cave's own wall: the
      // fish comes out past the face on its own side first, then crosses to the mouth.
      return [ax + ux * out + rx - along * ux, ay + uy * out, az + uz * out + rz - along * uz];
    }
    return [ax + ux * out, ay + uy * out, az + uz * out];
  }

  private startExcursion(i: number, a: Anchor, length: number): void {
    const { rng, sceneSdf, basin } = this.host;
    const reach = a.radius + BEHAVIOUR.excursionBodyLengths * length;
    const heading = rng.range(-Math.PI, Math.PI);
    const margin = at(this.host.radius, i) + length;
    const x = clamp(
      a.position[0] + Math.sin(heading) * reach,
      basin.minX + margin,
      basin.maxX - margin,
    );
    const rise = rng.range(0, length);
    const z = clamp(
      a.position[2] + Math.cos(heading) * reach,
      basin.minZ + margin,
      basin.maxZ - margin,
    );
    const y = clamp(a.position[1] + rise, basin.ground(x, z) + margin, basin.maxY - margin);
    if (sceneSdf.sample(x, y, z, this.n3) < margin) {
      this.excursionTimer[i] = rng.range(0, this.speciesOf(i).excursionMeanIntervalS);
      return;
    }
    const o = i * 3;
    this.excursionTarget[o] = x;
    this.excursionTarget[o + 1] = y;
    this.excursionTarget[o + 2] = z;
    this.excursion[i] = 1;
    this.excursionTimer[i] = rng.range(BEHAVIOUR.excursionMinS, BEHAVIOUR.excursionMaxS);
  }

  /** Rolls the belly towards a nearby surface, as royal gramma do under ledges. */
  private bellyToSurface(i: number, sp: SimSpecies, plan: Plan): void {
    if (!sp.bellyToSurface) return;
    const n3 = this.n3;
    const length = at(this.host.bodyLength, i);
    const d = this.host.substrateSdf.sample(
      at(this.host.position, i * 3),
      at(this.host.position, i * 3 + 1),
      at(this.host.position, i * 3 + 2),
      n3,
    );
    const reach = BEHAVIOUR.bellyReachBodyLengths * length;
    if (d >= reach) return;
    const w = clamp((reach - d) / (0.5 * reach), 0, 1);
    plan.roll = w * this.bellyRoll(i, n3);
  }

  private bellyRoll(i: number, normal: Float64Array): number {
    const yaw = at(this.host.yaw, i);
    const nx = at(normal, 0);
    const ny = at(normal, 1);
    const nz = at(normal, 2);
    // Down after roll r is -up·cos r + left·sin r; solve for down = -n.
    const nDotLeft = nx * Math.cos(yaw) - nz * Math.sin(yaw);
    return Math.atan2(-nDotLeft, ny);
  }

  /**
   * A bottom forager that also rasps glass (a bristlenose pleco) sifts for food while it is hungry
   * and any lies settled, and grazes glass otherwise; resting, it sifts slowly as other foragers
   * do.
   */
  private grazesInsteadOfForaging(i: number, sp: SimSpecies, rest: number): boolean {
    if (sp.grazer !== 'glass' || rest > 0.5) return false;
    return !(this.feeding.anySettled && this.feeding.hungry(i));
  }

  private planForage(i: number, sp: SimSpecies, plan: Plan): void {
    const { rng } = this.host;
    const length = at(this.host.bodyLength, i);
    plan.floor = false;
    const rest = at(this.rest, i);
    const ground = this.host.basin.ground(
      at(this.host.position, i * 3),
      at(this.host.position, i * 3 + 2),
    );
    plan.bandLo = ground + BEHAVIOUR.forageBandLowBodyLengths * length;
    plan.bandHi = ground + BEHAVIOUR.forageBandHighBodyLengths * length;
    plan.state = FishState.Forage;
    if (sp.airGulp) {
      const p = 1 - Math.exp(-(sp.gulpsPerHour / 3600) * DT);
      if (rng.next() < p) {
        this.gulpPhase[i] = GulpPhase.Ascend;
        this.gulpTimer[i] = BEHAVIOUR.gulpTimeoutS;
        this.planGulp(i, plan);
        return;
      }
    }
    if (rest > 0.5) {
      plan.cruiseScale *= BEHAVIOUR.siftSpeedFactor;
      return;
    }
    const left = at(this.forageTimer, i) - DT;
    if (left <= 0) {
      const sift = this.sifting[i] === 1 ? 0 : 1;
      this.sifting[i] = sift;
      this.forageTimer[i] =
        sift === 1
          ? rng.range(BEHAVIOUR.siftMinS, BEHAVIOUR.siftMaxS)
          : rng.range(BEHAVIOUR.moveMinS, BEHAVIOUR.moveMaxS);
    } else {
      this.forageTimer[i] = left;
    }
    if (this.sifting[i] === 1) {
      plan.speedCap = BEHAVIOUR.siftSpeedFactor * at(this.host.cruiseSpeed, i);
      plan.pitch = Math.max(BEHAVIOUR.siftPitchRad, -sp.maxPitch);
      plan.wander *= 0.3;
    }
  }

  /** Corydoras rise to the surface for a gulp of air and dart back down (Kramer & McClure 1980). */
  private planGulp(i: number, plan: Plan): void {
    const length = at(this.host.bodyLength, i);
    const { basin } = this.host;
    const h = basin.maxY;
    const px = at(this.host.position, i * 3);
    const py = at(this.host.position, i * 3 + 1);
    const pz = at(this.host.position, i * 3 + 2);
    const ground = basin.ground(px, pz);
    const speed = BEHAVIOUR.gulpAscentSpeedFraction * at(this.host.maxSpeed, i);
    plan.state = FishState.Gulp;
    plan.floor = false;
    plan.surface = false;
    plan.continuous = true;
    plan.wander = 0;
    plan.align = 0;
    plan.cohesion = 0;
    plan.bandLo = ground;
    plan.bandHi = h;
    const left = at(this.gulpTimer, i) - DT;
    this.gulpTimer[i] = left;
    const top = h - BEHAVIOUR.gulpTopBodyLengths * length;
    const phase = at(this.gulpPhase, i);
    if (phase === GulpPhase.Ascend) {
      plan.seek(px, top, pz, speed, 0.3);
      if (py >= h - BEHAVIOUR.gulpArriveBodyLengths * length) {
        this.gulpPhase[i] = GulpPhase.Hold;
        this.gulpTimer[i] = BEHAVIOUR.gulpHoldS;
      } else if (left <= 0) {
        this.gulpPhase[i] = GulpPhase.Descend;
        this.gulpTimer[i] = BEHAVIOUR.gulpTimeoutS;
      }
    } else if (phase === GulpPhase.Hold) {
      plan.seek(px, top, pz, 0.2 * speed, 0.3);
      if (left <= 0) {
        this.gulpPhase[i] = GulpPhase.Descend;
        this.gulpTimer[i] = BEHAVIOUR.gulpTimeoutS;
      }
    } else {
      const above = BEHAVIOUR.forageBandHighBodyLengths * length;
      plan.seek(px, ground + above, pz, speed, 0.3);
      if (py - ground <= 1.5 * above || left <= 0) this.gulpPhase[i] = GulpPhase.None;
    }
  }

  /**
   * Surface grazers (otocinclus, plecos) attach belly-down to glass or decor and crawl. Resting,
   * one settles onto the nearest surface and stays there without crawling or grazing.
   */
  private planGlassGrazer(i: number, plan: Plan, rest: number): void {
    const { rng } = this.host;
    const n3 = this.n3;
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const px = at(this.host.position, i * 3);
    const py = at(this.host.position, i * 3 + 1);
    const pz = at(this.host.position, i * 3 + 2);
    const standoff = BEHAVIOUR.glassStandoffThickness * BEHAVIOUR.bodyThicknessBodyLengths * length;
    const d = this.host.substrateSdf.sample(px, py, pz, n3);
    const nx = at(n3, 0);
    const ny = at(n3, 1);
    const nz = at(n3, 2);
    const resting = rest > 0.5;
    if (resting && at(this.grazePhase, i) === GrazePhase.Roam) {
      this.grazePhase[i] = GrazePhase.None;
    }
    const phase = at(this.grazePhase, i);
    const left = resting ? at(this.grazeTimer, i) : at(this.grazeTimer, i) - DT;
    this.grazeTimer[i] = left;
    plan.floor = false;
    plan.bandLo = this.host.basin.ground(px, pz);
    plan.bandHi = this.host.basin.maxY;
    if (phase === GrazePhase.Roam) {
      if (left <= 0) this.grazePhase[i] = GrazePhase.None;
      return;
    }
    plan.comfort = BEHAVIOUR.minComfort;
    plan.align = 0;
    plan.cohesion = 0;
    if (phase !== GrazePhase.Graze) {
      plan.seek(
        px - nx * (d - standoff),
        py - ny * (d - standoff),
        pz - nz * (d - standoff),
        cruise,
        0.5,
      );
      plan.wander = 0.2;
      if (d < 1.5 * standoff) {
        this.grazePhase[i] = GrazePhase.Graze;
        this.grazeTimer[i] = rng.range(BEHAVIOUR.glassStayMinS, BEHAVIOUR.glassStayMaxS);
        this.crawlSign[i] = rng.next() < 0.5 ? -1 : 1;
      }
      return;
    }
    if (resting) {
      plan.state = FishState.Rest;
      plan.wander = 0;
      plan.speedFloor = 0;
      plan.speedCap = 0;
      plan.roll = this.bellyRoll(i, n3);
      if (d > 4 * standoff) this.grazePhase[i] = GrazePhase.None;
      return;
    }
    plan.state = FishState.Graze;
    plan.wander = 0;
    plan.speedCap = BEHAVIOUR.glassCrawlFactor * cruise;
    const sign = at(this.crawlSign, i);
    let tx = -nz * sign;
    let tz = nx * sign;
    const tl = Math.hypot(tx, tz);
    if (tl < 0.3) {
      tx = at(this.host.forward, i * 3);
      tz = at(this.host.forward, i * 3 + 2);
    } else {
      tx /= tl;
      tz /= tl;
    }
    const pull = d - standoff;
    plan.seek(
      px + tx * cruise - nx * pull,
      py - ny * pull,
      pz + tz * cruise - nz * pull,
      BEHAVIOUR.glassCrawlFactor * cruise,
      0.3,
    );
    plan.roll = this.bellyRoll(i, n3);
    if (left <= 0 || d > 4 * standoff) {
      this.grazePhase[i] = GrazePhase.Roam;
      this.grazeTimer[i] = rng.range(BEHAVIOUR.glassRoamMinS, BEHAVIOUR.glassRoamMaxS);
    }
  }

  private planFree(i: number, sp: SimSpecies, plan: Plan): void {
    const rest = at(this.rest, i);
    if (sp.grazer === 'rock' && this.planGrazeBout(i, plan, rest)) return;
    if (sp.schooling) return;
    if (rest > 0.5) {
      const o = i * 3;
      if (this.restSpotSet[i] === 0) {
        this.chooseStation(i, this.restSpot, o);
        this.restSpotSet[i] = 1;
      }
      this.holdStation(
        i,
        plan,
        at(this.restSpot, o),
        at(this.restSpot, o + 1),
        at(this.restSpot, o + 2),
        2 * at(this.host.bodyLength, i),
        FishState.Rest,
      );
      plan.speedFloor = 0;
    } else if (rest < 0.3) {
      this.restSpotSet[i] = 0;
    }
  }

  /** Tangs graze turf algae on rock in short pecking bouts (Montgomery et al. 1989). */
  private planGrazeBout(i: number, plan: Plan, rest: number): boolean {
    const { rng } = this.host;
    const sp = this.speciesOf(i);
    const phase = at(this.grazePhase, i);
    if (phase === GrazePhase.None) {
      const next = at(this.grazeNext, i) - DT;
      this.grazeNext[i] = next;
      if (next > 0 || rest > 0.5) return false;
      this.grazeNext[i] = -Math.log(1 - rng.next()) * sp.grazeMeanIntervalS;
      if (!this.pickGrazeSpot(i)) return false;
      this.grazePhase[i] = GrazePhase.Approach;
      this.grazeTimer[i] = BEHAVIOUR.grazeApproachTimeoutS;
    }
    const o = i * 3;
    const gx = at(this.grazeTarget, o);
    const gy = at(this.grazeTarget, o + 1);
    const gz = at(this.grazeTarget, o + 2);
    const px = at(this.host.position, o);
    const py = at(this.host.position, o + 1);
    const pz = at(this.host.position, o + 2);
    const length = at(this.host.bodyLength, i);
    const cruise = at(this.host.cruiseSpeed, i);
    const left = at(this.grazeTimer, i) - DT;
    this.grazeTimer[i] = left;
    plan.comfort = BEHAVIOUR.grazeComfort;
    plan.align = 0;
    plan.cohesion = 0;
    plan.wander *= 0.3;
    this.widenBand(plan, gy, length);
    if (at(this.grazePhase, i) === GrazePhase.Approach) {
      plan.seek(gx, gy, gz, cruise, 1);
      plan.continuous = true;
      const ex = gx - px;
      const ey = gy - py;
      const ez = gz - pz;
      const d = Math.hypot(ex, ey, ez);
      const ahead = ex * at(this.host.forward, o) + ez * at(this.host.forward, o + 2);
      if (d < 0.5 * length) {
        this.grazePhase[i] = GrazePhase.Graze;
        this.grazeTimer[i] = rng.range(sp.grazeMinS, sp.grazeMaxS);
        this.grazeYaw[i] = at(this.host.yaw, i);
      } else if (left <= 0) {
        this.grazePhase[i] = GrazePhase.None;
      } else if (ahead < 0.3 * d && !this.pickGrazeSpot(i)) {
        // Steering back onto a spot slipping past the flank would orbit it; take one ahead instead.
        this.grazePhase[i] = GrazePhase.None;
      }
      return true;
    }
    if (Math.hypot(gx - px, gy - py, gz - pz) > length) this.grazePhase[i] = GrazePhase.None;
    plan.state = FishState.Graze;
    plan.speedFloor = 0;
    // The heading is held, so creeping on once the spot is abeam only drives the snout into
    // whatever lies beyond it (often the back glass); the fish stops and pecks instead.
    const ex = gx - px;
    const ez = gz - pz;
    const ahead = ex * at(this.host.forward, o) + ez * at(this.host.forward, o + 2);
    const toward = clamp(ahead / Math.max(Math.hypot(ex, gy - py, ez), 1e-9), 0, 1);
    plan.speedCap = BEHAVIOUR.grazeSpeedFactor * cruise * toward;
    plan.seek(gx, gy, gz, BEHAVIOUR.grazeSpeedFactor * cruise, 0.5);
    // Chasing a point at pecking speed overshoots it and orbits, and pivoting on the spot swings
    // the tail into the rock; the fish keeps the heading it arrived with, already facing the rock.
    plan.yaw = at(this.grazeYaw, i);
    if (left <= 0) this.grazePhase[i] = GrazePhase.None;
    return true;
  }

  /** Projects a few random nearby points onto hard decor and keeps the closest standoff spot. */
  private pickGrazeSpot(i: number): boolean {
    const { rng, decorSdf, substrateSdf, sceneSdf, basin } = this.host;
    const field = decorSdf ?? substrateSdf;
    const n3 = this.n3;
    const o = i * 3;
    const px = at(this.host.position, o);
    const py = at(this.host.position, o + 1);
    const pz = at(this.host.position, o + 2);
    const length = at(this.host.bodyLength, i);
    const thickness = BEHAVIOUR.bodyThicknessBodyLengths * length;
    const standoff = thickness + BEHAVIOUR.grazeStandoffBodyLengths * length;
    const fx = at(this.host.forward, o);
    const fz = at(this.host.forward, o + 2);
    let best = Infinity;
    for (let c = 0; c < 4; c++) {
      let x = px + rng.signed() * 0.3;
      let y = clamp(py + rng.signed() * 0.15, basin.minY, basin.maxY);
      let z = pz + rng.signed() * 0.3;
      let d = Infinity;
      for (let k = 0; k < 8; k++) {
        d = field.sample(x, y, z, n3);
        x -= at(n3, 0) * d;
        y -= at(n3, 1) * d;
        z -= at(n3, 2) * d;
        if (Math.abs(d) < 1e-4) break;
      }
      if (Math.abs(d) > 1e-3) continue;
      field.sample(x, y, z, n3);
      const nx = at(n3, 0);
      const ny = at(n3, 1);
      const nz = at(n3, 2);
      // Only a face the fish is already swimming toward; grazing the far side means a U-turn.
      if (nx * fx + nz * fz > 0.3) continue;
      const gx = x + nx * standoff;
      const gy = y + ny * standoff;
      const gz = z + nz * standoff;
      if (sceneSdf.sample(gx, gy, gz, n3) < thickness * 1.2) continue;
      // The body trails back from the rock along its normal; a spot hemmed in by glass or a
      // second rock behind leaves no room to back off and turn away after the bout.
      const back = standoff + BEHAVIOUR.grazeBackRoomBodyLengths * length;
      if (
        sceneSdf.sample(x + nx * back, y + ny * back, z + nz * back, n3) <
        BEHAVIOUR.grazeBackRoomBodyLengths * length
      ) {
        continue;
      }
      if (gy > basin.maxY - 2 * length) continue;
      const dist = Math.hypot(gx - px, gy - py, gz - pz);
      // Doubling back to a spot behind costs a U-turn; a forager picks what lies ahead.
      if ((gx - px) * fx + (gz - pz) * fz < 0) continue;
      if (dist < best) {
        best = dist;
        this.grazeTarget[o] = gx;
        this.grazeTarget[o + 1] = gy;
        this.grazeTarget[o + 2] = gz;
      }
    }
    return best < Infinity;
  }
}
