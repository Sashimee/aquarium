import { clamp, DEG, quatFromYawPitchRoll, wrapAngle } from './math.ts';
import { pairwiseDistanceSq, selectNearest } from './neighbours.ts';
import { Rng } from './rng.ts';
import {
  resolvePenetration,
  smoothGradient,
  TankSdf,
  type Sdf,
  type TankDimensions,
} from './sdf.ts';
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
  intentSmoothingS: 0.15,
  turnGainPerS: 6,
  turnSmoothingS: 0.1,
  speedResponseS: 0.4,
  maxBankRad: 35 * DEG,
  bankReferenceAccel: 1,
  bankSmoothingS: 0.2,
  collisionRadiusBodyLengths: 0.5,
} as const;

export interface FishSpawn {
  readonly id: string;
  readonly species: string;
  /** Overrides the species' adult body length, e.g. for a growing fish. */
  readonly bodyLengthM?: number;
}

export interface WorldConfig {
  readonly seed: number;
  readonly tank: TankDimensions;
  readonly species: readonly SpeciesInput[];
  readonly fish: readonly FishSpawn[];
}

const PENETRATION_EPSILON = 1e-9;

export class World {
  readonly count: number;
  readonly fishIds: readonly string[];
  readonly tank: TankDimensions;
  readonly species: readonly SimSpecies[];
  tick = 0;
  /** Steps where the hard SDF constraint had to move a fish; avoidance should keep this rare. */
  contacts = 0;

  readonly position: Float64Array;
  readonly yaw: Float64Array;
  readonly pitch: Float64Array;
  readonly roll: Float64Array;
  readonly speed: Float64Array;
  readonly yawRate: Float64Array;
  readonly pitchRate: Float64Array;
  readonly state: Uint8Array;

  readonly bodyLength: Float64Array;
  readonly radius: Float64Array;
  readonly speciesIndex: Int32Array;

  private readonly rng: Rng;
  private readonly sdf: Sdf;
  private readonly mass: Float64Array;
  private readonly drag: Float64Array;
  private readonly maxSpeed: Float64Array;
  private readonly cruiseSpeed: Float64Array;
  private readonly wanderTurn: Float64Array;
  private readonly wanderPitch: Float64Array;
  /** Committed escape turn (+1 left, −1 right, 0 none) so a head-on approach cannot dither. */
  private readonly avoidSide: Int8Array;
  private readonly intent: Float64Array;
  private readonly targetYaw: Float64Array;
  private readonly targetPitch: Float64Array;
  private readonly targetSpeed: Float64Array;
  private readonly forward: Float64Array;
  private readonly distSq: Float64Array;
  private readonly schoolGroup: Int32Array;
  private readonly kMax: number;
  private readonly schoolNbr: Int32Array;
  private readonly anyNbr: Int32Array;
  private readonly scratchDist: Float64Array;
  private readonly normal = new Float64Array(3);
  private readonly probeNormal = new Float64Array(3);
  private readonly previous = new Float64Array(3);

  constructor(config: WorldConfig) {
    this.rng = new Rng(config.seed);
    this.tank = config.tank;
    this.sdf = new TankSdf(config.tank);
    this.species = config.species.map(toSimSpecies);
    const byId = new Map(this.species.map((s, i) => [s.id, i]));
    if (byId.size !== this.species.length) throw new Error('species ids must be unique');

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
    this.speciesIndex = new Int32Array(n);
    this.mass = new Float64Array(n);
    this.drag = new Float64Array(n);
    this.maxSpeed = new Float64Array(n);
    this.cruiseSpeed = new Float64Array(n);
    this.wanderTurn = new Float64Array(n);
    this.wanderPitch = new Float64Array(n);
    this.avoidSide = new Int8Array(n);
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
  }

  get time(): number {
    return this.tick * STEP_DT;
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
    const { width, height, depth } = this.tank;
    if (2 * r >= Math.min(width, height, depth)) {
      throw new RangeError(`fish "${spawn.id}" (${length} m) does not fit in the tank`);
    }

    this.speciesIndex[i] = si;
    this.schoolGroup[i] = sp.schooling ? si : -1 - i;
    this.bodyLength[i] = length;
    this.radius[i] = r;
    this.mass[i] = sp.mass * scale ** 3;
    this.drag[i] = 0.5 * WATER_DENSITY * DRAG_COEFFICIENT_L2 * length * length;
    this.maxSpeed[i] = sp.maxSpeed * scale;
    this.cruiseSpeed[i] = sp.cruiseSpeed * scale;

    const pad = r * 2;
    const yLo = Math.max(sp.depthLow * height, pad);
    const yHi = Math.min(sp.depthHigh * height, height - pad);
    const o = i * 3;
    this.position[o] = this.rng.range(-width / 2 + pad, width / 2 - pad);
    this.position[o + 1] = yLo <= yHi ? this.rng.range(yLo, yHi) : height / 2;
    this.position[o + 2] = this.rng.range(-depth / 2 + pad, depth / 2 - pad);
    this.yaw[i] = this.rng.range(-Math.PI, Math.PI);
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
    for (let i = 0; i < n; i++) this.steer(i);
    for (let i = 0; i < n; i++) this.integrate(i);
    this.tick++;
  }

  private steer(i: number): void {
    const n = this.count;
    const sp = this.speciesOf(i);
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
    const radius = this.radius[i] ?? 0;
    const cruise = this.cruiseSpeed[i] ?? 0;
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
    let dx = Math.sin(wy) * cwp * cruise;
    let dy = Math.sin(nextWp) * cruise;
    let dz = Math.cos(wy) * cwp * cruise;

    const k = this.kMax;
    let state: FishState = FishState.Cruise;
    if (sp.schooling) {
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
        const wa = STEERING.alignmentWeight;
        dx += wa * (ax * inv - fx * v);
        dy += wa * (ay * inv - fy * v);
        dz += wa * (az * inv - fz * v);
        const wc = STEERING.cohesionRatePerS;
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
    const ws = STEERING.separationWeight * cruise;
    dx += sx * ws;
    dy += sy * ws;
    dz += sz * ws;

    const height = this.tank.height;
    const clearance = radius + length * STEERING.proximityBodyLengths;
    const bandLo = Math.max(sp.depthLow * height, clearance);
    const bandHi = Math.min(sp.depthHigh * height, height - clearance);
    const bandTarget = clamp(py, Math.min(bandLo, bandHi), Math.max(bandLo, bandHi));
    const vyLimit = cruise * STEERING.depthMaxSpeedFraction;
    dy += clamp((bandTarget - py) / STEERING.depthTauS, -vyLimit, vyLimit);

    // Containment (Reynolds 1999): react to the wall ahead along the path, plus a short-range
    // safety term for walls the probe misses (beside or behind while turning).
    const nh = this.normal;
    const np = this.probeNormal;
    const dHere = this.sdf.sample(px, py, pz, nh);
    const probe = 0.5 * length + v * STEERING.avoidLookaheadS + v / sp.maxTurnRate;
    const dProbe = this.sdf.sample(px + fx * probe, py + fy * probe, pz + fz * probe, np);
    const probeMargin = radius + length * STEERING.avoidMarginBodyLengths;
    const aProbe = clamp((probeMargin - dProbe) / (probeMargin - radius), 0, 1);
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
      if (aHere > 0) smoothGradient(this.sdf, px, py, pz, h, nh, scratch);
      if (aProbe > 0) {
        smoothGradient(this.sdf, px + fx * probe, py + fy * probe, pz + fz * probe, h, np, scratch);
      }
      let nx = (nh[0] ?? 0) * aHere + (np[0] ?? 0) * aProbe;
      let ny = (nh[1] ?? 0) * aHere + (np[1] ?? 0) * aProbe;
      let nz = (nh[2] ?? 0) * aHere + (np[2] ?? 0) * aProbe;
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
        dx += nx * cruise * a;
        dy += ny * cruise * a;
        dz += nz * cruise * a;
        // Near a pane the cancelled vector can shrink to almost nothing, and atan2 of the residue
        // makes the heading jitter. Guarantee a committed slide along the pane instead.
        const hl = Math.hypot(nx, nz);
        if (hl > 0.2) {
          let tx = -nz / hl;
          let tz = nx / hl;
          let side = this.avoidSide[i] ?? 0;
          if (side === 0) {
            const along = fx * tx + fz * tz;
            side = Math.abs(along) > 1e-6 ? Math.sign(along) : nextWt >= 0 ? 1 : -1;
            this.avoidSide[i] = side;
          }
          tx *= side;
          tz *= side;
          const shortfall = cruise * a * hl - (dx * tx + dz * tz);
          if (shortfall > 0) {
            dx += tx * shortfall;
            dz += tz * shortfall;
          }
        }
      }
      if (a > 0.25) state = FishState.Avoid;
    } else {
      this.avoidSide[i] = 0;
    }
    this.state[i] = state;

    // Neighbour sets change discretely; a short reaction lag keeps the heading from twitching.
    const lag = 1 - Math.exp(-STEP_DT / STEERING.intentSmoothingS);
    dx = (this.intent[o] ?? 0) + (dx - (this.intent[o] ?? 0)) * lag;
    dy = (this.intent[o + 1] ?? 0) + (dy - (this.intent[o + 1] ?? 0)) * lag;
    dz = (this.intent[o + 2] ?? 0) + (dz - (this.intent[o + 2] ?? 0)) * lag;
    this.intent[o] = dx;
    this.intent[o + 1] = dy;
    this.intent[o + 2] = dz;

    const mag = Math.hypot(dx, dy, dz);
    if (mag < 1e-9) {
      this.targetYaw[i] = yaw;
      this.targetPitch[i] = 0;
      this.targetSpeed[i] = 0;
      return;
    }
    const cosAhead = (dx * fx + dy * fy + dz * fz) / mag;
    this.targetYaw[i] = Math.atan2(dx, dz);
    this.targetPitch[i] = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -sp.maxPitch, sp.maxPitch);
    this.targetSpeed[i] = clamp(mag * (0.5 + 0.5 * cosAhead), 0, vmax);
  }

  private integrate(i: number): void {
    const dt = STEP_DT;
    const sp = this.speciesOf(i);
    const wmax = sp.maxTurnRate;
    const smooth = Math.min(1, dt / STEERING.turnSmoothingS);

    const yaw = this.yaw[i] ?? 0;
    const yawCmd = clamp(
      wrapAngle((this.targetYaw[i] ?? 0) - yaw) * STEERING.turnGainPerS,
      -wmax,
      wmax,
    );
    const yawRate = (this.yawRate[i] ?? 0) + (yawCmd - (this.yawRate[i] ?? 0)) * smooth;
    this.yawRate[i] = yawRate;
    this.yaw[i] = wrapAngle(yaw + yawRate * dt);

    const pitch = this.pitch[i] ?? 0;
    const pitchCmd = clamp(
      ((this.targetPitch[i] ?? 0) - pitch) * STEERING.turnGainPerS,
      -wmax,
      wmax,
    );
    const pitchRate = (this.pitchRate[i] ?? 0) + (pitchCmd - (this.pitchRate[i] ?? 0)) * smooth;
    this.pitchRate[i] = pitchRate;
    this.pitch[i] = clamp(pitch + pitchRate * dt, -sp.maxPitch, sp.maxPitch);

    const v = this.speed[i] ?? 0;
    const bankTarget =
      -STEERING.maxBankRad * Math.tanh((v * yawRate) / STEERING.bankReferenceAccel);
    const roll = this.roll[i] ?? 0;
    this.roll[i] = roll + (bankTarget - roll) * Math.min(1, dt / STEERING.bankSmoothingS);

    // Thrust is capped at the drag at max speed, so terminal speed is vmax; drag is integrated
    // implicitly, which stays stable even for millimetre fry where k/m is large.
    const m = this.mass[i] ?? 1;
    const kd = this.drag[i] ?? 0;
    const vmax = this.maxSpeed[i] ?? 0;
    const thrustMax = kd * vmax * vmax;
    const thrust = clamp(
      kd * v * v + (m * ((this.targetSpeed[i] ?? 0) - v)) / STEERING.speedResponseS,
      -thrustMax,
      thrustMax,
    );
    const nextV = clamp((v + (dt * thrust) / m) / (1 + (dt * kd * v) / m), 0, vmax);

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

    const radius = this.radius[i] ?? 0;
    const nrm = this.normal;
    const d = this.sdf.sample(
      this.position[o] ?? 0,
      this.position[o + 1] ?? 0,
      this.position[o + 2] ?? 0,
      nrm,
    );
    if (d >= radius) return;
    this.contacts++;
    if (!resolvePenetration(this.sdf, this.position, o, radius + PENETRATION_EPSILON, nrm)) {
      this.position.set(prev, o);
    }
    const into = fx * (nrm[0] ?? 0) + fy * (nrm[1] ?? 0) + fz * (nrm[2] ?? 0);
    if (into < 0) this.speed[i] = nextV * (1 + into);
  }

  /** Writes positions, orientations, speeds, yaw rates and states in `SnapshotField` layout. */
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
    }
  }
}
