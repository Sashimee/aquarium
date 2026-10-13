import type { Collider, TankSpace } from '@aquarium/shared';
import { Basin, type TankDimensions } from './basin.ts';
import { Behaviour, BEHAVIOUR, type Anchor, type Plan, type Stimulus } from './behaviour.ts';
import { DecorField, UnionSdf } from './decor.ts';
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
  backOutMaxBodyLengths: 1.5,
  backOutAlignedRad: 30 * DEG,
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

const PENETRATION_EPSILON = 1e-9;
const MAX_BODY_PUSHES = 8;

const NO_ATE_EVENTS: readonly AteEvent[] = Object.freeze([]);

export class World {
  readonly count: number;
  readonly fishIds: readonly string[];
  /** The water and the floor under it, in the world's frame. */
  readonly basin: Basin;
  readonly species: readonly SimSpecies[];
  tick = 0;
  /** Steps where the hard SDF constraint had to move a fish; avoidance should keep this rare. */
  contacts = 0;
  /** Fish-steps spent inside a plant (soft contact). */
  plantContacts = 0;

  readonly position: Float64Array;
  readonly yaw: Float64Array;
  readonly pitch: Float64Array;
  readonly roll: Float64Array;
  readonly speed: Float64Array;
  readonly yawRate: Float64Array;
  readonly pitchRate: Float64Array;
  readonly state: Uint8Array;

  readonly bodyLength: Float64Array;
  /** Comfort radius steering keeps from surfaces; the hard body is a thinner spine chain. */
  readonly radius: Float64Array;
  readonly thickness: Float64Array;
  readonly speciesIndex: Int32Array;
  /** Caudal thrust as a fraction of the maximum; 0 while coasting. */
  readonly thrust: Float64Array;
  /** Per-fish share of `contacts`. */
  readonly contactCount: Uint32Array;
  readonly forward: Float64Array;
  readonly distSq: Float64Array;
  readonly maxSpeed: Float64Array;
  readonly cruiseSpeed: Float64Array;

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
  private readonly mass: Float64Array;
  private readonly drag: Float64Array;
  private readonly coasting: Uint8Array;
  private readonly gaitTimer: Float64Array;
  private readonly detourSign: Int8Array;
  private readonly detourTimer: Float64Array;
  private readonly cramped: Uint8Array;
  private readonly wedged: Float64Array;
  private readonly reverseLeft: Float64Array;
  private readonly wanderTurn: Float64Array;
  private readonly wanderPitch: Float64Array;
  /** Horizontal unit slide direction along the wall being avoided; zero when disengaged. */
  private readonly avoidTangent: Float64Array;
  /** Slide direction when the current avoidance engagement began. */
  private readonly avoidOrigin: Float64Array;
  private readonly avoidMemory: Float64Array;
  private readonly intent: Float64Array;
  private readonly targetYaw: Float64Array;
  private readonly targetPitch: Float64Array;
  private readonly targetSpeed: Float64Array;
  private readonly schoolGroup: Int32Array;
  private readonly kMax: number;
  private readonly schoolNbr: Int32Array;
  private readonly anyNbr: Int32Array;
  private readonly scratchDist: Float64Array;
  private readonly normal = new Float64Array(3);
  private readonly probeNormal = new Float64Array(3);
  private readonly previous = new Float64Array(3);

  constructor(config: AnyWorldConfig) {
    this.rng = new Rng(config.seed);
    this.basin = basinOfConfig(config);
    this.species = config.species.map(toSimSpecies);
    const byId = new Map(this.species.map((s, i) => [s.id, i]));
    if (byId.size !== this.species.length) throw new Error('species ids must be unique');

    let longest = 0;
    for (const f of config.fish) {
      const sp = this.species[byId.get(f.species) ?? -1];
      longest = Math.max(longest, f.bodyLengthM ?? sp?.bodyLength ?? 0);
    }
    // Steering never samples further than ~1.75 body lengths from a surface; beyond that reach
    // the decor field only has to report "far".
    const reach = Math.max(0.05, 2 * longest);
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
    this.count = n;
    this.fishIds = config.fish.map((f) => f.id);
    if (new Set(this.fishIds).size !== n) throw new Error('fish ids must be unique');

    this.position = new Float64Array(n * 3);
    this.yaw = new Float64Array(n);
    this.pitch = new Float64Array(n);
    this.roll = new Float64Array(n);
    this.speed = new Float64Array(n);
    this.yawRate = new Float64Array(n);
    this.pitchRate = new Float64Array(n);
    this.state = new Uint8Array(n);
    this.bodyLength = new Float64Array(n);
    this.radius = new Float64Array(n);
    this.thickness = new Float64Array(n);
    this.speciesIndex = new Int32Array(n);
    this.thrust = new Float64Array(n);
    this.contactCount = new Uint32Array(n);
    this.coasting = new Uint8Array(n);
    this.gaitTimer = new Float64Array(n);
    this.detourSign = new Int8Array(n);
    this.detourTimer = new Float64Array(n);
    this.cramped = new Uint8Array(n);
    this.wedged = new Float64Array(n);
    this.reverseLeft = new Float64Array(n);
    this.mass = new Float64Array(n);
    this.drag = new Float64Array(n);
    this.maxSpeed = new Float64Array(n);
    this.cruiseSpeed = new Float64Array(n);
    this.wanderTurn = new Float64Array(n);
    this.wanderPitch = new Float64Array(n);
    this.avoidTangent = new Float64Array(n * 2);
    this.avoidOrigin = new Float64Array(n * 2);
    this.avoidMemory = new Float64Array(n);
    this.intent = new Float64Array(n * 3);
    this.targetYaw = new Float64Array(n);
    this.targetPitch = new Float64Array(n);
    this.targetSpeed = new Float64Array(n);
    this.forward = new Float64Array(n * 3);
    this.distSq = new Float64Array(n * n);
    this.schoolGroup = new Int32Array(n);

    let kMax: number = STEERING.anyNeighbours;
    for (const s of this.species) kMax = Math.max(kMax, s.neighbours);
    this.kMax = kMax;
    this.schoolNbr = new Int32Array(n * kMax);
    this.anyNbr = new Int32Array(n * kMax);
    this.scratchDist = new Float64Array(kMax);

    config.fish.forEach((spawn, i) => this.spawn(i, spawn, byId));
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
    return this.hardDecor.apply(hard) + this.softDecor.apply(soft);
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

  private spawn(i: number, spawn: FishSpawn, byId: ReadonlyMap<string, number>): void {
    const si = byId.get(spawn.species);
    if (si === undefined) {
      throw new Error(`fish "${spawn.id}" uses unknown species "${spawn.species}"`);
    }
    const sp = this.species[si];
    if (sp === undefined) throw new Error(`species index ${si} out of range`);
    const length = spawn.bodyLengthM ?? sp.bodyLength;
    if (!Number.isFinite(length) || length <= 0) {
      throw new RangeError(`fish "${spawn.id}": bodyLengthM must be positive, got ${length}`);
    }
    // Isometric scaling: mass ∝ L³, drag area ∝ L², speeds in body lengths per second.
    const scale = length / sp.bodyLength;
    const r = length * STEERING.collisionRadiusBodyLengths;
    const basin = this.basin;
    if (2 * r >= Math.min(basin.width, basin.maxY - basin.floorMax, basin.depth)) {
      throw new RangeError(`fish "${spawn.id}" (${length} m) does not fit in the tank`);
    }

    this.speciesIndex[i] = si;
    this.schoolGroup[i] = sp.schooling ? si : -1 - i;
    this.bodyLength[i] = length;
    this.radius[i] = r;
    this.thickness[i] = length * BEHAVIOUR.bodyThicknessBodyLengths;
    this.mass[i] = sp.mass * scale ** 3;
    this.drag[i] = 0.5 * WATER_DENSITY * DRAG_COEFFICIENT_L2 * length * length;
    this.maxSpeed[i] = sp.maxSpeed * scale;
    this.cruiseSpeed[i] = sp.cruiseSpeed * scale;

    const pad = r * 2;
    const o = i * 3;
    let placed = false;
    for (let attempt = 0; attempt < STEERING.spawnAttempts && !placed; attempt++) {
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
      this.position[o] = x;
      this.position[o + 1] = y;
      this.position[o + 2] = z;
      placed = true;
    }
    if (!placed) {
      throw new RangeError(`fish "${spawn.id}": no free water to spawn in, decor fills the tank`);
    }
    const yaw = this.rng.range(-Math.PI, Math.PI);
    this.yaw[i] = yaw;
    // Hold the spawn heading until steering has a real direction (heading hold in `steer`).
    this.targetYaw[i] = yaw;
    this.speed[i] = (this.cruiseSpeed[i] ?? 0) * 0.5;
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
      const zone = 0.5 * (length + (this.bodyLength[j] ?? 0)) * STEERING.separationZoneBodyLengths;
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

    if (plan.seekWeight > 0) {
      let qx = (plan.seekX - px) / plan.seekTau;
      let qy = (plan.seekY - py) / plan.seekTau;
      let qz = (plan.seekZ - pz) / plan.seekTau;
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

    const nh = this.normal;
    const np = this.probeNormal;
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
    const sdf = this.steerSdf[(plan.floor ? 1 : 0) + (plan.surface ? 2 : 0)] ?? this.sceneSdf;
    const dHere = sdf.sample(px, py, pz, nh);
    const verticalHere = Math.abs(nh[1] ?? 0);
    const nose = (BEHAVIOUR.bodySampleOffsets[0] ?? 0) * length;
    const noseRoom =
      sdf.sample(px + fx * nose, py + fy * nose, pz + fz * nose, np) - (this.thickness[i] ?? 0);
    this.cramped[i] = noseRoom < length * STEERING.crampedClearanceBodyLengths ? 1 : 0;
    const probe = 0.5 * length + v * STEERING.avoidLookaheadS + v / this.turnRateLimit(i, sp, plan);
    const dProbe = sdf.sample(px + fx * probe, py + fy * probe, pz + fz * probe, np);
    const probeMargin = radius + length * STEERING.avoidMarginBodyLengths * comfort;
    // Only a path that closes on a surface is a threat; a probe that is merely near a wall the
    // fish runs parallel to (common for large fish in a narrow tank) is left to the proximity term.
    const closing = clamp(((dHere - dProbe) / probe) * STEERING.avoidClosingGain, 0, 1);
    const aProbe = clamp((probeMargin - dProbe) / (probeMargin - radius), 0, 1) * closing;
    const aHere = clamp((clearance - dHere) / (clearance - radius), 0, 1);
    const a = Math.max(aHere, aProbe);
    if (a > 0) {
      // Prioritised blending (Reynolds 1987): an imminent wall outranks the school.
      const keep = 1 - a * STEERING.avoidPriority;
      dx *= keep;
      dy *= keep;
      dz *= keep;
      const h = length * STEERING.avoidGradientBodyLengths;
      const scratch = this.previous;
      if (aHere > 0) smoothGradient(sdf, px, py, pz, h, nh, scratch);
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
          const reference = px0 !== 0 || pz0 !== 0 ? tx * px0 + tz * pz0 : fx * tx + fz * tz;
          let side = Math.abs(reference) > 1e-6 ? Math.sign(reference) : nextWt >= 0 ? 1 : -1;
          // A slide that runs into a narrowing slot (glass on one flank, rock closing in on the
          // other) only wedges the fish deeper; once its snout is cramped it turns back to where
          // the gap opens.
          if (this.cramped[i] === 1) {
            const ahead = sdf.sample(px + tx * side * nose, py, pz + tz * side * nose, scratch);
            const behind = sdf.sample(px - tx * side * nose, py, pz - tz * side * nose, scratch);
            if (ahead < STEERING.narrowingFlipRatio * behind) {
              side = -side;
              px0 = 0;
              pz0 = 0;
            }
          }
          tx *= side;
          tz *= side;
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
      a > 0 ? cruiseBase * STEERING.avoidMinSpeedFraction * a : 0,
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
      return;
    }
    this.contacts++;
    this.contactCount[i] = (this.contactCount[i] ?? 0) + 1;
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
  }

  /**
   * Backs straight out of a crevice on the pectoral fins, pivoting toward the wanted heading
   * only where the body has room to, until it has regained some room and faces a way out;
   * stopping as soon as it is free would just send it nose-first back into the same slot.
   */
  private reverse(i: number, sp: SimSpecies, plan: Plan, yaw: number, pitch: number): void {
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
    const step = STEERING.backOutSpeedFraction * (this.cruiseSpeed[i] ?? 0) * dt;
    const cp = Math.cos(pitch);
    const heading = this.yaw[i] ?? 0;
    prev[0] = this.position[o] ?? 0;
    prev[1] = this.position[o + 1] ?? 0;
    prev[2] = this.position[o + 2] ?? 0;
    this.position[o] = (prev[0] ?? 0) - Math.sin(heading) * cp * step;
    this.position[o + 1] = (prev[1] ?? 0) - Math.sin(pitch) * step;
    this.position[o + 2] = (prev[2] ?? 0) - Math.cos(heading) * cp * step;
    const fx = Math.sin(heading) * cp;
    const fz = Math.cos(heading) * cp;
    if (this.constrainBody(i, fx, Math.sin(pitch), fz, this.normal) !== null) this.contacts++;
    if (!(this.bodyClearance(i) >= -PENETRATION_EPSILON)) {
      this.position.set(prev, o);
      this.reverseLeft[i] = 0;
      return;
    }
    const left = Math.max(0, (this.reverseLeft[i] ?? 0) - step);
    const length = this.bodyLength[i] ?? 0;
    const backed = (STEERING.backOutMaxBodyLengths - STEERING.backOutBodyLengths) * length;
    const aligned =
      Math.abs(wrapAngle((this.targetYaw[i] ?? 0) - heading)) < STEERING.backOutAlignedRad;
    this.reverseLeft[i] = left <= backed && aligned ? 0 : left;
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
