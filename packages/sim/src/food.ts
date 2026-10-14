import type { FoodType } from '@aquarium/shared';
import { basinOf, type Basin, type TankDimensions } from './basin.ts';
import { clamp } from './math.ts';

/**
 * The `lifecycle.diet` vocabulary in the order of `foodTypeSchema` in packages/shared; a food
 * particle's `typeIndex` indexes this list. Kept as a literal so the worker needs no zod at
 * runtime; a test pins it to the shared enum.
 */
export const FOOD_TYPES = [
  'flakes',
  'pellets',
  'bloodworms',
  'brine-shrimp',
  'nori',
  'algae-wafer',
] as const satisfies readonly FoodType[];

/** Floats per particle in a food buffer: id, x, y, z, typeIndex. */
export const FOOD_STRIDE = 5;
export const FoodField = { Id: 0, X: 1, Y: 2, Z: 3, Type: 4 } as const;
export const MAX_FOOD_PARTICLES = 1024;
/** Ids travel as float32, which holds every integer below 2^24 exactly. */
export const MAX_FOOD_ID = 2 ** 24 - 1;

/**
 * What one particle of each food type carries, in the feed portions of the lifecycle model, and
 * how many fish can eat from it at once. Gameplay spawns `portion / particlePortion` particles per
 * feed action, so the `ate` portions of a fully eaten drop add up to what was fed. Items fed on by
 * several fish at once (a nori clip, a sinking wafer) are rasped in small bites; the rest are
 * swallowed whole.
 */
export const FOOD_PARTICLES: Readonly<
  Record<(typeof FOOD_TYPES)[number], { readonly portion: number; readonly feeders: number }>
> = {
  flakes: { portion: 0.025, feeders: 1 },
  pellets: { portion: 0.05, feeders: 1 },
  bloodworms: { portion: 0.05, feeders: 1 },
  'brine-shrimp': { portion: 0.02, feeders: 1 },
  nori: { portion: 0.5, feeders: 3 },
  'algae-wafer': { portion: 0.5, feeders: 4 },
};

export const MAX_FEEDERS = 4;

export interface AteEvent {
  readonly fishId: string;
  readonly foodId: number;
  /** Feed portions eaten in this bite. */
  readonly portion: number;
}

const CELL_M = 0.1;
const DT = 1 / 30;
const SPEED_SMOOTHING_S = 0.3;

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

/**
 * The food particles gameplay last reported, bucketed in a uniform grid for range queries. The
 * sim never moves food; it only estimates each particle's speed from successive reports and keeps
 * track of how much of each particle fish have eaten, so a particle the client has not yet removed
 * is never eaten twice.
 */
export class FoodStore {
  count = 0;
  readonly id = new Int32Array(MAX_FOOD_PARTICLES);
  readonly position = new Float64Array(MAX_FOOD_PARTICLES * 3);
  readonly type = new Uint8Array(MAX_FOOD_PARTICLES);
  /** Sand height under each particle. */
  readonly ground = new Float64Array(MAX_FOOD_PARTICLES);
  /** Smoothed particle speed in m/s; sinking and drifting food is more salient. */
  readonly speed = new Float64Array(MAX_FOOD_PARTICLES);
  readonly eaten = new Float64Array(MAX_FOOD_PARTICLES);

  private readonly basin: Basin;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly cellStart: Int32Array;
  private readonly cellOf = new Int32Array(MAX_FOOD_PARTICLES);
  private readonly items = new Int32Array(MAX_FOOD_PARTICLES);

  // Three id → slot maps rotate between the current report, the speed reference and the one
  // being built, so a report at 30 Hz allocates nothing.
  private readonly indexMaps = [
    new Map<number, number>(),
    new Map<number, number>(),
    new Map<number, number>(),
  ] as const;
  private index: Map<number, number> = this.indexMaps[0];
  private ref: Map<number, number> = this.indexMaps[1];
  private eatenById = new Map<number, number>();
  private eatenSpare = new Map<number, number>();
  private readonly seen = new Set<number>();
  private lastTick = -1;
  private refTick = -1;
  private readonly refPosition = new Float64Array(MAX_FOOD_PARTICLES * 3);
  private readonly lastPosition = new Float64Array(MAX_FOOD_PARTICLES * 3);
  private readonly lastSpeed = new Float64Array(MAX_FOOD_PARTICLES);
  private readonly arrivals = new Float64Array(4);

  constructor(tank: Basin | TankDimensions) {
    const basin = basinOf(tank);
    this.basin = basin;
    this.nx = Math.max(1, Math.ceil(basin.width / CELL_M));
    this.ny = Math.max(1, Math.ceil(basin.height / CELL_M));
    this.nz = Math.max(1, Math.ceil(basin.depth / CELL_M));
    this.cellStart = new Int32Array(this.nx * this.ny * this.nz + 1);
  }

  /**
   * Replaces the particles with `buffer` (stride `FOOD_STRIDE`). The whole buffer is validated
   * before anything changes, so a malformed one leaves the previous food in place. Positions are
   * clamped into the water, above the sand and below the surface, rather than rejected: physics
   * can let a particle settle a hair into the sand, and one stray particle must not drop all food.
   */
  set(buffer: Float32Array, tick: number): void {
    this.validate(buffer);
    const n = buffer.length / FOOD_STRIDE;
    const last = this.index;
    // A report in a later tick than the last one turns that one into the reference the next
    // speeds are measured against; several reports within one tick share a reference.
    if (tick > this.lastTick && this.lastTick >= 0) {
      this.ref = last;
      this.refTick = this.lastTick;
      this.refPosition.set(this.lastPosition.subarray(0, this.count * 3));
    }
    let index = this.indexMaps[0];
    for (const m of this.indexMaps) {
      if (m !== last && m !== this.ref) index = m;
    }
    index.clear();
    const eatenById = this.eatenSpare;
    eatenById.clear();
    const basin = this.basin;
    const elapsed = (tick - this.refTick) * DT;
    const blend = elapsed > 0 ? 1 - Math.exp(-elapsed / SPEED_SMOOTHING_S) : 0;
    for (let k = 0; k < n; k++) {
      const o = k * FOOD_STRIDE;
      const id = at(buffer, o + FoodField.Id);
      const x = clamp(at(buffer, o + FoodField.X), basin.minX, basin.maxX);
      const z = clamp(at(buffer, o + FoodField.Z), basin.minZ, basin.maxZ);
      const ground = basin.ground(x, z);
      const y = clamp(at(buffer, o + FoodField.Y), ground, basin.maxY);
      index.set(id, k);
      this.ground[k] = ground;
      this.id[k] = id;
      this.position[k * 3] = x;
      this.position[k * 3 + 1] = y;
      this.position[k * 3 + 2] = z;
      this.type[k] = at(buffer, o + FoodField.Type);
      const eaten = this.eatenById.get(id) ?? 0;
      this.eaten[k] = eaten;
      if (eaten > 0) eatenById.set(id, eaten);
      const before = last.get(id);
      if (before === undefined) {
        this.arrivals[0] = at(this.arrivals, 0) + x;
        this.arrivals[1] = at(this.arrivals, 1) + y;
        this.arrivals[2] = at(this.arrivals, 2) + z;
        this.arrivals[3] = at(this.arrivals, 3) + 1;
      }
      const previous = before === undefined ? 0 : at(this.lastSpeed, before);
      const r = this.ref.get(id);
      if (r === undefined || elapsed <= 0) {
        this.speed[k] = previous;
      } else {
        const v =
          Math.hypot(
            x - at(this.refPosition, r * 3),
            y - at(this.refPosition, r * 3 + 1),
            z - at(this.refPosition, r * 3 + 2),
          ) / elapsed;
        this.speed[k] = before === undefined ? v : previous + (v - previous) * blend;
      }
    }
    this.count = n;
    this.index = index;
    this.eatenSpare = this.eatenById;
    this.eatenById = eatenById;
    this.lastTick = tick;
    this.lastPosition.set(this.position.subarray(0, n * 3));
    this.lastSpeed.set(this.speed.subarray(0, n));
    this.rebin();
  }

  /**
   * How many particles were first reported since the last call, writing their mean position to
   * `out`; where food enters the tank, as fish learn it.
   */
  takeArrivals(out: Float64Array): number {
    const n = at(this.arrivals, 3);
    if (n > 0) {
      out[0] = at(this.arrivals, 0) / n;
      out[1] = at(this.arrivals, 1) / n;
      out[2] = at(this.arrivals, 2) / n;
    }
    this.arrivals.fill(0);
    return n;
  }

  indexOf(id: number): number {
    return this.index.get(id) ?? -1;
  }

  /** Feed portions left on particle `k`. */
  remaining(k: number): number {
    const t = FOOD_TYPES[at(this.type, k)];
    return t === undefined ? 0 : Math.max(0, FOOD_PARTICLES[t].portion - at(this.eaten, k));
  }

  feeders(k: number): number {
    const t = FOOD_TYPES[at(this.type, k)];
    return t === undefined ? 0 : FOOD_PARTICLES[t].feeders;
  }

  consume(k: number, portion: number): void {
    const eaten = at(this.eaten, k) + portion;
    this.eaten[k] = eaten;
    this.eatenById.set(at(this.id, k), eaten);
  }

  /** Writes the indices of particles within `r` of a point into `out`; returns how many. */
  near(x: number, y: number, z: number, r: number, out: Int32Array): number {
    if (this.count === 0) return 0;
    const { minX, minY, minZ } = this.basin;
    const x0 = this.cell(x - r - minX, this.nx);
    const x1 = this.cell(x + r - minX, this.nx);
    const y0 = this.cell(y - r - minY, this.ny);
    const y1 = this.cell(y + r - minY, this.ny);
    const z0 = this.cell(z - r - minZ, this.nz);
    const z1 = this.cell(z + r - minZ, this.nz);
    const r2 = r * r;
    let found = 0;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const row = (cx * this.ny + cy) * this.nz;
        const from = at(this.cellStart, row + z0);
        const to = at(this.cellStart, row + z1 + 1);
        for (let s = from; s < to; s++) {
          const k = at(this.items, s);
          const dx = at(this.position, k * 3) - x;
          const dy = at(this.position, k * 3 + 1) - y;
          const dz = at(this.position, k * 3 + 2) - z;
          if (dx * dx + dy * dy + dz * dz <= r2) out[found++] = k;
        }
      }
    }
    return found;
  }

  private cell(v: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.floor(v / CELL_M)));
  }

  /** Counting sort into cells ordered x, y, z, so a z-run of cells is one contiguous slice. */
  private rebin(): void {
    const { minX, minY, minZ } = this.basin;
    const start = this.cellStart;
    start.fill(0);
    for (let k = 0; k < this.count; k++) {
      const c =
        (this.cell(at(this.position, k * 3) - minX, this.nx) * this.ny +
          this.cell(at(this.position, k * 3 + 1) - minY, this.ny)) *
          this.nz +
        this.cell(at(this.position, k * 3 + 2) - minZ, this.nz);
      this.cellOf[k] = c;
      start[c + 1] = at(start, c + 1) + 1;
    }
    for (let c = 1; c < start.length; c++) start[c] = at(start, c) + at(start, c - 1);
    const fill = this.cellOf;
    for (let k = 0; k < this.count; k++) {
      const c = at(fill, k);
      const slot = at(start, c);
      this.items[slot] = k;
      start[c] = slot + 1;
    }
    for (let c = start.length - 1; c > 0; c--) start[c] = at(start, c - 1);
    start[0] = 0;
  }

  private validate(buffer: Float32Array): void {
    if (!(buffer instanceof Float32Array)) {
      throw new TypeError('food: expected a Float32Array of [id, x, y, z, typeIndex] records');
    }
    if (buffer.length % FOOD_STRIDE !== 0) {
      throw new RangeError(
        `food: buffer length ${buffer.length} is not a multiple of the stride ${FOOD_STRIDE}`,
      );
    }
    const n = buffer.length / FOOD_STRIDE;
    if (n > MAX_FOOD_PARTICLES) {
      throw new RangeError(`food: ${n} particles exceeds the cap of ${MAX_FOOD_PARTICLES}`);
    }
    const seen = this.seen;
    seen.clear();
    for (let k = 0; k < n; k++) {
      const o = k * FOOD_STRIDE;
      const id = at(buffer, o + FoodField.Id);
      if (!(Number.isInteger(id) && id >= 0 && id <= MAX_FOOD_ID)) {
        throw new RangeError(`food[${k}]: id must be an integer in [0, ${MAX_FOOD_ID}], got ${id}`);
      }
      if (seen.has(id)) throw new RangeError(`food: particle ids must be unique, ${id} repeats`);
      seen.add(id);
      const x = at(buffer, o + FoodField.X);
      const y = at(buffer, o + FoodField.Y);
      const z = at(buffer, o + FoodField.Z);
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        throw new RangeError(`food ${id}: position must be finite, got [${x}, ${y}, ${z}]`);
      }
      const type = at(buffer, o + FoodField.Type);
      if (!(Number.isInteger(type) && type >= 0 && type < FOOD_TYPES.length)) {
        throw new RangeError(
          `food ${id}: typeIndex must be an integer in [0, ${FOOD_TYPES.length - 1}], got ${type}`,
        );
      }
    }
  }
}
