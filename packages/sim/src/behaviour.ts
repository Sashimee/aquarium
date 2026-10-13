import type { Basin } from './basin.ts';
import type { Point3 } from './decor.ts';
import { FEEDING, Feeding, feedingHeight } from './feeding.ts';
import type { FoodStore } from './food.ts';
import { clamp, DEG, wrapAngle } from './math.ts';
import { selectNearest } from './neighbours.ts';
import type { Rng } from './rng.ts';
import type { Sdf } from './sdf.ts';
import { FishState } from './snapshot.ts';
import type { SimSpecies } from './species.ts';

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

  nightLight: 0.25,
  dayLight: 0.35,
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
  readonly food: FoodStore;
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
  }

  seek(x: number, y: number, z: number, speed: number, tau: number, weight = 1): void {
    this.seekX = x;
    this.seekY = y;
    this.seekZ = z;
    this.seekSpeed = speed;
    this.seekTau = tau;
    this.seekWeight = weight;
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
  light = 1;
  night = false;

  private readonly host: BehaviourHost;
  private anchors: readonly Anchor[] = [];
  private readonly stimuli: Stimulus[] = [];

  private readonly startlePhase: Uint8Array;
  private readonly startleTimer: Float64Array;
  private readonly startleElapsed: Float64Array;
  private readonly escapeYaw: Float64Array;
  private readonly escapePitch: Float64Array;
  private readonly startleAt: Float64Array;
  private readonly scheduledYaw: Float64Array;
  private readonly scheduledPitch: Float64Array;
  private readonly refractory: Float64Array;
  readonly tighten: Float64Array;
  private readonly habituation: Float64Array;
  /** Tick at which each fish last began a startle, or -1. */
  readonly startledAt: Float64Array;

  readonly rest: Float64Array;
  private readonly restTau: Float64Array;
  private readonly restSpot: Float64Array;
  private readonly restSpotSet: Uint8Array;

  private readonly home: Float64Array;
  private readonly homeTimer: Float64Array;
  readonly anchor: Int32Array;
  private readonly shelterTimer: Float64Array;

  private readonly territoryPhase: Uint8Array;
  private readonly territoryTimer: Float64Array;
  private readonly territoryCheck: Float64Array;
  private readonly territoryCooldown: Float64Array;
  readonly yieldTimer: Float64Array;
  private readonly yieldYaw: Float64Array;
  readonly territoryTarget: Int32Array;

  private readonly gulpPhase: Uint8Array;
  private readonly gulpTimer: Float64Array;

  private readonly grazePhase: Uint8Array;
  private readonly grazeTimer: Float64Array;
  private readonly grazeNext: Float64Array;
  private readonly grazeTarget: Float64Array;
  private readonly grazeYaw: Float64Array;
  private readonly crawlSign: Float64Array;

  private readonly sifting: Uint8Array;
  private readonly forageTimer: Float64Array;

  private readonly excursion: Uint8Array;
  private readonly excursionTimer: Float64Array;
  private readonly excursionTarget: Float64Array;

  private readonly groupHome: Float64Array;
  private readonly groupTimer: Float64Array;
  private readonly groupSize: Int32Array;
  private readonly groupLeader: Int32Array;

  private readonly nbr: Int32Array;
  private readonly nbrDist: Float64Array;
  private readonly n3 = new Float64Array(3);
  private bandLo = 0;
  private bandHi = 0;

  constructor(host: BehaviourHost) {
    this.host = host;
    const n = host.count;
    const s = host.species.length;
    this.plans = Array.from({ length: n }, () => new Plan());
    this.feeding = new Feeding(host);
    this.startlePhase = new Uint8Array(n);
    this.startleTimer = new Float64Array(n);
    this.startleElapsed = new Float64Array(n);
    this.escapeYaw = new Float64Array(n);
    this.escapePitch = new Float64Array(n);
    this.startleAt = new Float64Array(n).fill(-1);
    this.scheduledYaw = new Float64Array(n);
    this.scheduledPitch = new Float64Array(n);
    this.refractory = new Float64Array(n);
    this.tighten = new Float64Array(n);
    this.habituation = new Float64Array(n);
    this.startledAt = new Float64Array(n).fill(-1);
    this.rest = new Float64Array(n);
    this.restTau = new Float64Array(n);
    this.restSpot = new Float64Array(n * 3);
    this.restSpotSet = new Uint8Array(n);
    this.home = new Float64Array(n * 3);
    this.homeTimer = new Float64Array(n);
    this.anchor = new Int32Array(n).fill(-1);
    this.shelterTimer = new Float64Array(n);
    this.territoryPhase = new Uint8Array(n);
    this.territoryTimer = new Float64Array(n);
    this.territoryCheck = new Float64Array(n);
    this.territoryCooldown = new Float64Array(n);
    this.yieldTimer = new Float64Array(n);
    this.yieldYaw = new Float64Array(n);
    this.territoryTarget = new Int32Array(n).fill(-1);
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
    this.groupHome = new Float64Array(s * 3);
    this.groupTimer = new Float64Array(s);
    this.groupSize = new Int32Array(s);
    this.groupLeader = new Int32Array(s).fill(-1);
    this.nbr = new Int32Array(BEHAVIOUR.relayNeighbours);
    this.nbrDist = new Float64Array(BEHAVIOUR.relayNeighbours);
  }

  /** Draws each fish's private timers; call once positions are spawned. */
  init(): void {
    const { rng } = this.host;
    for (let i = 0; i < this.host.count; i++) {
      const sp = this.speciesOf(i);
      const si = at(this.host.speciesIndex, i);
      this.restTau[i] = BEHAVIOUR.restTauS * (1 + BEHAVIOUR.restTauJitter * rng.signed());
      this.territoryCheck[i] = rng.range(0, BEHAVIOUR.territoryCheckS);
      this.grazeNext[i] = rng.range(0, BEHAVIOUR.grazeMeanIntervalS);
      this.crawlSign[i] = rng.next() < 0.5 ? -1 : 1;
      this.forageTimer[i] = rng.range(BEHAVIOUR.moveMinS, BEHAVIOUR.moveMaxS);
      this.excursionTimer[i] = rng.range(0, 2 * BEHAVIOUR.excursionMeanIntervalS);
      if (sp.home === 'station' && sp.schooling) {
        this.groupSize[si] = at(this.groupSize, si) + 1;
        if (at(this.groupLeader, si) < 0) this.groupLeader[si] = i;
      }
    }
    for (let i = 0; i < this.host.count; i++) this.pickHome(i);
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
    const ordinal = new Map<string, number>();
    for (let i = 0; i < this.host.count; i++) {
      const sp = this.speciesOf(i);
      const kind = sp.home === 'anemone' || sp.home === 'cave' ? sp.home : null;
      this.anchor[i] = -1;
      if (kind === null) continue;
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

  setLight(level: number): void {
    if (!(level >= 0 && level <= 1)) {
      throw new RangeError(`light level must be within [0, 1], got ${level}`);
    }
    this.light = level;
  }

  isStartled(i: number): boolean {
    return at(this.startlePhase, i) !== StartlePhase.None;
  }

  update(): void {
    const n = this.host.count;
    if (this.light < BEHAVIOUR.nightLight) this.night = true;
    else if (this.light > BEHAVIOUR.dayLight) this.night = false;
    const restTarget = this.night ? 1 : 0;
    const habDecay = Math.exp(-DT / BEHAVIOUR.habituationTauS);
    for (let i = 0; i < n; i++) {
      this.refractory[i] = Math.max(0, at(this.refractory, i) - DT);
      this.tighten[i] = Math.max(0, at(this.tighten, i) - DT);
      this.shelterTimer[i] = Math.max(0, at(this.shelterTimer, i) - DT);
      this.habituation[i] = at(this.habituation, i) * habDecay;
      const r = at(this.rest, i);
      this.rest[i] = r + (restTarget - r) * (1 - Math.exp(-DT / at(this.restTau, i)));
    }
    this.updateGroups();
    for (const s of this.stimuli) this.applyStimulus(s);
    this.stimuli.length = 0;
    const tick = this.host.tick;
    for (let i = 0; i < n; i++) {
      if (at(this.startleAt, i) === tick) {
        this.startleAt[i] = -1;
        this.beginStartle(i, at(this.scheduledYaw, i), at(this.scheduledPitch, i));
      }
    }
    this.prepareFeeding();
    this.feeding.update();
    for (let i = 0; i < n; i++) this.plan(i);
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
        at(this.shelterTimer, i) <= 0 &&
        at(this.rest, i) <= 0.5
          ? 1
          : 0;
      const a = this.anchors[at(this.anchor, i)];
      const o = i * 4;
      if (a === undefined) {
        leash[o + 3] = Infinity;
        continue;
      }
      leash[o] = a.position[0];
      leash[o + 1] = a.position[1];
      leash[o + 2] = a.position[2];
      leash[o + 3] = a.radius + FEEDING.leashBodyLengths * at(this.host.bodyLength, i);
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
      this.groupTimer[s] = this.host.rng.range(BEHAVIOUR.restationMinS, BEHAVIOUR.restationMaxS);
    }
  }

  private pickHome(i: number): void {
    const sp = this.speciesOf(i);
    if (sp.home === 'none') return;
    this.chooseStation(i, this.home, i * 3);
    this.homeTimer[i] = this.host.rng.range(BEHAVIOUR.restationMinS, BEHAVIOUR.restationMaxS);
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
        (1 - BEHAVIOUR.boldnessDamping * sp.boldness) *
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

  private beginStartle(i: number, yaw: number, pitch: number): void {
    if (at(this.refractory, i) > 0 || at(this.startlePhase, i) !== StartlePhase.None) return;
    const sp = this.speciesOf(i);
    this.startlePhase[i] = StartlePhase.Bend;
    this.startleTimer[i] = BEHAVIOUR.cBendMaxS;
    this.startleElapsed[i] = 0;
    this.escapeYaw[i] = yaw;
    this.escapePitch[i] = pitch;
    this.refractory[i] = BEHAVIOUR.refractoryS;
    if (sp.tightenWhenStartled) this.tighten[i] = BEHAVIOUR.tightenS;
    this.habituation[i] = at(this.habituation, i) + 1;
    this.startledAt[i] = this.host.tick;
    this.territoryPhase[i] = TerritoryPhase.Idle;
    this.gulpPhase[i] = GulpPhase.None;
    if (this.grazePhase[i] !== GrazePhase.Roam) this.grazePhase[i] = GrazePhase.None;
    this.excursion[i] = 0;
    if (sp.home === 'cave') this.shelterTimer[i] = BEHAVIOUR.shelterAfterStartleS;
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
    plan.cruiseScale = calm;
    plan.wander = calm;
    const school = 1 - (1 - BEHAVIOUR.restSchoolFactor) * rest;
    plan.align = school * (sp.shoal ? BEHAVIOUR.shoalAlignment : 1);
    plan.cohesion = school * (sp.shoal ? BEHAVIOUR.shoalCohesion : 1);
    if (at(this.tighten, i) > 0) {
      plan.cohesion *= BEHAVIOUR.tightenCohesion;
      plan.separation *= BEHAVIOUR.tightenSeparation;
    }
    if (sp.gait === 'cruise') {
      plan.speedFloor = BEHAVIOUR.cruiseSpeedFloor * at(this.host.cruiseSpeed, i) * calm;
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
    if (sp.gait === 'forage') {
      this.planForage(i, sp, plan);
    } else if (sp.grazer === 'glass') {
      this.planGlassGrazer(i, plan);
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
      plan.pivot = f.grazes(k) && d < length;
    }
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
    if (a !== undefined) {
      const [tx, ty, tz] = this.approach(i, a);
      plan.seek(tx, ty, tz, speed, 0.3);
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

  private territoryCentre(i: number, sp: SimSpecies): [number, number, number, number] {
    const length = at(this.host.bodyLength, i);
    const a = this.anchors[at(this.anchor, i)];
    if (a !== undefined) {
      const r = a.radius + BEHAVIOUR.anchorTerritoryBodyLengths * length;
      return [a.position[0], a.position[1], a.position[2], r];
    }
    const r = BEHAVIOUR.territoryBodyLengths * length;
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
          this.territoryTimer[i] = rng.range(BEHAVIOUR.flareMinS, BEHAVIOUR.flareMaxS);
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
      plan.speedCap = BEHAVIOUR.siftSpeedFactor * cruise;
      plan.yaw = Math.atan2(jx - px, jz - pz);
      if (left <= 0) {
        this.territoryPhase[i] = TerritoryPhase.Charge;
        this.territoryTimer[i] = BEHAVIOUR.chargeS;
      }
      return;
    }
    plan.state = FishState.Display;
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
      const radius = BEHAVIOUR.stationRadiusBodyLengths * length + 0.5 * length * Math.sqrt(size);
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
      BEHAVIOUR.stationRadiusBodyLengths * length,
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
          this.excursionTimer[i] = this.host.rng.range(0, 2 * BEHAVIOUR.excursionMeanIntervalS);
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
        a.radius + BEHAVIOUR.hostLeashBodyLengths * length,
        FishState.Host,
      );
      return;
    }
    if (rest > 0.5 || at(this.shelterTimer, i) > 0) {
      plan.comfort = BEHAVIOUR.shelterComfort;
      const [tx, ty, tz] = this.approach(i, a);
      this.holdStation(
        i,
        plan,
        tx,
        ty,
        tz,
        Math.max(0.6 * a.radius, 0.5 * length),
        FishState.Shelter,
      );
      if (plan.state === FishState.Shelter) this.bellyToSurface(i, sp, plan);
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
    this.bellyToSurface(i, sp, plan);
  }

  /**
   * Where to swim to reach an anchor: straight to it, except that a cave is entered through its
   * mouth, so a fish beside or behind the rock first goes round to the front.
   */
  private approach(i: number, a: Anchor): Point3 {
    const [ax, ay, az] = a.position;
    const f = a.facing;
    const fl = f === undefined ? 0 : Math.hypot(f[0], f[1], f[2]);
    if (a.kind !== 'cave' || f === undefined || fl < 1e-9) return a.position;
    const ux = f[0] / fl;
    const uy = f[1] / fl;
    const uz = f[2] / fl;
    const rx = at(this.host.position, i * 3) - ax;
    const ry = at(this.host.position, i * 3 + 1) - ay;
    const rz = at(this.host.position, i * 3 + 2) - az;
    const along = rx * ux + ry * uy + rz * uz;
    const lateral = Math.hypot(rx - along * ux, ry - along * uy, rz - along * uz);
    if (Math.hypot(rx, ry, rz) <= a.radius || (along > 0 && lateral < a.radius)) return a.position;
    const out = a.radius + BEHAVIOUR.caveMouthBodyLengths * at(this.host.bodyLength, i);
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
      this.excursionTimer[i] = rng.range(0, BEHAVIOUR.excursionMeanIntervalS);
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
      const p = 1 - Math.exp(-(BEHAVIOUR.gulpsPerHour / 3600) * DT);
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

  /** Surface grazers (otocinclus, plecos) attach belly-down to glass or decor and crawl. */
  private planGlassGrazer(i: number, plan: Plan): void {
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
    const phase = at(this.grazePhase, i);
    const left = at(this.grazeTimer, i) - DT;
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
    const phase = at(this.grazePhase, i);
    if (phase === GrazePhase.None) {
      const next = at(this.grazeNext, i) - DT;
      this.grazeNext[i] = next;
      if (next > 0 || rest > 0.5) return false;
      this.grazeNext[i] = -Math.log(1 - rng.next()) * BEHAVIOUR.grazeMeanIntervalS;
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
        this.grazeTimer[i] = rng.range(BEHAVIOUR.grazeMinS, BEHAVIOUR.grazeMaxS);
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
