import type { Collider, TankSpace } from '@aquarium/shared';
import { Basin, type TankDimensions } from './basin.ts';
import { Behaviour, BEHAVIOUR, type Anchor, type Plan, type Stimulus } from './behaviour.ts';
import { DecorField, UnionSdf, type Point3 } from './decor.ts';
import { FishResize } from './fishArrays.ts';
import { FoodStore, type AteEvent } from './food.ts';
import { clamp, DEG, quatFromYawPitchRoll, wrapAngle } from './math.ts';
import { pairwiseDistanceSq, selectNearest } from './neighbours.ts';
import { Rng } from './rng.ts';
import { smoothGradient, TankSdf, type Sdf } from './sdf.ts';
import { FishState, SNAPSHOT_STRIDE } from './snapshot.ts';
import {
  DRAG_COEFFICIENT_L2,
  toSimSpecies,
  WATER_DENSITY,
  type SimSpecies,
  type SpeciesInput,
} from './species.ts';

export const STEP_HZ = 30;
export const STEP_DT = 1 / STEP_HZ;

/** Every tunable of the steering model; sources are in BEHAVIOUR.md. */
export const STEERING = {
  separationZoneBodyLengths: 1,
  separationWeight: 2,
  coGrazeSeparation: 0.25,
  alignmentWeight: 1.5,
  cohesionRatePerS: 1,
  anyNeighbours: 6,
  wanderTurnSdRadPerS: 0.5,
  wanderTurnTauS: 0.8,
  wanderLookaheadS: 0.5,
  wanderPitchSdRad: 0.12,
  wanderPitchTauS: 2,
  depthTauS: 2,
  depthMaxSpeedFraction: 0.5,
  avoidLookaheadS: 0.8,
  avoidMarginBodyLengths: 0.75,
  proximityBodyLengths: 0.25,
  avoidGradientBodyLengths: 0.5,
  avoidPriority: 0.5,
  avoidReleaseThreshold: 0.15,
  avoidMemoryS: 1.5,
  avoidMaxSwingCos: -0.2,
  slideMinHorizontal: 0.2,
  slideWishFraction: 0.25,
  standOffPasses: 3,
  standOffBearingShares: [0.5, 0.25],
  standOffFacingRad: 0.5,
  standOffRingSteps: 12,
  standOffBrakeS: 1,
  turnRoomSamples: 3,
  turnRingHeadings: 4,
  turnRoomMarginBodyLengths: 0.05,
  avoidClosingGain: 2,
  avoidMinSpeedFraction: 0.5,
  headingHoldFraction: 0.1,
  fullTurnSpeedFraction: 1,
  intentSmoothingS: 0.15,
  turnGainPerS: 6,
  turnSmoothingS: 0.1,
  speedResponseS: 0.4,
  maxBankRad: 35 * DEG,
  bankReferenceAccel: 1,
  bankSmoothingS: 0.2,
  collisionRadiusBodyLengths: 0.5,
  plantPushFraction: 0.5,
  plantSlowdown: 0.3,
  spawnAttempts: 200,
  tiltClearanceThickness: 1.5,
  detourS: 1.5,
  minTurnRadiusBodyLengths: 0.4,
  pivotTurnRateRadPerS: 1,
  crampedClearanceBodyLengths: 0.15,
  narrowingFlipRatio: 0.7,
  pinnedProgressFraction: 0.2,
  backOutAfterS: 0.3,
  backOutSpeedFraction: 0.5,
  backOutBodyLengths: 0.3,
  backOutMaxBodyLengths: 2,
  backOutAlignedRad: 30 * DEG,
  backOutBlockedCos: 0.5,
  scrapeWindowS: 1,
  scrapeContactFraction: 0.2,
  scrapeDriftBodyLengths: 0.5,
  deadEndMemoryS: 10,
  deadEndRadiusBodyLengths: 4,
  deadEndBearingCos: 0.3,
  deadEndBehindFaceBodyLengths: 0.5,
  deadEndHeightBodyLengths: 0.75,
  pathTraceSteps: 24,
  pathTraceMinStep: 0.25,
} as const;

export interface FishSpawn {
  readonly id: string;
  readonly species: string;
  /** Overrides the species' adult body length, e.g. for a growing fish. */
  readonly bodyLengthM?: number;
}

interface WorldConfigBase {
  readonly seed: number;
  readonly species: readonly SpeciesInput[];
  readonly fish: readonly FishSpawn[];
  /** Hard colliders block fish; soft ones (plants) only push them aside. */
  readonly decor?: readonly Collider[];
  readonly anchors?: readonly Anchor[];
  /** Tank light, 0 (dark) to 1 (full day). */
  readonly light?: number;
}

/**
 * A world in tank space from @aquarium/shared, identical to the scene's coordinates: the water box
 * comes from `tankWaterBounds` and the floor follows `sampleFloor`. Every position the sim takes
 * or reports (fish, food, startle stimuli, decor colliders, anchors) is in that frame.
 */
export interface TankSpaceWorldConfig extends WorldConfigBase {
  readonly space: TankSpace;
  readonly tank?: undefined;
}

/**
 * The legacy world: a box with a flat floor at y = 0, centred on x = z = 0. A client mapping scene
 * positions into it must subtract the one constant offset it built the box with.
 */
export interface WorldConfig extends WorldConfigBase {
  readonly tank: TankDimensions;
  readonly space?: undefined;
}

export type AnyWorldConfig = TankSpaceWorldConfig | WorldConfig;

/** Where a fish added to a running world starts, in the world's frame. */
export interface FishPlacement {
  readonly position: Point3;
  /** Yaw in radians; 0 faces +z, π/2 faces +x. */
  readonly heading: number;
}

const PENETRATION_EPSILON = 1e-9;

/**
 * Steering never samples further than ~1.75 body lengths from a surface; beyond that reach the
 * decor field only has to report "far".
 */
function decorReach(longestBodyLength: number): number {
  return Math.max(0.05, 2 * longestBodyLength);
}

function clampInto(v: number, lo: number, hi: number): number {
  return lo > hi ? 0.5 * (lo + hi) : clamp(v, lo, hi);
}

/** The 26 unit directions to the neighbours of a cube cell, axes first. */
const SHELL_DIRECTIONS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (const dx of [0, -1, 1]) {
    for (const dy of [0, -1, 1]) {
      for (const dz of [0, -1, 1]) {
        const l = Math.hypot(dx, dy, dz);
        if (l > 0) out.push([dx / l, dy / l, dz / l]);
      }
    }
  }
  return out.sort((a, b) => countZeros(b) - countZeros(a));
})();

function checkPlacement(id: string, at: FishPlacement): void {
  const p: unknown = typeof at === 'object' && at !== null ? at.position : undefined;
  const valid =
    Array.isArray(p) &&
    p.length === 3 &&
    p.every((c) => typeof c === 'number' && Number.isFinite(c)) &&
    typeof at.heading === 'number' &&
    Number.isFinite(at.heading);
  if (!valid) {
    throw new RangeError(
      `fish "${id}": placement needs a finite [x, y, z] position and a finite heading`,
    );
  }
}

function countZeros(v: readonly number[]): number {
  return v.filter((c) => c === 0).length;
}

interface Fit {
  readonly id: string;
  readonly si: number;
  readonly sp: SimSpecies;
  readonly length: number;
  /** Collision radius. */
  readonly r: number;
}

interface Spot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}
const MAX_BODY_PUSHES = 8;
const STATION_MEMO = 8;

const NO_ATE_EVENTS: readonly AteEvent[] = Object.freeze([]);

export class World {
  private _count: number;
  private _fishIds: readonly string[];
  /** The water and the floor under it, in the world's frame. */
  readonly basin: Basin;
  readonly species: readonly SimSpecies[];
  tick = 0;
  /** Steps where the hard SDF constraint had to move a fish; avoidance should keep this rare. */
  contacts = 0;
  /** Fish-steps spent inside a plant (soft contact). */
  plantContacts = 0;
  /** Stand-off spots tested for room to face the food from; the bearing search behind them is cached. */
  stationChecks = 0;
  /** Fish-steps spent rising in place before crossing to a stand-off station over the top of a rock. */
  climbs = 0;

  private _position: Float64Array;
  private _yaw: Float64Array;
  private _pitch: Float64Array;
  private _roll: Float64Array;
  private _speed: Float64Array;
  private _yawRate: Float64Array;
  private _pitchRate: Float64Array;
  private _state: Uint8Array;

  private _bodyLength: Float64Array;
  private _radius: Float64Array;
  private _thickness: Float64Array;
  private _speciesIndex: Int32Array;
  private _thrust: Float64Array;
  private _contactCount: Uint32Array;
  private _forward: Float64Array;
  private _distSq: Float64Array;
  private _maxSpeed: Float64Array;
  private _cruiseSpeed: Float64Array;

  readonly rng: Rng;
  readonly food: FoodStore;
  readonly behaviour: Behaviour;
  /** Tank and hard decor: what no fish body may enter. */
  readonly sceneSdf: Sdf;
  readonly substrateSdf: Sdf;
  private readonly hardDecor: DecorField;
  private readonly softDecor: DecorField;
  /** Steering fields indexed by (floor ? 1 : 0) + (surface ? 2 : 0). */
  private readonly steerSdf: readonly Sdf[];
  private mass: Float64Array;
  private drag: Float64Array;
  private coasting: Uint8Array;
  private gaitTimer: Float64Array;
  private detourSign: Int8Array;
  private detourTimer: Float64Array;
  private cramped: Uint8Array;
  private wedged: Float64Array;
  private reverseLeft: Float64Array;
  private scrapeAnchor: Float64Array;
  private scrapeTime: Float64Array;
  private scrapeHits: Uint16Array;
  /** Spot where the fish last had to back out, avoided while its timer runs. */
  private deadEnd: Float64Array;
  private deadEndTimer: Float64Array;
  /**
   * Per fish, the last stand-off ring search: `[epoch, sdf, foodX, foodY, foodZ, arrival, side,
   * bearing]`, where bearing is NaN when the station stays straight out from the surface. Valid
   * while its epoch is `stationEpoch`, which moves on whenever hard decor or the fish set changes:
   * a joining fish can widen the hard-decor reach, and a search cached at the old, smaller reach
   * would miss rock the wider field now reports.
   */
  private stationMemo: Float64Array;
  private stationEpoch = 1;
  private wanderTurn: Float64Array;
  private wanderPitch: Float64Array;
  /** Horizontal unit slide direction along the wall being avoided; zero when disengaged. */
  private avoidTangent: Float64Array;
  /** Slide direction when the current avoidance engagement began. */
  private avoidOrigin: Float64Array;
  private avoidMemory: Float64Array;
  private intent: Float64Array;
  private targetYaw: Float64Array;
  private targetPitch: Float64Array;
  private targetSpeed: Float64Array;
  private schoolGroup: Int32Array;
  private readonly kMax: number;
  private readonly speciesById: ReadonlyMap<string, number>;
  private schoolNbr: Int32Array;
  private anyNbr: Int32Array;
  private readonly scratchDist: Float64Array;
  private readonly normal = new Float64Array(3);
  private readonly probeNormal = new Float64Array(3);
  private readonly previous = new Float64Array(3);
  private readonly turnNormal = new Float64Array(3);

  get count(): number {
    return this._count;
  }

  get fishIds(): readonly string[] {
    return this._fishIds;
  }

  get position(): Float64Array {
    return this._position;
  }

  get yaw(): Float64Array {
    return this._yaw;
  }

  get pitch(): Float64Array {
    return this._pitch;
  }

  get roll(): Float64Array {
    return this._roll;
  }

  get speed(): Float64Array {
    return this._speed;
  }

  get yawRate(): Float64Array {
    return this._yawRate;
  }

  get pitchRate(): Float64Array {
    return this._pitchRate;
  }

  get state(): Uint8Array {
    return this._state;
  }

  get bodyLength(): Float64Array {
    return this._bodyLength;
  }

  /** Comfort radius steering keeps from surfaces; the hard body is a thinner spine chain. */
  get radius(): Float64Array {
    return this._radius;
  }

  get thickness(): Float64Array {
    return this._thickness;
  }

  get speciesIndex(): Int32Array {
    return this._speciesIndex;
  }

  /** Caudal thrust as a fraction of the maximum; 0 while coasting. */
  get thrust(): Float64Array {
    return this._thrust;
  }

  /** Per-fish share of `contacts`. */
  get contactCount(): Uint32Array {
    return this._contactCount;
  }

  get forward(): Float64Array {
    return this._forward;
  }

  get distSq(): Float64Array {
    return this._distSq;
  }

  get maxSpeed(): Float64Array {
    return this._maxSpeed;
  }

  get cruiseSpeed(): Float64Array {
    return this._cruiseSpeed;
  }

  constructor(config: AnyWorldConfig) {
    this.rng = new Rng(config.seed);
    this.basin = basinOfConfig(config);
    this.species = config.species.map(toSimSpecies);
    const byId = new Map(this.species.map((s, i) => [s.id, i]));
    if (byId.size !== this.species.length) throw new Error('species ids must be unique');
    this.speciesById = byId;

    let longest = 0;
    for (const f of config.fish) {
      const sp = this.species[byId.get(f.species) ?? -1];
      longest = Math.max(longest, f.bodyLengthM ?? sp?.bodyLength ?? 0);
    }
    const reach = decorReach(longest);
    this.hardDecor = new DecorField(this.basin, reach);
    this.softDecor = new DecorField(this.basin, reach);
    this.setDecor(config.decor ?? []);
    const tankSdf = (floor: boolean, surface: boolean): TankSdf =>
      new TankSdf(this.basin, { floor, surface });
    this.sceneSdf = new UnionSdf([tankSdf(true, true), this.hardDecor]);
    this.substrateSdf = new UnionSdf([tankSdf(true, false), this.hardDecor]);
    this.steerSdf = [
      new UnionSdf([tankSdf(false, false), this.hardDecor]),
      this.substrateSdf,
      new UnionSdf([tankSdf(false, true), this.hardDecor]),
      this.sceneSdf,
    ];

    const n = config.fish.length;
    this._count = n;
    this._fishIds = config.fish.map((f) => f.id);
    if (new Set(this.fishIds).size !== n) throw new Error('fish ids must be unique');

    this._position = new Float64Array(n * 3);
    this._yaw = new Float64Array(n);
    this._pitch = new Float64Array(n);
    this._roll = new Float64Array(n);
    this._speed = new Float64Array(n);
    this._yawRate = new Float64Array(n);
    this._pitchRate = new Float64Array(n);
    this._state = new Uint8Array(n);
    this._bodyLength = new Float64Array(n);
    this._radius = new Float64Array(n);
    this._thickness = new Float64Array(n);
    this._speciesIndex = new Int32Array(n);
    this._thrust = new Float64Array(n);
    this._contactCount = new Uint32Array(n);
    this.coasting = new Uint8Array(n);
    this.gaitTimer = new Float64Array(n);
    this.detourSign = new Int8Array(n);
    this.detourTimer = new Float64Array(n);
    this.cramped = new Uint8Array(n);
    this.wedged = new Float64Array(n);
    this.reverseLeft = new Float64Array(n);
    this.scrapeAnchor = new Float64Array(n * 3);
    this.scrapeTime = new Float64Array(n);
    this.scrapeHits = new Uint16Array(n);
    this.deadEnd = new Float64Array(n * 3);
    this.deadEndTimer = new Float64Array(n);
    this.stationMemo = new Float64Array(n * STATION_MEMO);
    this.mass = new Float64Array(n);
    this.drag = new Float64Array(n);
    this._maxSpeed = new Float64Array(n);
    this._cruiseSpeed = new Float64Array(n);
    this.wanderTurn = new Float64Array(n);
    this.wanderPitch = new Float64Array(n);
    this.avoidTangent = new Float64Array(n * 2);
    this.avoidOrigin = new Float64Array(n * 2);
    this.avoidMemory = new Float64Array(n);
    this.intent = new Float64Array(n * 3);
    this.targetYaw = new Float64Array(n);
    this.targetPitch = new Float64Array(n);
    this.targetSpeed = new Float64Array(n);
    this._forward = new Float64Array(n * 3);
    this._distSq = new Float64Array(n * n);
    this.schoolGroup = new Int32Array(n);

    let kMax: number = STEERING.anyNeighbours;
    for (const s of this.species) kMax = Math.max(kMax, s.neighbours);
    this.kMax = kMax;
    this.schoolNbr = new Int32Array(n * kMax);
    this.anyNbr = new Int32Array(n * kMax);
    this.scratchDist = new Float64Array(kMax);

    config.fish.forEach((spawn, i) => {
      const fit = this.fit(spawn);
      this.spawn(i, fit, this.randomSpot(fit));
    });
    this.food = new FoodStore(this.basin);
    this.behaviour = new Behaviour(this);
    this.behaviour.setAnchors(config.anchors ?? []);
    this.behaviour.init();
    if (config.light !== undefined) this.behaviour.setLight(config.light);
  }

  get time(): number {
    return this.tick * STEP_DT;
  }

  get decorSdf(): Sdf | null {
    return this.hardDecor.size > 0 ? this.hardDecor : null;
  }

  get light(): number {
    return this.behaviour.light;
  }

  /** A glass tap or a fast pointer; fish nearby may C-start on the next step. */
  startle(stimulus: Stimulus): void {
    this.behaviour.startle(stimulus);
  }

  setLight(level: number): void {
    this.behaviour.setLight(level);
  }

  /**
   * Replaces the decor colliders. Only colliders whose id is new, gone or changed rebin their grid
   * cells; returns how many cells were rebuilt. A fish left inside moved decor is pushed out by
   * the body constraint on the next step.
   */
  setDecor(colliders: readonly Collider[]): number {
    const ids = new Set<string>();
    for (const c of colliders) {
      if (ids.has(c.id)) throw new Error(`decor collider ids must be unique, "${c.id}" repeats`);
      ids.add(c.id);
    }
    // Both plans validate before either field changes, so a bad collider leaves both as they were.
    const hard = this.hardDecor.plan(colliders.filter((c) => c.hard));
    const soft = this.softDecor.plan(colliders.filter((c) => !c.hard));
    const rebuilt = this.hardDecor.apply(hard) + this.softDecor.apply(soft);
    if (hard.gone.length > 0 || hard.changed.length > 0) this.stationEpoch++;
    return rebuilt;
  }

  setAnchors(anchors: readonly Anchor[]): void {
    this.behaviour.setAnchors(anchors);
  }

  /**
   * Replaces the food particles with `buffer`, records of `[id, x, y, z, typeIndex]` in tank
   * space. Call it every tick food is in the water; the sim reads the particles but never moves
   * them.
   */
  setFood(buffer: Float32Array): void {
    this.food.set(buffer, this.tick);
  }

  /** What fish have eaten since the last call, in the order it happened. */
  takeAteEvents(): readonly AteEvent[] {
    const events = this.behaviour.feeding.events;
    return events.length === 0 ? NO_ATE_EVENTS : events.splice(0);
  }

  /** Smallest distance from fish `i`'s spine chain to the tank or hard decor, minus its thickness. */
  bodyClearance(i: number): number {
    const o = i * 3;
    const length = this.bodyLength[i] ?? 0;
    const cp = Math.cos(this.pitch[i] ?? 0);
    const fx = Math.sin(this.yaw[i] ?? 0) * cp;
    const fy = Math.sin(this.pitch[i] ?? 0);
    const fz = Math.cos(this.yaw[i] ?? 0) * cp;
    let worst = Infinity;
    for (const s of BEHAVIOUR.bodySampleOffsets) {
      const k = s * length;
      const d = this.sceneSdf.sample(
        (this.position[o] ?? 0) + fx * k,
        (this.position[o + 1] ?? 0) + fy * k,
        (this.position[o + 2] ?? 0) + fz * k,
        this.normal,
      );
      worst = Math.min(worst, d);
    }
    return worst - (this.thickness[i] ?? 0);
  }

  speciesOf(i: number): SimSpecies {
    const s = this.species[this.speciesIndex[i] ?? -1];
    if (s === undefined) throw new RangeError(`no fish at index ${i}`);
    return s;
  }

  /** Validates `spawn` against the species and the tank without changing anything. */
  private fit(spawn: FishSpawn): Fit {
    const si = this.speciesById.get(spawn.species);
    if (si === undefined) {
      throw new Error(`fish "${spawn.id}" uses unknown species "${spawn.species}"`);
    }
    const sp = this.species[si];
    if (sp === undefined) throw new Error(`species index ${si} out of range`);
    const length = spawn.bodyLengthM ?? sp.bodyLength;
    if (!Number.isFinite(length) || length <= 0) {
      throw new RangeError(`fish "${spawn.id}": bodyLengthM must be positive, got ${length}`);
    }
    const r = length * STEERING.collisionRadiusBodyLengths;
    const basin = this.basin;
    if (2 * r >= Math.min(basin.width, basin.maxY - basin.floorMax, basin.depth)) {
      throw new RangeError(`fish "${spawn.id}" (${length} m) does not fit in the tank`);
    }
    return { id: spawn.id, si, sp, length, r };
  }

  private spawn(i: number, fit: Fit, spot: Spot): void {
    const { si, sp, length, r } = fit;
    // Isometric scaling: mass ∝ L³, drag area ∝ L², speeds in body lengths per second.
    const scale = length / sp.bodyLength;
    this.speciesIndex[i] = si;
    this.schoolGroup[i] = sp.schooling ? si : -1 - i;
    this.bodyLength[i] = length;
    this.radius[i] = r;
    this.thickness[i] = length * BEHAVIOUR.bodyThicknessBodyLengths;
    this.mass[i] = sp.mass * scale ** 3;
    this.drag[i] = 0.5 * WATER_DENSITY * DRAG_COEFFICIENT_L2 * length * length;
    this.maxSpeed[i] = sp.maxSpeed * scale;
    this.cruiseSpeed[i] = sp.cruiseSpeed * scale;
    const o = i * 3;
    this.position[o] = spot.x;
    this.position[o + 1] = spot.y;
    this.position[o + 2] = spot.z;
    this.scrapeAnchor.set(this.position.subarray(o, o + 3), o);
    this.yaw[i] = spot.yaw;
    // Hold the spawn heading until steering has a real direction (heading hold in `steer`).
    this.targetYaw[i] = spot.yaw;
    this.speed[i] = (this.cruiseSpeed[i] ?? 0) * 0.5;
  }

  /** A random free spot in the species' depth band, and a random heading. */
  private randomSpot(fit: Fit): Spot {
    const { sp, r } = fit;
    const basin = this.basin;
    const pad = r * 2;
    for (let attempt = 0; attempt < STEERING.spawnAttempts; attempt++) {
      const x = this.rng.range(basin.minX + pad, basin.maxX - pad);
      // Drawn before z (the depth band depends on the sand under x, z), but consumed as y.
      const t = this.rng.next();
      const z = this.rng.range(basin.minZ + pad, basin.maxZ - pad);
      const ground = basin.ground(x, z);
      const column = basin.maxY - ground;
      const yLo = ground + Math.max(sp.depthLow * column, pad);
      const yHi = ground + Math.min(sp.depthHigh * column, column - pad);
      // Fall back to the whole water column when decor crowds the preferred band.
      const inBand = attempt < STEERING.spawnAttempts / 2 && yLo <= yHi;
      const lo = inBand ? yLo : ground + pad;
      const hi = inBand ? yHi : basin.maxY - pad;
      const y = lo + (hi - lo) * t;
      if (this.hardDecor.sample(x, y, z, this.normal) < pad) continue;
      return { x, y, z, yaw: this.rng.range(-Math.PI, Math.PI) };
    }
    throw new RangeError(`fish "${fit.id}": no free water to spawn in, decor fills the tank`);
  }

  /**
   * The free spot nearest `at`: held a body length off the glass, the sand and the surface, then
   * pushed out of hard decor along its gradient, and failing that (rock against the glass) the
   * nearest clear point on a widening shell round it. Draws nothing from the RNG.
   */
  private spotNear(fit: Fit, at: FishPlacement): Spot {
    const [ax, ay, az] = at.position;
    const basin = this.basin;
    const pad = fit.r * 2;
    const n = this.normal;
    const inWater = (x: number, y: number, z: number): [number, number, number] => {
      const cx = clampInto(x, basin.minX + pad, basin.maxX - pad);
      const cz = clampInto(z, basin.minZ + pad, basin.maxZ - pad);
      return [cx, clampInto(y, basin.ground(cx, cz) + pad, basin.maxY - pad), cz];
    };
    const yaw = wrapAngle(at.heading);
    let [x, y, z] = inWater(ax, ay, az);
    for (let pass = 0; pass < STEERING.standOffPasses * 3; pass++) {
      const d = this.hardDecor.sample(x, y, z, n);
      if (d >= pad) return { x, y, z, yaw };
      [x, y, z] = inWater(
        x + (n[0] ?? 0) * (pad - d),
        y + (n[1] ?? 0) * (pad - d),
        z + (n[2] ?? 0) * (pad - d),
      );
    }
    const [sx, sy, sz] = inWater(ax, ay, az);
    const reach = Math.hypot(basin.width, basin.maxY - basin.minY, basin.depth);
    const step = 0.5 * pad;
    for (let shell = 1; shell * step <= reach; shell++) {
      let best: Spot | null = null;
      let bestD = Infinity;
      for (const [dx, dy, dz] of SHELL_DIRECTIONS) {
        const [cx, cy, cz] = inWater(
          sx + dx * shell * step,
          sy + dy * shell * step,
          sz + dz * shell * step,
        );
        if (this.hardDecor.sample(cx, cy, cz, n) < pad) continue;
        const d = Math.hypot(cx - ax, cy - ay, cz - az);
        if (d < bestD) {
          bestD = d;
          best = { x: cx, y: cy, z: cz, yaw };
        }
      }
      if (best !== null) return best;
    }
    throw new RangeError(
      `fish "${fit.id}": no free water near the placement, decor fills the tank`,
    );
  }

  /**
   * Adds a fish to the running world without disturbing the others: it is appended at index
   * `count`, so every other fish keeps its index and all its state. With `at` it starts there,
   * moved only as far as it takes to clear the glass, sand and rock; without, it spawns as fish do
   * at construction. Returns its index. When it throws, no fish has changed.
   */
  addFish(spawn: FishSpawn, at?: FishPlacement): number {
    if (this.fishIds.includes(spawn.id))
      throw new Error(`fish "${spawn.id}" is already in the world`);
    const fit = this.fit(spawn);
    if (at !== undefined) checkPlacement(fit.id, at);
    const rng = this.rng.state();
    const hardReach = this.hardDecor.reach;
    const softReach = this.softDecor.reach;
    // The spot search needs the newcomer's reach (its stand-off can exceed the old one), so the
    // fields widen first and are put back if no spot is found.
    this.widenDecorReach(fit.length);
    let spot: Spot;
    try {
      spot = at === undefined ? this.randomSpot(fit) : this.spotNear(fit, at);
    } catch (error) {
      this.rng.restore(rng);
      this.hardDecor.restoreReach(hardReach);
      this.softDecor.restoreReach(softReach);
      throw error;
    }
    const i = this.count;
    this.resize(FishResize.join(i));
    this._fishIds = [...this.fishIds, spawn.id];
    this.spawn(i, fit, spot);
    this.behaviour.addFish(i);
    return i;
  }

  /**
   * Takes fish `id` out of the running world. Later fish move down one index; every fish index
   * held anywhere (school and separation neighbours, the feeder a fish follows, feeding claims, a
   * territorial rival, a station group's leader) is renumbered, and references to the removed fish
   * are dropped. Bites it took before leaving stay queued for `takeAteEvents`.
   */
  removeFish(id: string): void {
    const r = this.fishIds.indexOf(id);
    if (r < 0) throw new Error(`no fish "${id}" in the world to remove`);
    this._fishIds = this.fishIds.filter((f) => f !== id);
    this.resize(FishResize.leave(this.count, r));
  }

  private resize(edit: FishResize): void {
    const n = edit.next;
    const k = this.kMax;
    this._count = n;
    this._position = edit.array(this.position, 3);
    this._yaw = edit.array(this.yaw);
    this._pitch = edit.array(this.pitch);
    this._roll = edit.array(this.roll);
    this._speed = edit.array(this.speed);
    this._yawRate = edit.array(this.yawRate);
    this._pitchRate = edit.array(this.pitchRate);
    this._state = edit.array(this.state);
    this._bodyLength = edit.array(this.bodyLength);
    this._radius = edit.array(this.radius);
    this._thickness = edit.array(this.thickness);
    this._speciesIndex = edit.array(this.speciesIndex);
    this._thrust = edit.array(this.thrust);
    this._contactCount = edit.array(this.contactCount);
    this.coasting = edit.array(this.coasting);
    this.gaitTimer = edit.array(this.gaitTimer);
    this.detourSign = edit.array(this.detourSign);
    this.detourTimer = edit.array(this.detourTimer);
    this.cramped = edit.array(this.cramped);
    this.wedged = edit.array(this.wedged);
    this.reverseLeft = edit.array(this.reverseLeft);
    this.scrapeAnchor = edit.array(this.scrapeAnchor, 3);
    this.scrapeTime = edit.array(this.scrapeTime);
    this.scrapeHits = edit.array(this.scrapeHits);
    this.deadEnd = edit.array(this.deadEnd, 3);
    this.deadEndTimer = edit.array(this.deadEndTimer);
    this.stationMemo = edit.array(this.stationMemo, STATION_MEMO);
    // edit.array already moves each fish's memo with it; the bump is for addFish, which may have
    // widened the decor reach every cached ring search was read at.
    this.stationEpoch++;
    this.mass = edit.array(this.mass);
    this.drag = edit.array(this.drag);
    this._maxSpeed = edit.array(this.maxSpeed);
    this._cruiseSpeed = edit.array(this.cruiseSpeed);
    this.wanderTurn = edit.array(this.wanderTurn);
    this.wanderPitch = edit.array(this.wanderPitch);
    this.avoidTangent = edit.array(this.avoidTangent, 2);
    this.avoidOrigin = edit.array(this.avoidOrigin, 2);
    this.avoidMemory = edit.array(this.avoidMemory);
    this.intent = edit.array(this.intent, 3);
    this.targetYaw = edit.array(this.targetYaw);
    this.targetPitch = edit.array(this.targetPitch);
    this.targetSpeed = edit.array(this.targetSpeed);
    this._forward = edit.array(this.forward, 3);
    this.schoolGroup = edit.array(this.schoolGroup);
    this.schoolNbr = edit.array(this.schoolNbr, k, -1);
    this.anyNbr = edit.array(this.anyNbr, k, -1);
    edit.remap(this.schoolNbr);
    edit.remap(this.anyNbr);
    // Rebuilt by every step before anything reads it.
    this._distSq = new Float64Array(n * n);
    // A loner's group is its own index, so loners after the removed fish need theirs renumbered.
    for (let i = 0; i < n; i++) {
      const sp = this.species[this.speciesIndex[i] ?? -1];
      if (sp !== undefined)
        this.schoolGroup[i] = sp.schooling ? (this.speciesIndex[i] ?? 0) : -1 - i;
    }
    this.behaviour.resize(edit);
  }

  /** Grows the decor fields' reach to what a fish of `length` steers by; it never shrinks. */
  private widenDecorReach(length: number): void {
    const reach = decorReach(length);
    this.hardDecor.widen(reach);
    this.softDecor.widen(reach);
  }

  step(): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const p = this.pitch[i] ?? 0;
      const y = this.yaw[i] ?? 0;
      const cp = Math.cos(p);
      this.forward[i * 3] = Math.sin(y) * cp;
      this.forward[i * 3 + 1] = Math.sin(p);
      this.forward[i * 3 + 2] = Math.cos(y) * cp;
    }
    pairwiseDistanceSq(this.position, n, this.distSq);
    this.behaviour.update();
    for (let i = 0; i < n; i++) this.steer(i);
    for (let i = 0; i < n; i++) this.integrate(i);
    this.tick++;
  }

  private steer(i: number): void {
    const n = this.count;
    const sp = this.speciesOf(i);
    const plan = this.behaviour.plans[i];
    if (plan === undefined) throw new RangeError(`no plan for fish ${i}`);
    const rng = this.rng;
    const dt = STEP_DT;
    const o = i * 3;
    const px = this.position[o] ?? 0;
    const py = this.position[o + 1] ?? 0;
    const pz = this.position[o + 2] ?? 0;
    const fx = this.forward[o] ?? 0;
    const fy = this.forward[o + 1] ?? 0;
    const fz = this.forward[o + 2] ?? 1;
    const v = this.speed[i] ?? 0;
    const length = this.bodyLength[i] ?? 0;
    const comfort = Math.max(plan.comfort, BEHAVIOUR.minComfort);
    const radius = Math.max(this.thickness[i] ?? 0, (this.radius[i] ?? 0) * comfort);
    const cruiseBase = this.cruiseSpeed[i] ?? 0;
    const cruise = cruiseBase * plan.cruiseScale;
    const vmax = this.maxSpeed[i] ?? 0;
    const yaw = this.yaw[i] ?? 0;

    // Persistent turning walker: turn rate and pitch drift as Ornstein–Uhlenbeck processes.
    const wt = this.wanderTurn[i] ?? 0;
    const wtTau = STEERING.wanderTurnTauS;
    const nextWt =
      wt -
      (wt * dt) / wtTau +
      STEERING.wanderTurnSdRadPerS * Math.sqrt((2 * dt) / wtTau) * rng.gaussian();
    this.wanderTurn[i] = nextWt;
    const wp = this.wanderPitch[i] ?? 0;
    const wpTau = STEERING.wanderPitchTauS;
    const nextWp =
      wp -
      (wp * dt) / wpTau +
      STEERING.wanderPitchSdRad * Math.sqrt((2 * dt) / wpTau) * rng.gaussian();
    this.wanderPitch[i] = nextWp;

    const wy = yaw + nextWt * STEERING.wanderLookaheadS;
    const cwp = Math.cos(nextWp);
    const wander = cruise * plan.wander;
    let dx = Math.sin(wy) * cwp * wander;
    let dy = Math.sin(nextWp) * wander;
    let dz = Math.cos(wy) * cwp * wander;

    const k = this.kMax;
    let state: FishState = FishState.Cruise;
    if (sp.schooling && (plan.align > 0 || plan.cohesion > 0)) {
      const range = sp.perceptionRange;
      const count = selectNearest(
        this.distSq,
        n,
        i,
        sp.neighbours,
        this.schoolGroup,
        range * range,
        this.schoolNbr,
        i * k,
        this.scratchDist,
      );
      if (count > 0) {
        state = FishState.School;
        let ax = 0;
        let ay = 0;
        let az = 0;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let m = 0; m < count; m++) {
          const j = this.schoolNbr[i * k + m] ?? 0;
          const vj = this.speed[j] ?? 0;
          ax += (this.forward[j * 3] ?? 0) * vj;
          ay += (this.forward[j * 3 + 1] ?? 0) * vj;
          az += (this.forward[j * 3 + 2] ?? 0) * vj;
          cx += this.position[j * 3] ?? 0;
          cy += this.position[j * 3 + 1] ?? 0;
          cz += this.position[j * 3 + 2] ?? 0;
        }
        const inv = 1 / count;
        const wa = STEERING.alignmentWeight * plan.align;
        dx += wa * (ax * inv - fx * v);
        dy += wa * (ay * inv - fy * v);
        dz += wa * (az * inv - fz * v);
        const wc = STEERING.cohesionRatePerS * plan.cohesion;
        dx += wc * (cx * inv - px);
        dy += wc * (cy * inv - py);
        dz += wc * (cz * inv - pz);
      }
    }

    const anyCount = selectNearest(
      this.distSq,
      n,
      i,
      STEERING.anyNeighbours,
      null,
      Infinity,
      this.anyNbr,
      i * k,
      this.scratchDist,
    );
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let m = 0; m < anyCount; m++) {
      const j = this.anyNbr[i * k + m] ?? 0;
      let zone = 0.5 * (length + (this.bodyLength[j] ?? 0)) * STEERING.separationZoneBodyLengths;
      if (plan.arrival > 0 && this.coGrazing(plan, j)) zone *= STEERING.coGrazeSeparation;
      const d2 = this.distSq[i * n + j] ?? Infinity;
      if (d2 >= zone * zone) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-9) continue;
      const s = (zone - d) / (zone * d);
      sx += (px - (this.position[j * 3] ?? 0)) * s;
      sy += (py - (this.position[j * 3 + 1] ?? 0)) * s;
      sz += (pz - (this.position[j * 3 + 2] ?? 0)) * s;
    }
    const ws = STEERING.separationWeight * cruiseBase * plan.separation;
    dx += sx * ws;
    dy += sy * ws;
    dz += sz * ws;

    const ground = this.basin.ground(px, pz);
    const top = this.basin.maxY;
    const clearance = radius + length * STEERING.proximityBodyLengths * comfort;
    const bandLo = plan.floor ? Math.max(plan.bandLo, ground + clearance) : plan.bandLo;
    const bandHi = plan.surface ? Math.min(plan.bandHi, top - clearance) : plan.bandHi;
    const bandTarget = clamp(py, Math.min(bandLo, bandHi), Math.max(bandLo, bandHi));
    const vyLimit = cruiseBase * STEERING.depthMaxSpeedFraction;
    dy += clamp((bandTarget - py) / STEERING.depthTauS, -vyLimit, vyLimit);

    const deadEndLeft = Math.max(0, (this.deadEndTimer[i] ?? 0) - dt);
    this.deadEndTimer[i] = deadEndLeft;
    const nh = this.normal;
    const np = this.probeNormal;
    const sdfMask = (plan.floor ? 1 : 0) + (plan.surface ? 2 : 0);
    const sdf = this.steerSdf[sdfMask] ?? this.sceneSdf;
    const nose = (BEHAVIOUR.bodySampleOffsets[0] ?? 0) * length;
    let seekX = plan.seekX;
    const seekY = plan.seekY;
    let seekZ = plan.seekZ;
    if (plan.seekWeight > 0 && plan.arrival > 0) {
      // Food against glass or rock is approached from open water: the fish makes for a stand-off
      // point `arrival` out from the food, where it fits facing the food with its mouth in reach,
      // not for the food itself, which would leave its snout pressed to the pane as it turns.
      // Pushing off each surface in turn finds the open side, diagonal out of a corner. Only the
      // horizontal push is used, so food on the sand stays directly below a forager's mouth.
      for (let pass = 0; pass < STEERING.standOffPasses; pass++) {
        const room = sdf.sample(seekX, seekY, seekZ, np);
        const hx = np[0] ?? 0;
        const hz = np[2] ?? 0;
        const h = Math.hypot(hx, hz);
        if (room >= plan.arrival || h < STEERING.slideMinHorizontal) break;
        const push = (plan.arrival - room) / h;
        seekX += hx * push;
        seekZ += hz * push;
      }
      const ox = seekX - plan.seekX;
      const oz = seekZ - plan.seekZ;
      const out = Math.hypot(ox, oz);
      if (out > 1e-9) {
        const ux = ox / out;
        const uz = oz / out;
        seekX = plan.seekX + ux * plan.arrival;
        seekZ = plan.seekZ + uz * plan.arrival;
        // Part way round to the fish's own bearing, so fish sharing a clip hold different spots,
        // as far round as the body still fits there facing the food.
        const base = Math.atan2(ux, uz);
        const room = STEERING.turnRoomMarginBodyLengths * length;
        const bx = px - plan.seekX;
        const bz = pz - plan.seekZ;
        let off = 0;
        let placed = false;
        if (Math.hypot(bx, bz) > 1e-9) {
          off = wrapAngle(Math.atan2(bx, bz) - base);
          for (const share of STEERING.standOffBearingShares) {
            const h = base + off * share;
            if (this.stationRoom(i, sdf, plan, seekY, h) >= room) {
              seekX = plan.seekX + Math.sin(h) * plan.arrival;
              seekZ = plan.seekZ + Math.cos(h) * plan.arrival;
              placed = true;
              break;
            }
          }
        }
        if (!placed) {
          const h = this.ringStation(i, sdf, sdfMask, plan, seekY, base, off >= 0 ? 1 : -1, room);
          if (!Number.isNaN(h)) {
            seekX = plan.seekX + Math.sin(h) * plan.arrival;
            seekZ = plan.seekZ + Math.cos(h) * plan.arrival;
          }
        }
      }
    }
    const standOff = seekX !== plan.seekX || seekZ !== plan.seekZ;
    const toStation = Math.hypot(seekX - px, seekZ - pz);
    const toFood = Math.hypot(plan.seekX - px, plan.seekZ - pz);
    let faceYaw = NaN;
    if (standOff && toStation < plan.arrival) {
      // Facing the food, the fish closes on it along its own bearing, not the station's. Beside a
      // station moved round a rock tip that line can put the rock between snout and food, and the
      // fish bumps it short of a bite and backs out (#306); it makes for the station until its own
      // bearing is clear at stand-off range.
      const heading = Math.atan2(plan.seekX - px, plan.seekZ - pz);
      const bearing = Math.atan2(px - plan.seekX, pz - plan.seekZ);
      const ahead = this.poseRoom(
        i,
        sdf,
        plan.seekX + Math.sin(bearing) * plan.arrival,
        seekY,
        plan.seekZ + Math.cos(bearing) * plan.arrival,
        heading,
      );
      if (ahead >= 0) faceYaw = heading;
    }
    // A station over the top of a rock is out of reach in a straight line: at its pitch limit the
    // fish runs its snout into the rock's flank well before it has the height (#332). It rises
    // where it is first and crosses once the way over the top is clear. The way it would fly is
    // what counts, and that climbs no steeper than its pitch limit.
    const reachY = Math.min(seekY, py + Math.tan(sp.maxPitch) * toStation);
    const climbFirst =
      standOff &&
      seekY - py > radius &&
      !(
        deadEndLeft > 0 &&
        Math.hypot(
          (this.deadEnd[i * 3] ?? 0) - px,
          (this.deadEnd[i * 3 + 1] ?? 0) - py,
          (this.deadEnd[i * 3 + 2] ?? 0) - pz,
        ) < length
      ) &&
      !this.pathClear(sdf, px, py, pz, seekX, reachY, seekZ, radius) &&
      this.riseClear(sdf, px, py, pz, seekY, radius) &&
      this.pathClear(sdf, px, seekY, pz, seekX, seekY, seekZ, radius);
    if (climbFirst) this.climbs++;
    if (plan.seekWeight > 0) {
      let qx = climbFirst ? 0 : (seekX - px) / plan.seekTau;
      let qy = (seekY - py) / plan.seekTau;
      let qz = climbFirst ? 0 : (seekZ - pz) / plan.seekTau;
      const ql = Math.hypot(qx, qy, qz);
      if (ql > plan.seekSpeed) {
        const s = plan.seekSpeed / ql;
        qx *= s;
        qy *= s;
        qz *= s;
      }
      dx += qx * plan.seekWeight;
      dy += qy * plan.seekWeight;
      dz += qz * plan.seekWeight;
    }

    // Whatever took a fish into a dead end (a wander, its depth band, a goal beyond the rock)
    // would take it straight back in once it has backed out, so for a while it steers round the
    // spot instead, by the open side when its goal lies straight beyond it (a cave past the
    // rock), and while it still faces the spot it turns without keeping way on along the wall.
    // Not when it is going for food: pursuit gives up before the memory fades (#259).
    let keepWay = true;
    if (deadEndLeft > 0 && (this.behaviour.feeding.target[i] ?? -1) < 0) {
      const ex = (this.deadEnd[i * 3] ?? 0) - px;
      const ez = (this.deadEnd[i * 3 + 2] ?? 0) - pz;
      const reach = Math.hypot(ex, ez);
      const zone = STEERING.deadEndRadiusBodyLengths * length;
      if (reach < zone && reach > 1e-9) {
        const ux = ex / reach;
        const uz = ez / reach;
        const toward = Math.max(0, dx * ux + dz * uz);
        let across = dz * ux - dx * uz;
        if (Math.abs(across) < toward) {
          sdf.sample(px, py, pz, np);
          across = (np[2] ?? 0) * ux - (np[0] ?? 0) * uz;
        }
        const side = across >= 0 ? 1 : -1;
        dx -= (ux + uz * side) * toward;
        dz -= (uz - ux * side) * toward;
        keepWay = fx * ux + fz * uz <= 0;
      }
    }

    // Plants are soft: they push a fish aside and slow it, but never block it.
    let plantSlow = 1;
    if (this.softDecor.size > 0) {
      const dPlant = this.softDecor.sample(px, py, pz, nh);
      const r0 = this.radius[i] ?? 0;
      if (dPlant < r0) {
        this.plantContacts++;
        const depth = clamp((r0 - dPlant) / r0, 0, 1);
        const push = cruiseBase * STEERING.plantPushFraction * depth;
        dx += (nh[0] ?? 0) * push;
        dy += (nh[1] ?? 0) * push;
        dz += (nh[2] ?? 0) * push;
        plantSlow = 1 - STEERING.plantSlowdown * depth;
      }
    }

    // Containment (Reynolds 1999): react to the surface ahead along the path, plus a short-range
    // safety term for surfaces the probe misses (beside or behind while turning).
    const dHere = sdf.sample(px, py, pz, nh);
    const verticalHere = Math.abs(nh[1] ?? 0);
    const noseRoom =
      sdf.sample(px + fx * nose, py + fy * nose, pz + fz * nose, np) - (this.thickness[i] ?? 0);
    this.cramped[i] = noseRoom < length * STEERING.crampedClearanceBodyLengths ? 1 : 0;
    let probe = 0.5 * length + v * STEERING.avoidLookaheadS + v / this.turnRateLimit(i, sp, plan);
    // A fish closing on its stand-off point stops there, so glass or rock beyond it is not on
    // its path; looking further turns it away from a nori clip on the pane or food in a corner
    // every time it comes near.
    if (standOff) {
      probe = Math.min(probe, Math.max(nose, Math.hypot(seekX - px, seekY - py, seekZ - pz)));
    }
    const dProbe = sdf.sample(px + fx * probe, py + fy * probe, pz + fz * probe, np);
    const probeMargin = radius + length * STEERING.avoidMarginBodyLengths * comfort;
    // Only a path that closes on a surface is a threat; a probe that is merely near a wall the
    // fish runs parallel to (common for large fish in a narrow tank) is left to the proximity term.
    const closing = clamp(((dHere - dProbe) / probe) * STEERING.avoidClosingGain, 0, 1);
    const aProbe = clamp((probeMargin - dProbe) / (probeMargin - radius), 0, 1) * closing;
    const aHere = clamp((clearance - dHere) / (clearance - radius), 0, 1);
    const a = Math.max(aHere, aProbe);
    let aWall = 0;
    if (a > 0) {
      // Prioritised blending (Reynolds 1987): an imminent wall outranks the school.
      const keep = 1 - a * STEERING.avoidPriority;
      dx *= keep;
      dy *= keep;
      dz *= keep;
      const h = length * STEERING.avoidGradientBodyLengths;
      const scratch = this.previous;
      if (aHere > 0) {
        smoothGradient(sdf, px, py, pz, h, nh, scratch);
        aWall = aHere * Math.hypot(nh[0] ?? 0, nh[2] ?? 0);
      }
      if (aProbe > 0) {
        smoothGradient(sdf, px + fx * probe, py + fy * probe, pz + fz * probe, h, np, scratch);
      }
      let nx = (nh[0] ?? 0) * aHere + (np[0] ?? 0) * aProbe;
      let ny = (nh[1] ?? 0) * aHere + (np[1] ?? 0) * aProbe;
      let nz = (nh[2] ?? 0) * aHere + (np[2] ?? 0) * aProbe;
      // With the floor or surface masked out, an overhang pushes a fish into the very surface it
      // is hugging (a cory nosing under driftwood); only a sideways escape is possible there.
      if (
        (!plan.floor && ny < 0 && py - ground < clearance) ||
        (!plan.surface && ny > 0 && top - py < clearance)
      ) {
        ny = 0;
      }
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-9) {
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const vn = dx * nx + dy * ny + dz * nz;
        if (vn < 0) {
          const cancel = vn * Math.min(1, 2 * a);
          dx -= nx * cancel;
          dy -= ny * cancel;
          dz -= nz * cancel;
        }
        dx += nx * cruiseBase * a;
        dy += ny * cruiseBase * a;
        dz += nz * cruiseBase * a;
        // Near a pane the cancelled vector can shrink to almost nothing, and atan2 of the residue
        // makes the heading jitter. Guarantee a committed slide along the pane instead. Over a
        // floor or rock top (a mostly vertical normal) the answer is to rise, not to slide, and a
        // tangent taken from the small horizontal part of the normal would spin the fish.
        const hl = Math.hypot(nx, nz);
        if (hl > STEERING.slideMinHorizontal) {
          const ux = nx / hl;
          const uz = nz / hl;
          let tx = -uz;
          let tz = ux;
          let px0 = this.avoidTangent[i * 2] ?? 0;
          let pz0 = this.avoidTangent[i * 2 + 1] ?? 0;
          // Continuity carries a fish round a tank corner (90°), but a slide that has swung
          // further has rounded a convex rock and would orbit it; that ends the engagement.
          const swung =
            px0 * (this.avoidOrigin[i * 2] ?? 0) + pz0 * (this.avoidOrigin[i * 2 + 1] ?? 0);
          if (swung < STEERING.avoidMaxSwingCos) {
            px0 = 0;
            pz0 = 0;
          }
          // Within one engagement the slide direction stays continuous as the wall normal turns
          // (pane to corner to next pane); only a fresh engagement picks a side from the heading.
          // Closing on food, a clear wish along the wall (further along the pane, into the
          // corner) overrides both: sliding against it parks a fish beside food it cannot turn
          // back to. Cruising keeps continuity, or a wandering heading flips the slide.
          const along = dx * tx + dz * tz;
          const wished = standOff && Math.abs(along) > STEERING.slideWishFraction * cruiseBase;
          if (wished && Math.sign(along) * (tx * px0 + tz * pz0) < 0) {
            px0 = 0;
            pz0 = 0;
          }
          const reference = wished
            ? along
            : px0 !== 0 || pz0 !== 0
              ? tx * px0 + tz * pz0
              : fx * tx + fz * tz;
          let side = Math.abs(reference) > 1e-6 ? Math.sign(reference) : nextWt >= 0 ? 1 : -1;
          // A slide that runs into a narrowing slot (glass on one flank, rock closing in on the
          // other) only wedges the fish deeper; once its snout is cramped it turns back to where
          // the gap opens. A fish working its way somewhere compares the room along the surface
          // beside its body, since the blended slide can angle into a flat face and read it as a
          // narrowing (#257). One at food keeps the blended slide: in a tank corner it reads the
          // corner closing in and turns the fish out along the pane before it grinds round there.
          if (this.cramped[i] === 1) {
            let wx = tx * side;
            let wz = tz * side;
            const wl = Math.hypot(nh[0] ?? 0, nh[2] ?? 0);
            if ((this.behaviour.feeding.target[i] ?? -1) < 0 && wl > STEERING.slideMinHorizontal) {
              const sx = -(nh[2] ?? 0) / wl;
              const sz = (nh[0] ?? 0) / wl;
              const sense = sx * wx + sz * wz < 0 ? -1 : 1;
              wx = sx * sense;
              wz = sz * sense;
            }
            const ahead = sdf.sample(px + wx * nose, py, pz + wz * nose, scratch);
            const behind = sdf.sample(px - wx * nose, py, pz - wz * nose, scratch);
            if (ahead < STEERING.narrowingFlipRatio * behind) {
              side = -side;
              px0 = 0;
              pz0 = 0;
            }
          }
          // The goal would drag a fish that just backed out of a slot along the rock straight
          // back into it, food included (#287). Only a remembered slot behind the face being
          // slid along is no threat: shunning it would turn a fish working along the rock's
          // front toward food away from that food (#279). "Behind" is measured along the slide
          // normal from the nearest surface, so where the glass is nearer than the rock face
          // the slot counts as behind the face early, by as much as the glass is nearer. A slot
          // well out on the open side of the face is not the one being slid along, and a fish
          // that has risen clear above the slot can no longer be dragged into it (#332).
          let shunning = false;
          if (deadEndLeft > 0) {
            const ex = (this.deadEnd[i * 3] ?? 0) - px;
            const ez = (this.deadEnd[i * 3 + 2] ?? 0) - pz;
            const offFace = ex * ux + ez * uz + dHere;
            const band = STEERING.deadEndBehindFaceBodyLengths * length;
            const overhead =
              Math.abs(py - (this.deadEnd[i * 3 + 1] ?? 0)) >
              STEERING.deadEndHeightBodyLengths * length;
            if (!overhead && !(wished && offFace < -band) && offFace <= band) {
              const reach = Math.hypot(ex, ez);
              const toward = (tx * ex + tz * ez) * side;
              if (
                reach < STEERING.deadEndRadiusBodyLengths * length &&
                Math.abs(toward) > STEERING.deadEndBearingCos * reach
              ) {
                shunning = true;
                if (toward > 0) {
                  side = -side;
                  px0 = 0;
                  pz0 = 0;
                }
              }
            }
          }
          tx *= side;
          tz *= side;
          if (shunning) {
            const back = dx * tx + dz * tz;
            if (back < 0) {
              dx -= tx * back;
              dz -= tz * back;
            }
          }
          if (px0 === 0 && pz0 === 0) {
            this.avoidOrigin[i * 2] = tx;
            this.avoidOrigin[i * 2 + 1] = tz;
          }
          this.avoidTangent[i * 2] = tx;
          this.avoidTangent[i * 2 + 1] = tz;
          const shortfall = cruiseBase * a * hl - (dx * tx + dz * tz);
          if (shortfall > 0) {
            dx += tx * shortfall;
            dz += tz * shortfall;
          }
        }
      }
      if (a > 0.25) state = FishState.Avoid;
    }
    // The slide direction outlives a brief release so the fish keeps rounding a corner the same
    // way, but it is forgotten soon after, so a side chosen at one pane never steers the fish at
    // the next encounter.
    if (a >= STEERING.avoidReleaseThreshold) {
      this.avoidMemory[i] = STEERING.avoidMemoryS;
    } else {
      const left = (this.avoidMemory[i] ?? 0) - dt;
      this.avoidMemory[i] = left;
      if (left <= 0) {
        this.avoidTangent[i * 2] = 0;
        this.avoidTangent[i * 2 + 1] = 0;
      }
    }
    this.state[i] = plan.state === FishState.Cruise ? state : plan.state;

    // Neighbour sets change discretely; a short reaction lag keeps the heading from twitching.
    // An escape is a reflex and skips it.
    const lag =
      plan.state === FishState.Startle ? 1 : 1 - Math.exp(-STEP_DT / STEERING.intentSmoothingS);
    dx = (this.intent[o] ?? 0) + (dx - (this.intent[o] ?? 0)) * lag;
    dy = (this.intent[o + 1] ?? 0) + (dy - (this.intent[o + 1] ?? 0)) * lag;
    dz = (this.intent[o + 2] ?? 0) + (dz - (this.intent[o + 2] ?? 0)) * lag;
    this.intent[o] = dx;
    this.intent[o + 1] = dy;
    this.intent[o + 2] = dz;

    const mag = Math.hypot(dx, dy, dz);
    // Fish do not stop and pirouette to dodge glass; they keep way on and turn along it.
    const minSpeed = Math.max(
      a > 0 && (keepWay || this.cramped[i] !== 1)
        ? cruiseBase * STEERING.avoidMinSpeedFraction * a
        : 0,
      plan.speedFloor,
    );
    const maxSpeed = Math.min(vmax, plan.speedCap) * plantSlow;
    // A near-zero desired velocity has no meaningful direction; keep the current goal heading.
    if (mag >= cruiseBase * STEERING.headingHoldFraction) {
      const cosAhead = (dx * fx + dy * fy + dz * fz) / mag;
      // A mostly vertical wish (pushed down off the surface) has a horizontal residue whose
      // direction is noise; steering yaw by it spins the fish in place.
      const horizontal = Math.hypot(dx, dz);
      if (horizontal >= cruiseBase * STEERING.headingHoldFraction) {
        // A weak wish is a weak reason to turn: a fish idling over rock, buffeted by small
        // competing terms, should drift round slowly rather than spin to chase each one.
        const urgency = Math.min(1, horizontal / (cruiseBase * STEERING.fullTurnSpeedFraction));
        this.targetYaw[i] = yaw + wrapAngle(Math.atan2(dx, dz) - yaw) * urgency;
      }
      this.targetPitch[i] = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -sp.maxPitch, sp.maxPitch);
      this.targetSpeed[i] = clamp(
        Math.max(mag * (0.5 + 0.5 * cosAhead), minSpeed),
        0,
        Math.max(0, maxSpeed),
      );
    } else {
      this.targetSpeed[i] = clamp(Math.max(mag, minSpeed), 0, Math.max(0, maxSpeed));
    }
    // Only the horizontal share of avoidance blocks the pivot: a rock top under the station is
    // avoidance in pitch, turning on the spot over it brings the body no nearer, and turnRoom
    // already checks the horizontal sweep. Gating on it left a tang unable to face a clip (#232).
    // Only the body's own proximity counts, too: the nose probe sweeps onto the food's own glass
    // as the fish comes round to it and would block the very turn it is part way through (#258).
    if (
      !Number.isNaN(faceYaw) &&
      aWall < STEERING.avoidReleaseThreshold &&
      (Math.abs(wrapAngle(faceYaw - yaw)) < STEERING.standOffFacingRad ||
        this.turnRoom(i, sdf, yaw, faceYaw) >= STEERING.turnRoomMarginBodyLengths * length)
    ) {
      // On station a browser turns on its pectorals to face the food it is working and only
      // moves along that heading. Steering by the residual seek vector instead points it at
      // wherever the station lies, and the turn back to the food creeps it in onto the glass.
      const along = dx * Math.sin(faceYaw) + dz * Math.cos(faceYaw);
      this.targetYaw[i] = faceYaw;
      this.targetSpeed[i] = clamp(Math.max(along, minSpeed), 0, Math.max(0, maxSpeed));
    }
    if (standOff) {
      // Arrival (Reynolds 1999): slow to a stop at the station, and never press on past it
      // toward the food, where the body has no room left to turn.
      const inside = toFood < plan.arrival && fx * (plan.seekX - px) + fz * (plan.seekZ - pz) > 0;
      const cap = inside ? 0 : toStation / STEERING.standOffBrakeS;
      this.targetSpeed[i] = Math.min(this.targetSpeed[i] ?? 0, cap);
    }
    if (!Number.isNaN(plan.yaw)) this.targetYaw[i] = plan.yaw;
    if (!Number.isNaN(plan.pitch)) {
      this.targetPitch[i] = clamp(plan.pitch, -sp.maxPitch, sp.maxPitch);
    }
    // Steering reasons about the body centre, but pitching close to a surface above or below
    // swings the snout or tail into it (a tang lifting off the rock it grazed, a cory nosing the
    // sand with the floor masked), so the tilt is capped to what the clearance allows.
    this.capTilt(i, dHere, verticalHere);
    if (!plan.floor) this.capTilt(i, py - ground, 1);
    if (!plan.surface) this.capTilt(i, top - py, 1);
  }

  /**
   * A cruising fish turns on an arc of a few tenths of its length, not on the spot; only a
   * hovering fish pivots, and slowly. Foraging, grazing and station-keeping are slow, deliberate
   * manoeuvres and keep the full rate, as does a fish whose snout is about to touch something.
   * A fish chasing food swims and turns like a cruising one.
   */
  private turnRateLimit(i: number, sp: SimSpecies, plan: Plan): number {
    const arcLimited =
      plan.state === FishState.Feed || (plan.state === FishState.Cruise && plan.seekWeight === 0);
    if (!arcLimited || plan.pivot || this.cramped[i] === 1) return sp.maxTurnRate;
    const radius = STEERING.minTurnRadiusBodyLengths * (this.bodyLength[i] ?? 1);
    const arc = (this.speed[i] ?? 0) / radius;
    return Math.min(sp.maxTurnRate, Math.max(arc, STEERING.pivotTurnRateRadPerS));
  }

  /** Whether fish `j` is grazing the same item as `plan`, so the two may feed side by side. */
  private coGrazing(plan: Plan, j: number): boolean {
    const other = this.behaviour.plans[j];
    return (
      other !== undefined &&
      other.arrival > 0 &&
      other.seekWeight > 0 &&
      other.seekX === plan.seekX &&
      other.seekZ === plan.seekZ
    );
  }

  /**
   * Straight out from the surface, rock beside the food (a wedge tip) can stand between the
   * station and the food; a fish parked there cannot turn its mouth to it (#258). Works round the
   * food, toward the fish's side first, to the nearest bearing where it fits facing it; NaN when
   * the straight-out station fits or nothing does. The answer depends only on the food, the hard
   * decor and the side, so it is kept until one of them changes.
   */
  private ringStation(
    i: number,
    sdf: Sdf,
    sdfMask: number,
    plan: Plan,
    y: number,
    base: number,
    toward: number,
    room: number,
  ): number {
    const m = this.stationMemo;
    const o = i * STATION_MEMO;
    if (
      m[o] === this.stationEpoch &&
      m[o + 1] === sdfMask &&
      m[o + 2] === plan.seekX &&
      m[o + 3] === y &&
      m[o + 4] === plan.seekZ &&
      m[o + 5] === plan.arrival &&
      m[o + 6] === toward
    ) {
      return m[o + 7] ?? NaN;
    }
    let found = NaN;
    if (this.stationRoom(i, sdf, plan, y, base) < room) {
      const step = Math.PI / STEERING.standOffRingSteps;
      for (let k = 2; k <= 2 * STEERING.standOffRingSteps; k++) {
        const h = base + (k % 2 === 0 ? toward : -toward) * (k >> 1) * step;
        if (this.stationRoom(i, sdf, plan, y, h) >= room) {
          found = h;
          break;
        }
      }
    }
    m[o] = this.stationEpoch;
    m[o + 1] = sdfMask;
    m[o + 2] = plan.seekX;
    m[o + 3] = y;
    m[o + 4] = plan.seekZ;
    m[o + 5] = plan.arrival;
    m[o + 6] = toward;
    m[o + 7] = found;
    return found;
  }

  /** Room for fish `i` on the stand-off ring at bearing `bearing` from the food, facing it. */
  private stationRoom(i: number, sdf: Sdf, plan: Plan, y: number, bearing: number): number {
    this.stationChecks++;
    return this.poseRoom(
      i,
      sdf,
      plan.seekX + Math.sin(bearing) * plan.arrival,
      y,
      plan.seekZ + Math.cos(bearing) * plan.arrival,
      bearing + Math.PI,
    );
  }

  /**
   * Whether a body of radius `r` can rise straight up from (x, y, z) to `toY`. A fish grazing low is
   * within `r` of the sand or rock top it rises away from, so the trace allows it the clearance it
   * has at the start: only a surface it would close on, a shelf overhead, blocks it.
   */
  private riseClear(sdf: Sdf, x: number, y: number, z: number, toY: number, r: number): boolean {
    const start = sdf.sample(x, y, z, this.previous);
    const room = Math.min(r, start);
    return room > 0 && this.pathClear(sdf, x, y, z, x, toY, z, room, start);
  }

  /**
   * Whether a body of radius `r` fits along the segment, by sphere tracing `sdf`. Approximate: each
   * step overshoots the safe distance by `pathTraceMinStep` radii, so between two samples the
   * centre can come to within about three quarters of `r` of a surface.
   */
  private pathClear(
    sdf: Sdf,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    r: number,
    start = sdf.sample(x0, y0, z0, this.previous),
  ): boolean {
    const length = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (length < 1e-9) return start >= r;
    const ux = (x1 - x0) / length;
    const uy = (y1 - y0) / length;
    const uz = (z1 - z0) / length;
    let t = 0;
    for (let k = 0; k < STEERING.pathTraceSteps; k++) {
      const d = k === 0 ? start : sdf.sample(x0 + ux * t, y0 + uy * t, z0 + uz * t, this.previous);
      if (d < r) return false;
      if (t >= length) return true;
      t = Math.min(length, t + d - r + STEERING.pathTraceMinStep * r);
    }
    return false;
  }

  /** Least clearance of the level snout and tail of fish `i` held at (x, y, z) facing `heading`. */
  private poseRoom(i: number, sdf: Sdf, x: number, y: number, z: number, heading: number): number {
    const reach = (BEHAVIOUR.bodySampleOffsets[0] ?? 0) * (this.bodyLength[i] ?? 0);
    const ex = Math.sin(heading) * reach;
    const ez = Math.cos(heading) * reach;
    const snout = sdf.sample(x + ex, y, z + ez, this.previous);
    const tail = sdf.sample(x - ex, y, z - ez, this.previous);
    return Math.min(snout, tail) - (this.thickness[i] ?? 0);
  }

  /**
   * Whether fish `i` could turn round, level, as near (x, y, z) as the glass and hard decor let
   * it come. Food at the blind end of a slot narrower than that is out of its reach.
   */
  canTurnAt(i: number, x: number, y: number, z: number): boolean {
    const length = this.bodyLength[i] ?? 0;
    const sdf = this.steerSdf[0] ?? this.sceneSdf;
    const n = this.turnNormal;
    const need =
      (BEHAVIOUR.bodySampleOffsets[0] ?? 0) * length +
      (this.thickness[i] ?? 0) +
      STEERING.turnRoomMarginBodyLengths * length;
    if (sdf.sample(x, y, z, n) >= need) return true;
    const { minX, maxX, minZ, maxZ } = this.basin;
    // Held off the glass on every pass: near a rock top the nearest surface is the rock, and its
    // normal can point straight back into the corner.
    let sx = clamp(x, minX + need, maxX - need);
    let sz = clamp(z, minZ + need, maxZ - need);
    for (let pass = 0; pass < STEERING.standOffPasses; pass++) {
      const room = sdf.sample(sx, y, sz, n);
      const h = Math.hypot(n[0] ?? 0, n[2] ?? 0);
      if (room >= need || h < STEERING.slideMinHorizontal) break;
      const push = (need - room) / h;
      sx = clamp(sx + (n[0] ?? 0) * push, minX + need, maxX - need);
      sz = clamp(sz + (n[2] ?? 0) * push, minZ + need, maxZ - need);
    }
    for (let k = 0; k < STEERING.turnRingHeadings; k++) {
      const heading = (Math.PI * k) / STEERING.turnRingHeadings;
      if (this.poseRoom(i, sdf, sx, y, sz, heading) < 0) return false;
    }
    return true;
  }

  /** Least clearance of the level snout and tail as the fish turns in place from `from` to `to`. */
  private turnRoom(i: number, sdf: Sdf, from: number, to: number): number {
    const o = i * 3;
    const sweep = wrapAngle(to - from);
    let worst = Infinity;
    for (let k = 1; k <= STEERING.turnRoomSamples; k++) {
      const h = from + (sweep * k) / STEERING.turnRoomSamples;
      const room = this.poseRoom(
        i,
        sdf,
        this.position[o] ?? 0,
        this.position[o + 1] ?? 0,
        this.position[o + 2] ?? 0,
        h,
      );
      worst = Math.min(worst, room);
    }
    return worst;
  }

  private capTilt(i: number, clearance: number, verticality: number): void {
    const half = (BEHAVIOUR.bodySampleOffsets[0] ?? 0) * (this.bodyLength[i] ?? 0) * verticality;
    const room = clearance - (this.thickness[i] ?? 0) * STEERING.tiltClearanceThickness;
    if (room >= half) return;
    const tilt = room > 0 ? Math.asin(room / half) : 0;
    this.targetPitch[i] = clamp(this.targetPitch[i] ?? 0, -tilt, tilt);
  }

  private integrate(i: number): void {
    const dt = STEP_DT;
    const sp = this.speciesOf(i);
    const plan = this.behaviour.plans[i];
    if (plan === undefined) throw new RangeError(`no plan for fish ${i}`);
    const reflex = !Number.isNaN(plan.turnRate);
    const wmax = reflex ? plan.turnRate : sp.maxTurnRate;
    const burstAndCoast = sp.gait === 'burst-and-coast' && !plan.continuous;
    const coasting = burstAndCoast && this.coasting[i] === 1;
    const gain = STEERING.turnGainPerS * (coasting ? BEHAVIOUR.coastTurnGain : 1);
    const smooth = Math.min(1, dt / STEERING.turnSmoothingS);

    const yaw = this.yaw[i] ?? 0;
    const pitch = this.pitch[i] ?? 0;
    if (!reflex && (this.reverseLeft[i] ?? 0) > 0) {
      this.behaviour.feeding.backedOut(i);
      this.reverse(i, sp, plan, yaw, pitch);
      return;
    }
    let yawError = wrapAngle((this.targetYaw[i] ?? 0) - yaw);
    const detour = (this.detourTimer[i] ?? 0) - dt;
    this.detourTimer[i] = Math.max(0, detour);
    const detourSign = this.detourSign[i] ?? 0;
    // The short way round was blocked (a body wedged diagonally in a gap): turn the long way.
    if (detour > 0 && yawError * detourSign < 0) yawError += 2 * Math.PI * detourSign;
    let yawRate: number;
    let pitchRate: number;
    if (reflex) {
      // The C-start bend is a dead-beat reflex turn, not a smoothed steering correction.
      yawRate = clamp(yawError / dt, -wmax, wmax);
      pitchRate = clamp(((this.targetPitch[i] ?? 0) - pitch) / dt, -wmax, wmax);
    } else {
      const wTurn = this.turnRateLimit(i, sp, plan);
      const yawCmd = clamp(yawError * gain, -wTurn, wTurn);
      yawRate = (this.yawRate[i] ?? 0) + (yawCmd - (this.yawRate[i] ?? 0)) * smooth;
      const pitchCmd = clamp(((this.targetPitch[i] ?? 0) - pitch) * gain, -wmax, wmax);
      pitchRate = (this.pitchRate[i] ?? 0) + (pitchCmd - (this.pitchRate[i] ?? 0)) * smooth;
    }
    this.yawRate[i] = yawRate;
    this.yaw[i] = wrapAngle(yaw + yawRate * dt);
    this.pitchRate[i] = pitchRate;
    this.pitch[i] = clamp(pitch + pitchRate * dt, -sp.maxPitch, sp.maxPitch);

    const v = this.speed[i] ?? 0;
    const rollTarget = Number.isNaN(plan.roll)
      ? -STEERING.maxBankRad * Math.tanh((v * yawRate) / STEERING.bankReferenceAccel)
      : plan.roll;
    const roll = this.roll[i] ?? 0;
    this.roll[i] = wrapAngle(
      roll + wrapAngle(rollTarget - roll) * Math.min(1, dt / STEERING.bankSmoothingS),
    );

    // Thrust is capped at the drag at max speed, so terminal speed is vmax; drag is integrated
    // implicitly, which stays stable even for millimetre fry where k/m is large.
    const m = this.mass[i] ?? 1;
    const kd = this.drag[i] ?? 0;
    const vmax = this.maxSpeed[i] ?? 0;
    const thrustMax = kd * vmax * vmax;
    const target = this.targetSpeed[i] ?? 0;
    let thrust: number;
    let dragScale = 1;
    if (burstAndCoast) {
      // Burst-and-coast: a short kick above the wanted speed, then an unpowered glide with the
      // body straight (lower drag) until speed falls below it (Weihs 1974; Calovi et al. 2018).
      const timer = (this.gaitTimer[i] ?? 0) + dt;
      if (coasting) {
        thrust = 0;
        dragScale = BEHAVIOUR.glideDragFactor;
        const done = v <= BEHAVIOUR.coastReleaseFactor * target || timer >= BEHAVIOUR.coastMaxS;
        this.coasting[i] = done ? 0 : 1;
        this.gaitTimer[i] = done ? 0 : timer;
      } else {
        const aim = Math.min(vmax, BEHAVIOUR.burstSpeedFactor * target);
        thrust = clamp(kd * v * v + (m * (aim - v)) / BEHAVIOUR.burstResponseS, 0, thrustMax);
        const done = v >= 0.97 * aim || timer >= BEHAVIOUR.burstMaxS;
        this.coasting[i] = done ? 1 : 0;
        this.gaitTimer[i] = done ? 0 : timer;
      }
    } else {
      this.coasting[i] = 0;
      thrust = clamp(
        kd * v * v + (m * (target - v)) / STEERING.speedResponseS,
        -thrustMax,
        thrustMax,
      );
    }
    this.thrust[i] = thrustMax > 0 ? clamp(thrust / thrustMax, 0, 1) : 0;
    const nextV = clamp((v + (dt * thrust) / m) / (1 + (dt * kd * dragScale * v) / m), 0, vmax);

    const ny = this.yaw[i] ?? 0;
    const np = this.pitch[i] ?? 0;
    const cp = Math.cos(np);
    const fx = Math.sin(ny) * cp;
    const fy = Math.sin(np);
    const fz = Math.cos(ny) * cp;
    const o = i * 3;
    const prev = this.previous;
    prev[0] = this.position[o] ?? 0;
    prev[1] = this.position[o + 1] ?? 0;
    prev[2] = this.position[o + 2] ?? 0;
    this.position[o] = (prev[0] ?? 0) + fx * nextV * dt;
    this.position[o + 1] = (prev[1] ?? 0) + fy * nextV * dt;
    this.position[o + 2] = (prev[2] ?? 0) + fz * nextV * dt;
    this.speed[i] = nextV;

    const nrm = this.normal;
    const into = this.constrainBody(i, fx, fy, fz, nrm);
    if (into === null) {
      this.wedged[i] = 0;
      this.scraping(i, false);
      return;
    }
    this.contacts++;
    this.contactCount[i] = (this.contactCount[i] ?? 0) + 1;
    this.scraping(
      i,
      into < 0 && Math.hypot(nrm[0] ?? 0, nrm[2] ?? 0) >= STEERING.slideMinHorizontal,
    );
    if (!(this.bodyClearance(i) >= -PENETRATION_EPSILON)) {
      // The new pose cannot be made valid (a turn wedged the body into a corner): keep the old one.
      this.position.set(prev, o);
      const tried = (this.yaw[i] ?? 0) - yaw;
      if (Math.abs(wrapAngle(tried)) > 1e-9) {
        this.detourSign[i] = wrapAngle(tried) > 0 ? -1 : 1;
        this.detourTimer[i] = STEERING.detourS;
      }
      this.yaw[i] = yaw;
      this.pitch[i] = pitch;
      this.yawRate[i] = 0;
      this.pitchRate[i] = 0;
      this.constrainBody(
        i,
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
        nrm,
      );
      this.pinned(i);
      return;
    }
    const moved = Math.hypot(
      (this.position[o] ?? 0) - (prev[0] ?? 0),
      (this.position[o + 1] ?? 0) - (prev[1] ?? 0),
      (this.position[o + 2] ?? 0) - (prev[2] ?? 0),
    );
    if (moved < STEERING.pinnedProgressFraction * (this.cruiseSpeed[i] ?? 0) * dt) this.pinned(i);
    else this.wedged[i] = 0;
    if (into < 0) this.speed[i] = nextV * Math.max(0, 1 + into);
  }

  /**
   * Neither turning nor going on gets the fish anywhere: it has nosed into a crevice narrower than
   * its length, and after a moment it backs out on its pectoral fins, the way it came in.
   */
  private pinned(i: number): void {
    const wedged = (this.wedged[i] ?? 0) + STEP_DT;
    this.wedged[i] = wedged;
    if (wedged < STEERING.backOutAfterS) return;
    this.wedged[i] = 0;
    this.detourTimer[i] = 0;
    this.reverseLeft[i] = STEERING.backOutMaxBodyLengths * (this.bodyLength[i] ?? 0);
    this.rememberDeadEnd(i);
  }

  /**
   * A fish that keeps touching glass or rock while getting nowhere is working itself along a
   * dead-end wedge, sliding to and fro fast enough never to count as pinned; it backs out too.
   * Sand and rock tops underneath do not count: a forager rests its belly on them. Nor does a
   * flank or tail brushing a surface: only the snout pushing into one marks a dead end.
   */
  private scraping(i: number, contact: boolean): void {
    if (contact) this.scrapeHits[i] = (this.scrapeHits[i] ?? 0) + 1;
    const time = (this.scrapeTime[i] ?? 0) + STEP_DT;
    if (time < STEERING.scrapeWindowS) {
      this.scrapeTime[i] = time;
      return;
    }
    const o = i * 3;
    const a = this.scrapeAnchor;
    const drift = Math.hypot(
      (this.position[o] ?? 0) - (a[o] ?? 0),
      (this.position[o + 1] ?? 0) - (a[o + 1] ?? 0),
      (this.position[o + 2] ?? 0) - (a[o + 2] ?? 0),
    );
    const hits = (this.scrapeHits[i] ?? 0) / (time / STEP_DT);
    a[o] = this.position[o] ?? 0;
    a[o + 1] = this.position[o + 1] ?? 0;
    a[o + 2] = this.position[o + 2] ?? 0;
    this.scrapeTime[i] = 0;
    this.scrapeHits[i] = 0;
    const length = this.bodyLength[i] ?? 0;
    if (hits < STEERING.scrapeContactFraction || drift > STEERING.scrapeDriftBodyLengths * length) {
      return;
    }
    this.wedged[i] = 0;
    this.detourTimer[i] = 0;
    this.reverseLeft[i] = STEERING.backOutMaxBodyLengths * length;
    this.rememberDeadEnd(i);
  }

  private rememberDeadEnd(i: number): void {
    this.deadEnd[i * 3] = this.position[i * 3] ?? 0;
    this.deadEnd[i * 3 + 1] = this.position[i * 3 + 1] ?? 0;
    this.deadEnd[i * 3 + 2] = this.position[i * 3 + 2] ?? 0;
    this.deadEndTimer[i] = STEERING.deadEndMemoryS;
  }

  /**
   * Backs straight out of a crevice on the pectoral fins, pivoting toward the wanted heading
   * only where the body has room to, until it has regained some room and faces a way out;
   * stopping as soon as it is free would just send it nose-first back into the same slot. It
   * backs out level, since a fish pitched up to climb past an overhang would otherwise sink back
   * under it, and slides along a surface its tail comes up against rather than grinding into it.
   */
  private reverse(i: number, sp: SimSpecies, plan: Plan, yaw: number, pitchIn: number): void {
    const o = i * 3;
    const dt = STEP_DT;
    const prev = this.previous;
    this.speed[i] = 0;
    this.pitchRate[i] = 0;
    const wTurn = this.turnRateLimit(i, sp, plan);
    const yawRate = clamp(wrapAngle((this.targetYaw[i] ?? 0) - yaw) / dt, -wTurn, wTurn);
    this.yaw[i] = wrapAngle(yaw + yawRate * dt);
    this.yawRate[i] = yawRate;
    if (!(this.bodyClearance(i) >= -PENETRATION_EPSILON)) {
      this.yaw[i] = yaw;
      this.yawRate[i] = 0;
    }
    this.pitch[i] = pitchIn - clamp(pitchIn, -sp.maxTurnRate * dt, sp.maxTurnRate * dt);
    if (!(this.bodyClearance(i) >= -PENETRATION_EPSILON)) this.pitch[i] = pitchIn;
    const pitch = this.pitch[i] ?? 0;
    const step = STEERING.backOutSpeedFraction * (this.cruiseSpeed[i] ?? 0) * dt;
    const cp = Math.cos(pitch);
    const heading = this.yaw[i] ?? 0;
    const fx = Math.sin(heading) * cp;
    const fy = Math.sin(pitch);
    const fz = Math.cos(heading) * cp;
    let bx = -Math.sin(heading) * step;
    let by = 0;
    let bz = -Math.cos(heading) * step;
    const n = this.normal;
    if (this.nearestSurface(i, fx, fy, fz, n) < step) {
      const nx = n[0] ?? 0;
      const ny = n[1] ?? 0;
      const nz = n[2] ?? 0;
      if (fx * nx + fy * ny + fz * nz > STEERING.backOutBlockedCos) {
        this.reverseLeft[i] = 0;
        return;
      }
      const along = bx * nx + bz * nz;
      if (along < 0) {
        bx -= along * nx;
        by -= along * ny;
        bz -= along * nz;
      }
    }
    prev[0] = this.position[o] ?? 0;
    prev[1] = this.position[o + 1] ?? 0;
    prev[2] = this.position[o + 2] ?? 0;
    this.position[o] = (prev[0] ?? 0) + bx;
    this.position[o + 1] = (prev[1] ?? 0) + by;
    this.position[o + 2] = (prev[2] ?? 0) + bz;
    const into = this.constrainBody(i, fx, fy, fz, this.normal);
    if (into !== null) this.contacts++;
    if (!(this.bodyClearance(i) >= -PENETRATION_EPSILON)) {
      this.position.set(prev, o);
      this.reverseLeft[i] = 0;
      return;
    }
    const left = Math.max(0, (this.reverseLeft[i] ?? 0) - step);
    const length = this.bodyLength[i] ?? 0;
    const backed = (STEERING.backOutMaxBodyLengths - STEERING.backOutBodyLengths) * length;
    if (into !== null && into > STEERING.backOutBlockedCos) {
      this.reverseLeft[i] = 0;
      return;
    }
    if (into !== null && into > 0) {
      const nl = Math.hypot(n[0] ?? 0, n[2] ?? 0);
      if (nl > STEERING.slideMinHorizontal) {
        const nx = (n[0] ?? 0) / nl;
        const nz = (n[2] ?? 0) / nl;
        const hx = Math.sin(heading);
        const hz = Math.cos(heading);
        const d = hx * nx + hz * nz;
        const turn = clamp(
          wrapAngle(Math.atan2(hx - d * nx, hz - d * nz) - heading),
          -wTurn * dt,
          wTurn * dt,
        );
        this.yaw[i] = wrapAngle(heading + turn);
        if (!(this.bodyClearance(i) >= -PENETRATION_EPSILON)) this.yaw[i] = heading;
      }
    }
    if (left > backed) {
      this.reverseLeft[i] = left;
      return;
    }

    const want = this.targetYaw[i] ?? 0;
    const free =
      Math.abs(wrapAngle(want - heading)) < STEERING.backOutAlignedRad ||
      this.turnRoom(i, this.steerSdf[0] ?? this.sceneSdf, heading, want) >=
        STEERING.turnRoomMarginBodyLengths * length;
    this.reverseLeft[i] = free ? 0 : left;
  }

  /** Clearance of the spine sample nearest a surface, with that surface's normal in `nrm`. */
  private nearestSurface(i: number, fx: number, fy: number, fz: number, nrm: Float64Array): number {
    const o = i * 3;
    const length = this.bodyLength[i] ?? 0;
    const scratch = this.probeNormal;
    let worst = Infinity;
    for (const s of BEHAVIOUR.bodySampleOffsets) {
      const k = s * length;
      const d = this.sceneSdf.sample(
        (this.position[o] ?? 0) + fx * k,
        (this.position[o + 1] ?? 0) + fy * k,
        (this.position[o + 2] ?? 0) + fz * k,
        scratch,
      );
      if (d < worst) {
        worst = d;
        nrm.set(scratch);
      }
    }
    return worst - (this.thickness[i] ?? 0);
  }

  /**
   * Pushes the spine-chain body of fish `i` out of the tank walls and hard decor along the
   * deepest sample's normal. Returns the heading's component along the last push normal, or null
   * when the body was already clear.
   */
  private constrainBody(
    i: number,
    fx: number,
    fy: number,
    fz: number,
    nrm: Float64Array,
  ): number | null {
    const o = i * 3;
    const length = this.bodyLength[i] ?? 0;
    const t = (this.thickness[i] ?? 0) + PENETRATION_EPSILON;
    const scratch = this.probeNormal;
    let into: number | null = null;
    for (let pass = 0; pass < MAX_BODY_PUSHES; pass++) {
      let worst = 0;
      let wx = 0;
      let wy = 0;
      let wz = 0;
      const px = this.position[o] ?? 0;
      const py = this.position[o + 1] ?? 0;
      const pz = this.position[o + 2] ?? 0;
      for (const s of BEHAVIOUR.bodySampleOffsets) {
        const k = s * length;
        const d = this.sceneSdf.sample(px + fx * k, py + fy * k, pz + fz * k, scratch);
        if (t - d > worst) {
          worst = t - d;
          wx = scratch[0] ?? 0;
          wy = scratch[1] ?? 0;
          wz = scratch[2] ?? 0;
        }
      }
      if (worst <= 0) break;
      this.position[o] = px + wx * worst;
      this.position[o + 1] = py + wy * worst;
      this.position[o + 2] = pz + wz * worst;
      nrm[0] = wx;
      nrm[1] = wy;
      nrm[2] = wz;
      into = fx * wx + fy * wy + fz * wz;
    }
    return into;
  }

  /** Writes the per-fish record in `SnapshotField` layout. */
  writeSnapshot(out: Float32Array): void {
    if (out.length < this.count * SNAPSHOT_STRIDE) {
      throw new RangeError(
        `snapshot buffer holds ${out.length} floats, needs ${this.count * SNAPSHOT_STRIDE}`,
      );
    }
    for (let i = 0; i < this.count; i++) {
      const o = i * SNAPSHOT_STRIDE;
      out[o] = this.position[i * 3] ?? 0;
      out[o + 1] = this.position[i * 3 + 1] ?? 0;
      out[o + 2] = this.position[i * 3 + 2] ?? 0;
      quatFromYawPitchRoll(this.yaw[i] ?? 0, this.pitch[i] ?? 0, this.roll[i] ?? 0, out, o + 3);
      out[o + 7] = this.speed[i] ?? 0;
      out[o + 8] = this.yawRate[i] ?? 0;
      out[o + 9] = this.state[i] ?? 0;
      out[o + 10] = this.thrust[i] ?? 0;
    }
  }
}

function basinOfConfig(config: AnyWorldConfig): Basin {
  const { space, tank } = config;
  if (space !== undefined && tank !== undefined) {
    throw new RangeError('WorldConfig takes either space or tank, not both');
  }
  if (space !== undefined) return Basin.fromSpace(space);
  if (tank !== undefined) return Basin.fromTank(tank);
  throw new RangeError('WorldConfig needs space (tank space) or tank (legacy box)');
}
