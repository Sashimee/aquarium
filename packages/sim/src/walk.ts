import type { Basin } from './basin.ts';
import { BEHAVIOUR, type Plan } from './behaviour.ts';
import type { FishResize } from './fishArrays.ts';
import { clamp, quatFromBasis, type Vec3 } from './math.ts';
import type { Rng } from './rng.ts';
import type { Sdf } from './sdf.ts';
import { FishState } from './snapshot.ts';
import type { SimSpecies, SimWalking } from './species.ts';

/** Every tunable of the walking model; sources are in BEHAVIOUR.md. */
export const WALK = {
  /** Body centre height over the surface walked on; above the body's half-thickness of 0.12. */
  standoffBodyLengths: 0.15,
  projectionPasses: 3,
  spawnProjectionPasses: 8,
  /** Spine samples this far beyond the stand-off still tilt the body towards their surface. */
  normalReachBodyLengths: 0.5,
  /** A surface whose normal is within 45° of up is ground, walkable whatever `surfaces` lists. */
  groundCos: Math.SQRT1_2,
  /**
   * A surface facing more than 30° below the horizontal is an overhang: not walked, since the
   * undercut where a rounded rock meets the sand narrows below the body's thickness.
   */
  overhangSin: 0.5,
  /** A surface within 60° of the one underfoot is still footing; a steeper one is an obstacle. */
  footingCos: 0.5,
  /** The surface fell away further than this in one step: the walker lost its footing. */
  gripLossBodyLengths: 0.25,
  attachSlackBodyLengths: 0.05,
  turnGainPerS: 4,
  wanderTurnSdRadPerS: 1,
  wanderTurnTauS: 1,
  wanderLookaheadS: 0.5,
  seekWeight: 2,
  speedResponseS: 0.15,
  upSmoothingS: 0.1,
  probeBodyLengths: 0.6,
  forbiddenReachBodyLengths: 0.5,
  forbiddenWeight: 3,
  topMarginBodyLengths: 1.5,
  topWeight: 2,
  separationBodyLengths: 1,
  separationWeight: 1.5,
  mouthBodyLengths: 0.4,
  arrivalBodyLengths: 0.5,
  arrivalSpeedFloor: 0.15,
  sinkSpeedMps: 0.05,
  sinkTauS: 0.3,
  flipTurnShare: 0.25,
  flipUpShare: 0.5,
  wedgedS: 0.5,
} as const;

const PENETRATION_EPSILON = 1e-9;
const MAX_BODY_PUSHES = 8;

/** What `World` exposes to the walking model. */
export interface WalkHost {
  readonly count: number;
  readonly basin: Basin;
  readonly rng: Rng;
  readonly position: Float64Array;
  readonly yaw: Float64Array;
  readonly pitch: Float64Array;
  readonly roll: Float64Array;
  readonly speed: Float64Array;
  readonly yawRate: Float64Array;
  readonly pitchRate: Float64Array;
  readonly thrust: Float64Array;
  readonly state: Uint8Array;
  readonly bodyLength: Float64Array;
  readonly thickness: Float64Array;
  readonly maxSpeed: Float64Array;
  readonly distSq: Float64Array;
  /** Tank and hard decor: what no body may enter. */
  readonly sceneSdf: Sdf;
  /** Tank without the water surface, and hard decor: everything a walker can stand on. */
  readonly substrateSdf: Sdf;
  speciesOf(i: number): SimSpecies;
}

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * Walking invertebrates: they stand a fixed height off whatever surface is under them, turn in
 * its tangent plane and carry their heading over edges and into corners; a tail-flip throws them
 * off it, and they sink until they land again.
 */
export class Walkers {
  private readonly host: WalkHost;
  private readonly glass: Sdf;
  private readonly decor: Sdf;
  private readonly dt: number;
  private _attached: Uint8Array;
  private _normal: Float64Array;
  private _up: Float64Array;
  private _heading: Float64Array;
  private _legPhase: Float64Array;
  private _flip: Float64Array;
  private flipLeft: Float64Array;
  private flipFrom: Float64Array;
  private flipDir: Float64Array;
  private velocity: Float64Array;
  private wander: Float64Array;
  private blocked: Uint16Array;
  private readonly g = new Float64Array(3);
  private readonly n = new Float64Array(3);
  private readonly scratch = new Float64Array(3);
  private readonly probe = new Float64Array(3);
  /** Position, heading, up and normal before the step, restored if the step cannot be made valid. */
  private readonly before = new Float64Array(12);
  /** Position before a landing attempt, restored if there is nothing to stand on there. */
  private readonly landing = new Float64Array(3);
  private readonly basis: Vec3[] = [
    [0, 0, 1],
    [0, 1, 0],
  ];

  /** 1 while standing on a surface. */
  get attached(): Uint8Array {
    return this._attached;
  }

  /** Unit normal of the surface under the walker, averaged along its body. */
  get normal(): Float64Array {
    return this._normal;
  }

  /** The body's up axis: the surface normal, smoothed, held perpendicular to the heading. */
  get up(): Float64Array {
    return this._up;
  }

  get heading(): Float64Array {
    return this._heading;
  }

  /** Leg cycle phase in [0, 1). */
  get legPhase(): Float64Array {
    return this._legPhase;
  }

  /** Tail-flip progress, 0 at onset to 1 at its end; 0 outside a flip. */
  get flip(): Float64Array {
    return this._flip;
  }

  constructor(host: WalkHost, glass: Sdf, decor: Sdf, dt: number) {
    this.host = host;
    this.glass = glass;
    this.decor = decor;
    this.dt = dt;
    const n = host.count;
    this._attached = new Uint8Array(n);
    this._normal = new Float64Array(n * 3);
    this._up = new Float64Array(n * 3);
    this._heading = new Float64Array(n * 3);
    this._legPhase = new Float64Array(n);
    this._flip = new Float64Array(n);
    this.flipLeft = new Float64Array(n);
    this.flipFrom = new Float64Array(n).fill(-1);
    this.flipDir = new Float64Array(n * 3);
    this.velocity = new Float64Array(n * 3);
    this.wander = new Float64Array(n);
    this.blocked = new Uint16Array(n);
  }

  resize(edit: FishResize): void {
    this._attached = edit.array(this.attached);
    this._normal = edit.array(this.normal, 3);
    this._up = edit.array(this.up, 3);
    this._heading = edit.array(this.heading, 3);
    this._legPhase = edit.array(this.legPhase);
    this._flip = edit.array(this.flip);
    this.flipLeft = edit.array(this.flipLeft);
    this.flipFrom = edit.array(this.flipFrom, 1, -1);
    this.flipDir = edit.array(this.flipDir, 3);
    this.velocity = edit.array(this.velocity, 3);
    this.wander = edit.array(this.wander);
    this.blocked = edit.array(this.blocked);
  }

  /**
   * Sets walker `i` down from its spawn spot: onto the nearest surface it can stand on, else onto
   * the ground below; failing both it starts sinking. Draws nothing from the RNG.
   */
  place(i: number): void {
    const o = i * 3;
    const yaw = at(this.host.yaw, i);
    this.heading.set([Math.sin(yaw), 0, Math.cos(yaw)], o);
    this.up.set([0, 1, 0], o);
    this.normal.set([0, 1, 0], o);
    this.velocity.fill(0, o, o + 3);
    this.attached[i] = 0;
    this.legPhase[i] = 0;
    this.flip[i] = 0;
    this.flipLeft[i] = 0;
    this.flipFrom[i] = -1;
    this.wander[i] = 0;
    this.blocked[i] = 0;
    this.host.speed[i] = 0;
    const w = this.walkingOf(i);
    const length = at(this.host.bodyLength, i);
    this.project(i, WALK.spawnProjectionPasses);
    if (this.surfaceNormal(i, w) <= 0) {
      const { position, basin } = this.host;
      const x = at(position, o);
      const z = at(position, o + 2);
      position[o + 1] = basin.ground(x, z) + length;
      this.project(i, WALK.spawnProjectionPasses);
    }
    if (this.surfaceNormal(i, w) > 0) {
      this.attach(i);
      this.up.set(this.n, o);
      this.orthonormalUp(i);
    }
    this.backstop(i);
    this.pose(i);
    this.host.state[i] = this.attached[i] === 1 ? FishState.Walk : FishState.Fall;
  }

  /** Advances walker `i` one step; returns whether the hard-body constraint had to move it. */
  step(i: number, plan: Plan, startledAt: number): boolean {
    const w = this.walkingOf(i);
    const o = i * 3;
    const b = this.before;
    b.set(this.host.position.subarray(o, o + 3), 0);
    b.set(this.heading.subarray(o, o + 3), 3);
    b.set(this.up.subarray(o, o + 3), 6);
    b.set(this.normal.subarray(o, o + 3), 9);
    const wasAttached = at(this.attached, i);
    if (plan.state === FishState.TailFlip && at(this.flipFrom, i) !== startledAt) {
      this.beginFlip(i, w, plan, startledAt);
    }
    let contact: boolean;
    let state: FishState;
    if (at(this.flipLeft, i) > 0) {
      contact = this.flipStep(i, w);
      state = FishState.TailFlip;
    } else if (this.attached[i] === 1) {
      this.flip[i] = 0;
      contact = this.walkStep(i, w, plan);
      state = this.attached[i] === 1 ? this.attachedState(plan) : FishState.Fall;
    } else {
      this.flip[i] = 0;
      contact = this.fallStep(i, w);
      state = this.attached[i] === 1 ? this.attachedState(plan) : FishState.Fall;
    }
    if (contact && this.clearance(i) < -PENETRATION_EPSILON) {
      // Pushed back and forth between two surfaces (sand and rock meeting in a crease): keep the
      // last valid pose rather than one inside either, and turn away from the push so the next
      // step does not walk into the same wedge.
      const pushX = at(this.g, 0);
      const pushY = at(this.g, 1);
      const pushZ = at(this.g, 2);
      this.host.position.set(b.subarray(0, 3), o);
      this.heading.set(b.subarray(3, 6), o);
      this.up.set(b.subarray(6, 9), o);
      this.normal.set(b.subarray(9, 12), o);
      if (this.attached[i] === 1 && wasAttached === 1) {
        this.host.speed[i] = 0;
        this.turnAway(i, pushX, pushY, pushZ);
        const blocked = at(this.blocked, i) + 1;
        this.blocked[i] = blocked;
        // Wedged for good: let go and sink, which lands it on whatever lies below.
        if (blocked * this.dt >= WALK.wedgedS) {
          this.letGo(i, 0);
          state = FishState.Fall;
        }
      }
    } else {
      this.blocked[i] = 0;
    }
    this.host.state[i] = state;
    this.pose(i);
    return contact;
  }

  /**
   * Turns walker `i` about its normal by one step of its turn rate, towards the side the push
   * (px, py, pz) came from first, keeping the first heading that leaves its body clear.
   */
  private turnAway(i: number, px: number, py: number, pz: number): void {
    const o = i * 3;
    const nx = at(this.normal, o);
    const ny = at(this.normal, o + 1);
    const nz = at(this.normal, o + 2);
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    const lx = ny * hz - nz * hy;
    const ly = nz * hx - nx * hz;
    const lz = nx * hy - ny * hx;
    const angle = this.host.speciesOf(i).maxTurnRate * this.dt;
    const first = px * lx + py * ly + pz * lz >= 0 ? 1 : -1;
    for (const side of [first, -first]) {
      const c = Math.cos(angle * side);
      const sn = Math.sin(angle * side);
      this.heading[o] = hx * c + lx * sn;
      this.heading[o + 1] = hy * c + ly * sn;
      this.heading[o + 2] = hz * c + lz * sn;
      if (this.clearance(i) >= -PENETRATION_EPSILON) {
        this.orthonormalUp(i);
        return;
      }
    }
    this.heading[o] = hx;
    this.heading[o + 1] = hy;
    this.heading[o + 2] = hz;
  }

  /** Smallest distance from walker `i`'s spine to the tank or hard decor, minus its thickness. */
  private clearance(i: number): number {
    const { position, bodyLength, thickness, sceneSdf } = this.host;
    const o = i * 3;
    const length = at(bodyLength, i);
    let worst = Infinity;
    for (const offset of BEHAVIOUR.bodySampleOffsets) {
      const k = offset * length;
      const d = sceneSdf.sample(
        at(position, o) + at(this.heading, o) * k,
        at(position, o + 1) + at(this.heading, o + 1) * k,
        at(position, o + 2) + at(this.heading, o + 2) * k,
        this.scratch,
      );
      worst = Math.min(worst, d);
    }
    return worst - at(thickness, i);
  }

  /** Writes walker `i`'s orientation, body up along the surface normal, as a quaternion. */
  quaternion(i: number, out: Float32Array, o: number): void {
    const [f, u] = this.basis;
    if (f === undefined || u === undefined) throw new Error('basis scratch missing');
    const k = i * 3;
    for (let c = 0; c < 3; c++) {
      f[c] = at(this.heading, k + c);
      u[c] = at(this.up, k + c);
    }
    quatFromBasis(f, u, out, o);
  }

  private attachedState(plan: Plan): FishState {
    return plan.state === FishState.TailFlip ? FishState.Shelter : plan.state;
  }

  private walkingOf(i: number): SimWalking {
    const w = this.host.speciesOf(i).walking;
    if (w === null) throw new RangeError(`fish ${i} is not a walker`);
    return w;
  }

  private standoff(i: number): number {
    return WALK.standoffBodyLengths * at(this.host.bodyLength, i);
  }

  /**
   * Smallest substrate distance along walker `i`'s spine, with the gradient there in `g`. With
   * `footing`, only surfaces facing roughly the way of the one it stands on count (any, if none
   * does): in a crease between floor and wall, the wall behind it must not pull it back.
   */
  private spine(i: number, footing = false): number {
    const { position, bodyLength, substrateSdf } = this.host;
    const o = i * 3;
    const length = at(bodyLength, i);
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    const nx = at(this.normal, o);
    const ny = at(this.normal, o + 1);
    const nz = at(this.normal, o + 2);
    const s = this.scratch;
    let best = Infinity;
    let bestFooting = Infinity;
    for (const offset of BEHAVIOUR.bodySampleOffsets) {
      const k = offset * length;
      const d = substrateSdf.sample(
        at(position, o) + hx * k,
        at(position, o + 1) + hy * k,
        at(position, o + 2) + hz * k,
        s,
      );
      if (footing && d < bestFooting) {
        const facing = at(s, 0) * nx + at(s, 1) * ny + at(s, 2) * nz;
        if (facing >= WALK.footingCos) {
          bestFooting = d;
          this.probe.set(s);
        }
      }
      if (d < best) {
        best = d;
        this.g.set(s);
      }
    }
    if (bestFooting === Infinity) return best;
    this.g.set(this.probe);
    return bestFooting;
  }

  /** Moves walker `i` until the nearest point of its spine sits at the stand-off. */
  private project(i: number, passes: number, footing = false): number {
    const { position } = this.host;
    const o = i * 3;
    const s = this.standoff(i);
    const tolerance = 1e-4 * at(this.host.bodyLength, i);
    let d = this.spine(i, footing);
    for (let pass = 0; pass < passes && Math.abs(s - d) > tolerance; pass++) {
      const e = s - d;
      position[o] = at(position, o) + at(this.g, 0) * e;
      position[o + 1] = at(position, o + 1) + at(this.g, 1) * e;
      position[o + 2] = at(position, o + 2) + at(this.g, 2) * e;
      d = this.spine(i, footing);
    }
    return d;
  }

  /**
   * Averages the normals of the walkable surfaces near walker `i`'s spine into `n`, nearer ones
   * weighing more, so a body reaching a wall tips up it and one over an edge tips down it.
   * Returns the total weight, 0 when nothing walkable is in reach.
   */
  private surfaceNormal(i: number, w: SimWalking): number {
    const { position, bodyLength, substrateSdf } = this.host;
    const o = i * 3;
    const length = at(bodyLength, i);
    const s = this.standoff(i);
    const reach = WALK.normalReachBodyLengths * length;
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    const g = this.scratch;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let total = 0;
    for (const offset of BEHAVIOUR.bodySampleOffsets) {
      const k = offset * length;
      const x = at(position, o) + hx * k;
      const y = at(position, o + 1) + hy * k;
      const z = at(position, o + 2) + hz * k;
      const d = substrateSdf.sample(x, y, z, g);
      if (d - s >= reach) continue;
      const gx = at(g, 0);
      const gy = at(g, 1);
      const gz = at(g, 2);
      if (!this.walkable(w, x, y, z, d, gy)) continue;
      const weight = 1 - Math.max(0, d - s) / reach;
      nx += gx * weight;
      ny += gy * weight;
      nz += gz * weight;
      total += weight;
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return 0;
    this.n[0] = nx / l;
    this.n[1] = ny / l;
    this.n[2] = nz / l;
    return total;
  }

  /** Whether the surface nearest (x, y, z), `d` away with normal y-component `gy`, may be walked. */
  private walkable(w: SimWalking, x: number, y: number, z: number, d: number, gy: number): boolean {
    if (gy >= WALK.groundCos) return true;
    if (gy < -WALK.overhangSin) return false;
    const slack = 1e-6;
    if (!w.glass && this.glass.sample(x, y, z, this.probe) <= d + slack) return false;
    if (!w.decor && this.decor.sample(x, y, z, this.probe) <= d + slack) return false;
    return true;
  }

  private attach(i: number): void {
    const o = i * 3;
    this.attached[i] = 1;
    this.normal.set(this.n, o);
    this.velocity.fill(0, o, o + 3);
    this.host.speed[i] = 0;
    this.tangentHeading(i);
    // Levelling the heading moves the spine's nearest point; settle the body back to the stand-off.
    this.project(i, WALK.projectionPasses);
  }

  /** Projects walker `i`'s heading onto the plane of its normal. */
  private tangentHeading(i: number): void {
    const o = i * 3;
    const nx = at(this.normal, o);
    const ny = at(this.normal, o + 1);
    const nz = at(this.normal, o + 2);
    let hx = at(this.heading, o);
    let hy = at(this.heading, o + 1);
    let hz = at(this.heading, o + 2);
    const dot = hx * nx + hy * ny + hz * nz;
    hx -= dot * nx;
    hy -= dot * ny;
    hz -= dot * nz;
    let l = Math.hypot(hx, hy, hz);
    if (l < 1e-6) {
      // Heading straight into the surface: take the old up, else any axis, flattened onto it.
      const ux = at(this.up, o);
      const uy = at(this.up, o + 1);
      const uz = at(this.up, o + 2);
      const along = ux * nx + uy * ny + uz * nz;
      hx = ux - along * nx;
      hy = uy - along * ny;
      hz = uz - along * nz;
      l = Math.hypot(hx, hy, hz);
      if (l < 1e-6) {
        const a = Math.abs(nx) < 0.9 ? 1 : 0;
        const b = a === 1 ? 0 : 1;
        hx = a - nx * (a * nx + b * nz);
        hy = -ny * (a * nx + b * nz);
        hz = b - nz * (a * nx + b * nz);
        l = Math.hypot(hx, hy, hz);
      }
    }
    this.heading[o] = hx / l;
    this.heading[o + 1] = hy / l;
    this.heading[o + 2] = hz / l;
  }

  /** Makes walker `i`'s up perpendicular to its heading, keeping its side; world up if degenerate. */
  private orthonormalUp(i: number): void {
    const o = i * 3;
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    let ux = at(this.up, o);
    let uy = at(this.up, o + 1);
    let uz = at(this.up, o + 2);
    let dot = ux * hx + uy * hy + uz * hz;
    ux -= dot * hx;
    uy -= dot * hy;
    uz -= dot * hz;
    let l = Math.hypot(ux, uy, uz);
    if (l < 1e-6) {
      const ax = Math.abs(hy) < 0.9 ? 0 : 1;
      const ay = 1 - ax;
      dot = ax * hx + ay * hy;
      ux = ax - dot * hx;
      uy = ay - dot * hy;
      uz = -dot * hz;
      l = Math.hypot(ux, uy, uz);
    }
    this.up[o] = ux / l;
    this.up[o + 1] = uy / l;
    this.up[o + 2] = uz / l;
  }

  private walkStep(i: number, w: SimWalking, plan: Plan): boolean {
    const { position, bodyLength, distSq, rng, basin } = this.host;
    const dt = this.dt;
    const o = i * 3;
    const sp = this.host.speciesOf(i);
    const length = at(bodyLength, i);
    const s = this.standoff(i);
    const px = at(position, o);
    const py = at(position, o + 1);
    const pz = at(position, o + 2);
    const nx = at(this.normal, o);
    const ny = at(this.normal, o + 1);
    const nz = at(this.normal, o + 2);
    let hx = at(this.heading, o);
    let hy = at(this.heading, o + 1);
    let hz = at(this.heading, o + 2);
    // n × h: the heading turned a quarter left about the normal.
    const lx = ny * hz - nz * hy;
    const ly = nz * hx - nx * hz;
    const lz = nx * hy - ny * hx;

    const tau = WALK.wanderTurnTauS;
    const wt =
      at(this.wander, i) * (1 - dt / tau) +
      WALK.wanderTurnSdRadPerS * Math.sqrt((2 * dt) / tau) * rng.gaussian();
    this.wander[i] = wt;
    const wa = wt * WALK.wanderLookaheadS;
    const wander = plan.wander;
    let dx = (hx * Math.cos(wa) + lx * Math.sin(wa)) * wander;
    let dy = (hy * Math.cos(wa) + ly * Math.sin(wa)) * wander;
    let dz = (hz * Math.cos(wa) + lz * Math.sin(wa)) * wander;

    if (plan.seekWeight > 0) {
      const sx = plan.seekX - px;
      const sy = plan.seekY - py;
      const sz = plan.seekZ - pz;
      const d = Math.hypot(sx, sy, sz);
      if (d > 1e-9) {
        const k = (WALK.seekWeight * plan.seekWeight) / d;
        dx += sx * k;
        dy += sy * k;
        dz += sz * k;
        // A goal out in the water off a wall is reached by climbing down the wall and walking
        // over the floor; heading along the wall towards it would leave the walker pressed there.
        const off = (sx * nx + sy * ny + sz * nz) / d;
        if (ny < WALK.groundCos && off > 0) dy -= WALK.seekWeight * plan.seekWeight * off;
      }
    }

    const n = this.host.count;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const zone = 0.5 * (length + at(bodyLength, j)) * WALK.separationBodyLengths;
      const d2 = at(distSq, i * n + j);
      if (d2 >= zone * zone) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-9) continue;
      const k = (WALK.separationWeight * (zone - d)) / (zone * d);
      dx += (px - at(position, j * 3)) * k;
      dy += (py - at(position, j * 3 + 1)) * k;
      dz += (pz - at(position, j * 3 + 2)) * k;
    }

    const topMargin = WALK.topMarginBodyLengths * length;
    const gap = basin.maxY - py;
    if (gap < topMargin) dy -= WALK.topWeight * (1 - gap / topMargin);

    const probe = WALK.probeBodyLengths * length;
    const qx = px + hx * probe;
    const qy = py + hy * probe;
    const qz = pz + hz * probe;
    const g = this.probe;
    const dq = this.host.substrateSdf.sample(qx, qy, qz, g);
    if (dq < s + WALK.forbiddenReachBodyLengths * length) {
      const gx = at(g, 0);
      const gy = at(g, 1);
      const gz = at(g, 2);
      // A surface ahead facing back at the one underfoot (a rock resting on the glass) closes
      // into a crack thinner than the body; walking on into it only wedges the walker there.
      const closing = gx * nx + gy * ny + gz * nz < -WALK.footingCos;
      if (closing || !this.walkable(w, qx, qy, qz, dq, gy)) {
        dx += gx * WALK.forbiddenWeight;
        dy += gy * WALK.forbiddenWeight;
        dz += gz * WALK.forbiddenWeight;
      }
    }

    const along = dx * nx + dy * ny + dz * nz;
    dx -= along * nx;
    dy -= along * ny;
    dz -= along * nz;
    let rate = 0;
    if (Math.hypot(dx, dy, dz) > 1e-9) {
      const angle = Math.atan2(dx * lx + dy * ly + dz * lz, dx * hx + dy * hy + dz * hz);
      rate = clamp(angle * WALK.turnGainPerS, -sp.maxTurnRate, sp.maxTurnRate);
      const c = Math.cos(rate * dt);
      const sn = Math.sin(rate * dt);
      hx = hx * c + lx * sn;
      hy = hy * c + ly * sn;
      hz = hz * c + lz * sn;
      this.heading[o] = hx;
      this.heading[o + 1] = hy;
      this.heading[o + 2] = hz;
    }
    this.host.yawRate[i] = rate;
    this.host.pitchRate[i] = 0;

    const scale = length / sp.bodyLength;
    const walk = w.walkSpeed * scale;
    let target = Math.min(walk * plan.cruiseScale, plan.speedCap);
    if (plan.seekWeight > 0) {
      const mouth = WALK.mouthBodyLengths * length;
      const dm = Math.hypot(
        plan.seekX - (px + hx * mouth),
        plan.seekY - (py + hy * mouth),
        plan.seekZ - (pz + hz * mouth),
      );
      target *= clamp(dm / (WALK.arrivalBodyLengths * length), WALK.arrivalSpeedFloor, 1);
    }
    let v = at(this.host.speed, i);
    v = Math.max(0, v + (target - v) * Math.min(1, dt / WALK.speedResponseS));
    position[o] = px + hx * v * dt;
    position[o + 1] = py + hy * v * dt;
    position[o + 2] = pz + hz * v * dt;
    this.host.speed[i] = v;
    this.host.thrust[i] = walk > 0 ? clamp(v / walk, 0, 1) : 0;

    if (this.spine(i, true) - s > WALK.gripLossBodyLengths * length) {
      this.letGo(i, v);
      return this.backstop(i);
    }
    this.project(i, WALK.projectionPasses, true);
    if (this.surfaceNormal(i, w) <= 0) {
      this.letGo(i, v);
      return this.backstop(i);
    }
    this.transport(i);
    this.smoothUp(i);
    this.stance(i);
    const stride = w.strideBodyLengths * length;
    const phase = at(this.legPhase, i) + (v * dt) / stride;
    this.legPhase[i] = phase - Math.floor(phase);
    return this.backstop(i);
  }

  /**
   * Carries walker `i`'s heading from its old surface normal to the new one in `n` by the
   * rotation between them, so it keeps going the same way over an edge or up a wall.
   */
  private transport(i: number): void {
    const o = i * 3;
    const ax = at(this.normal, o);
    const ay = at(this.normal, o + 1);
    const az = at(this.normal, o + 2);
    const bx = at(this.n, 0);
    const by = at(this.n, 1);
    const bz = at(this.n, 2);
    const c = ax * bx + ay * by + az * bz;
    if (c > -0.999) {
      // Rodrigues with an unnormalised axis k = a × b: v' = v·c + k × v + k (k·v) / (1 + c).
      const kx = ay * bz - az * by;
      const ky = az * bx - ax * bz;
      const kz = ax * by - ay * bx;
      const hx = at(this.heading, o);
      const hy = at(this.heading, o + 1);
      const hz = at(this.heading, o + 2);
      const kv = (kx * hx + ky * hy + kz * hz) / (1 + c);
      this.heading[o] = hx * c + (ky * hz - kz * hy) + kx * kv;
      this.heading[o + 1] = hy * c + (kz * hx - kx * hz) + ky * kv;
      this.heading[o + 2] = hz * c + (kx * hy - ky * hx) + kz * kv;
    }
    this.normal.set(this.n, o);
    this.tangentHeading(i);
  }

  private smoothUp(i: number): void {
    const o = i * 3;
    const k = Math.min(1, this.dt / WALK.upSmoothingS);
    for (let c = 0; c < 3; c++) {
      const u = at(this.up, o + c);
      this.up[o + c] = u + (at(this.normal, o + c) - u) * k;
    }
    this.orthonormalUp(i);
  }

  private letGo(i: number, v: number): void {
    const o = i * 3;
    this.attached[i] = 0;
    for (let c = 0; c < 3; c++) this.velocity[o + c] = at(this.heading, o + c) * v;
  }

  private beginFlip(i: number, w: SimWalking, plan: Plan, startledAt: number): void {
    const { position } = this.host;
    const o = i * 3;
    const on = this.attached[i] === 1;
    const nx = on ? at(this.normal, o) : 0;
    const ny = on ? at(this.normal, o + 1) : 1;
    const nz = on ? at(this.normal, o + 2) : 0;
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    let ax = plan.seekX - at(position, o);
    let az = plan.seekZ - at(position, o + 2);
    const al = Math.hypot(ax, az);
    if (plan.seekWeight > 0 && al > 1e-9) {
      ax /= al;
      az /= al;
    } else {
      ax = 0;
      az = 0;
    }
    // The abdomen's flexion throws the animal backwards, tail first, off the surface.
    let ex = -hx + ax + WALK.flipUpShare * nx;
    let ey = -hy + WALK.flipUpShare * ny;
    let ez = -hz + az + WALK.flipUpShare * nz;
    let l = Math.hypot(ex, ey, ez);
    if (l < 1e-6) {
      ex = nx;
      ey = ny;
      ez = nz;
      l = 1;
    }
    this.flipDir[o] = ex / l;
    this.flipDir[o + 1] = ey / l;
    this.flipDir[o + 2] = ez / l;
    this.flipFrom[i] = startledAt;
    this.flipLeft[i] = w.flipDurationS;
    this.attached[i] = 0;
    this.velocity.fill(0, o, o + 3);
  }

  private flipStep(i: number, w: SimWalking): boolean {
    const { position, bodyLength } = this.host;
    const dt = this.dt;
    const o = i * 3;
    const sp = this.host.speciesOf(i);
    const duration = w.flipDurationS;
    const left = at(this.flipLeft, i);
    const mid = clamp((duration - left + 0.5 * dt) / duration, 0, 1);
    const scale = at(bodyLength, i) / sp.bodyLength;
    const v = Math.min(w.flipPeak * scale, at(this.host.maxSpeed, i)) * Math.sin(Math.PI * mid);
    let ex = at(this.flipDir, o);
    let ey = at(this.flipDir, o + 1);
    let ez = at(this.flipDir, o + 2);
    position[o] = at(position, o) + ex * v * dt;
    position[o + 1] = at(position, o + 1) + ey * v * dt;
    position[o + 2] = at(position, o + 2) + ez * v * dt;

    const k = Math.min(1, dt / (WALK.flipTurnShare * duration));
    let hx = at(this.heading, o) + (-ex - at(this.heading, o)) * k;
    let hy = at(this.heading, o + 1) + (-ey - at(this.heading, o + 1)) * k;
    let hz = at(this.heading, o + 2) + (-ez - at(this.heading, o + 2)) * k;
    const hl = Math.hypot(hx, hy, hz);
    if (hl < 1e-6) {
      hx = -ex;
      hy = -ey;
      hz = -ez;
    } else {
      hx /= hl;
      hy /= hl;
      hz /= hl;
    }
    this.heading[o] = hx;
    this.heading[o + 1] = hy;
    this.heading[o + 2] = hz;
    this.orthonormalUp(i);

    const contact = this.backstop(i);
    if (contact) {
      // Glancing off glass or rock: keep only the part of the escape along the surface.
      const into = ex * at(this.g, 0) + ey * at(this.g, 1) + ez * at(this.g, 2);
      if (into < 0) {
        ex -= into * at(this.g, 0);
        ey -= into * at(this.g, 1);
        ez -= into * at(this.g, 2);
        const l = Math.hypot(ex, ey, ez);
        if (l > 1e-6) {
          this.flipDir[o] = ex / l;
          this.flipDir[o + 1] = ey / l;
          this.flipDir[o + 2] = ez / l;
        }
      }
    }
    const remaining = Math.max(0, left - dt);
    this.flipLeft[i] = remaining;
    const progress = clamp(1 - remaining / duration, 0, 1);
    this.flip[i] = progress;
    this.host.speed[i] = v;
    this.host.yawRate[i] = 0;
    this.host.pitchRate[i] = 0;
    this.host.thrust[i] = Math.sin(Math.PI * progress);
    if (remaining <= 0) {
      for (let c = 0; c < 3; c++) this.velocity[o + c] = at(this.flipDir, o + c) * v;
    }
    return contact;
  }

  private fallStep(i: number, w: SimWalking): boolean {
    const { position, bodyLength } = this.host;
    const dt = this.dt;
    const o = i * 3;
    const k = Math.min(1, dt / WALK.sinkTauS);
    const vx = at(this.velocity, o) * (1 - k);
    const vy = at(this.velocity, o + 1) + (-WALK.sinkSpeedMps - at(this.velocity, o + 1)) * k;
    const vz = at(this.velocity, o + 2) * (1 - k);
    position[o] = at(position, o) + vx * dt;
    position[o + 1] = at(position, o + 1) + vy * dt;
    position[o + 2] = at(position, o + 2) + vz * dt;
    this.velocity[o] = vx;
    this.velocity[o + 1] = vy;
    this.velocity[o + 2] = vz;
    for (let c = 0; c < 3; c++) {
      const u = at(this.up, o + c);
      this.up[o + c] = u + ((c === 1 ? 1 : 0) - u) * Math.min(1, dt / WALK.upSmoothingS);
    }
    this.orthonormalUp(i);
    const contact = this.backstop(i);
    if (contact) {
      const into = vx * at(this.g, 0) + vy * at(this.g, 1) + vz * at(this.g, 2);
      if (into < 0) {
        for (let c = 0; c < 3; c++) {
          this.velocity[o + c] = at(this.velocity, o + c) - into * at(this.g, c);
        }
      }
    }
    this.host.speed[i] = Math.hypot(
      at(this.velocity, o),
      at(this.velocity, o + 1),
      at(this.velocity, o + 2),
    );
    this.host.yawRate[i] = 0;
    this.host.pitchRate[i] = 0;
    this.host.thrust[i] = 0;
    const slack = WALK.attachSlackBodyLengths * at(bodyLength, i);
    if (this.spine(i) <= this.standoff(i) + slack) {
      this.landing.set(position.subarray(o, o + 3));
      this.project(i, WALK.projectionPasses);
      if (this.surfaceNormal(i, w) > 0) {
        this.attach(i);
        this.smoothUp(i);
      } else {
        position.set(this.landing, o);
      }
      return this.backstop(i) || contact;
    }
    return contact;
  }

  /**
   * The legs hold walker `i`'s spine at the stand-off from every surface it nears, not only the
   * one underfoot: tipping up a wall out of a crease, or turning beside a rock while picking,
   * would otherwise swing a body end into the other surface.
   */
  private stance(i: number): void {
    const { position, bodyLength, sceneSdf } = this.host;
    const o = i * 3;
    const length = at(bodyLength, i);
    const s = this.standoff(i);
    const tolerance = 1e-4 * length;
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    const g = this.scratch;
    for (let pass = 0; pass < WALK.projectionPasses; pass++) {
      let worst = tolerance;
      let wx = 0;
      let wy = 0;
      let wz = 0;
      const px = at(position, o);
      const py = at(position, o + 1);
      const pz = at(position, o + 2);
      for (const offset of BEHAVIOUR.bodySampleOffsets) {
        const k = offset * length;
        const d = sceneSdf.sample(px + hx * k, py + hy * k, pz + hz * k, g);
        if (s - d > worst) {
          worst = s - d;
          wx = at(g, 0);
          wy = at(g, 1);
          wz = at(g, 2);
        }
      }
      if (worst <= tolerance) return;
      position[o] = px + wx * worst;
      position[o + 1] = py + wy * worst;
      position[o + 2] = pz + wz * worst;
    }
  }

  /**
   * Pushes walker `i`'s spine out of the tank and hard decor; the last push normal is left in
   * `g`. Returns whether it had to move.
   */
  private backstop(i: number): boolean {
    const { position, bodyLength, thickness, sceneSdf } = this.host;
    const o = i * 3;
    const length = at(bodyLength, i);
    const t = at(thickness, i) + PENETRATION_EPSILON;
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    const s = this.scratch;
    let moved = false;
    for (let pass = 0; pass < MAX_BODY_PUSHES; pass++) {
      let worst = 0;
      let wx = 0;
      let wy = 0;
      let wz = 0;
      const px = at(position, o);
      const py = at(position, o + 1);
      const pz = at(position, o + 2);
      for (const offset of BEHAVIOUR.bodySampleOffsets) {
        const k = offset * length;
        const d = sceneSdf.sample(px + hx * k, py + hy * k, pz + hz * k, s);
        if (t - d > worst) {
          worst = t - d;
          wx = at(s, 0);
          wy = at(s, 1);
          wz = at(s, 2);
        }
      }
      if (worst <= 0) break;
      position[o] = px + wx * worst;
      position[o + 1] = py + wy * worst;
      position[o + 2] = pz + wz * worst;
      this.g[0] = wx;
      this.g[1] = wy;
      this.g[2] = wz;
      moved = true;
    }
    return moved;
  }

  /** Keeps yaw and pitch in step with the heading, for code that reads a fish's pose from them. */
  private pose(i: number): void {
    const o = i * 3;
    const hx = at(this.heading, o);
    const hy = at(this.heading, o + 1);
    const hz = at(this.heading, o + 2);
    this.host.yaw[i] = Math.atan2(hx, hz);
    this.host.pitch[i] = Math.asin(clamp(hy, -1, 1));
    this.host.roll[i] = 0;
  }
}
