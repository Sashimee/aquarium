import type { Basin } from './basin.ts';
import type { Sdf } from './sdf.ts';

/** Grid cells across the tank's longest side at most, so a small fish in a big tank stays cheap. */
const MAX_CELLS = 256;
const DIAGONAL = Math.SQRT2;
/**
 * The eight neighbours of a cell. Their order is the tie-break of `toward`: of two neighbours
 * equally far from the hollow, the earlier one here is taken.
 */
const STEPS: readonly (readonly [number, number, number])[] = [
  [-1, 0, 1],
  [1, 0, 1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, -1, DIAGONAL],
  [1, -1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [1, 1, DIAGONAL],
];
/** Water samples per cell length along a line of sight. */
export const SIGHT_SAMPLES_PER_CELL = 2;
/** The cells nearest a fish that are tried for a clear line to it before it is given none. */
export const SIGHT_TRIES = 8;

const SAMPLE_ROOM = 0;
const SEED = 1;
const SEARCH = 2;
const DONE = 3;

/**
 * The shortest way through the water to a hollow, in plan view at one height: the length of the
 * way from every grid cell with `clearance` of water round it, Dijkstra over eight neighbours.
 * A fish behind a pile of rock follows it round by whichever side is open instead of guessing a
 * side from where the hollow faces.
 *
 * A step between two cells is taken only where the water round the two covers the whole step
 * (their room adds up to at least its length), so no step passes through rock. With cells up to
 * √2 × `clearance` across that always holds between open cells; a big tank whose cell-count cap
 * makes the cells coarser loses the steps that would cut a rock's corner instead.
 *
 * The way is found piecemeal by `build`, a bounded amount of work at a time, so that finding many
 * ways at once (after the rock moved, say) is spread over several steps of the sim.
 */
export class Route {
  readonly y: number;
  readonly clearance: number;
  private readonly water: Sdf;
  private readonly hx: number;
  private readonly hz: number;
  private readonly reach: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly room: Float64Array;
  private readonly length: Float64Array;
  private readonly heap: MinHeap;
  private readonly n3 = new Float64Array(3);
  private readonly nearD = new Float64Array(SIGHT_TRIES);
  private readonly nearC = new Int32Array(SIGHT_TRIES);
  private readonly seedX0: number;
  private readonly seedZ0: number;
  private readonly seedW: number;
  private readonly seedCount: number;
  private phase = SAMPLE_ROOM;
  private cursor = 0;
  private sampled = 0;

  constructor(
    basin: Basin,
    water: Sdf,
    x: number,
    y: number,
    z: number,
    reach: number,
    clearance: number,
    cell: number,
  ) {
    this.water = water;
    this.hx = x;
    this.y = y;
    this.hz = z;
    this.reach = reach;
    this.clearance = clearance;
    const span = Math.max(basin.maxX - basin.minX, basin.maxZ - basin.minZ);
    this.cell = Math.max(cell, span / MAX_CELLS);
    this.nx = Math.max(1, Math.floor((basin.maxX - basin.minX) / this.cell));
    this.nz = Math.max(1, Math.floor((basin.maxZ - basin.minZ) / this.cell));
    this.x0 = basin.minX + 0.5 * (basin.maxX - basin.minX - (this.nx - 1) * this.cell);
    this.z0 = basin.minZ + 0.5 * (basin.maxZ - basin.minZ - (this.nz - 1) * this.cell);
    const count = this.nx * this.nz;
    this.room = new Float64Array(count);
    this.length = new Float64Array(count).fill(Infinity);
    this.heap = new MinHeap(this.length);
    const [ix0, ix1] = this.span(x, reach, this.x0, this.nx);
    const [iz0, iz1] = this.span(z, reach, this.z0, this.nz);
    this.seedX0 = ix0;
    this.seedZ0 = iz0;
    this.seedW = Math.max(0, ix1 - ix0 + 1);
    this.seedCount = this.seedW * Math.max(0, iz1 - iz0 + 1);
  }

  get ready(): boolean {
    return this.phase === DONE;
  }

  /**
   * Goes on finding the way for at most `budget` units of work, one per water sample or settled
   * cell, and returns the units spent. A line of sight is never split: with `overrun`, one longer
   * than the whole budget is followed anyway when nothing else was done first, so that the build
   * always gets on; without, nothing more is done this time.
   */
  build(budget: number, overrun = true): number {
    const count = this.nx * this.nz;
    let work = 0;
    while (this.phase === SAMPLE_ROOM) {
      if (this.cursor >= count) {
        this.phase = SEED;
        this.cursor = 0;
        break;
      }
      if (work >= budget) return work;
      const c = this.cursor++;
      this.room[c] = this.water.sample(this.xOf(c), this.y, this.zOf(c), this.n3);
      work++;
    }
    while (this.phase === SEED) {
      if (this.cursor >= this.seedCount) {
        this.phase = SEARCH;
        break;
      }
      const k = this.cursor;
      const c =
        (this.seedZ0 + Math.floor(k / this.seedW)) * this.nx + this.seedX0 + (k % this.seedW);
      const cx = this.xOf(c);
      const cz = this.zOf(c);
      const d = Math.hypot(cx - this.hx, cz - this.hz);
      if (d <= this.reach && (this.room[c] ?? 0) > 0) {
        const cost = this.sightSamples(d);
        if (work + cost > budget && (work > 0 || !overrun)) return work;
        work += cost;
        if (this.inSight(this.hx, this.y, this.hz, cx, this.y, cz)) {
          this.length[c] = d;
          this.heap.push(c);
        }
      }
      this.cursor++;
    }
    while (this.phase === SEARCH) {
      if (work >= budget) return work;
      const c = this.heap.pop();
      if (c < 0) {
        this.phase = DONE;
        break;
      }
      work++;
      const here = this.length[c] ?? Infinity;
      const ix = c % this.nx;
      const iz = (c - ix) / this.nx;
      for (const [dx, dz, w] of STEPS) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const k = jz * this.nx + jx;
        if ((this.room[k] ?? 0) < this.clearance || !this.passable(c, k, w)) continue;
        const via = here + w * this.cell;
        if (via < (this.length[k] ?? Infinity)) {
          this.length[k] = via;
          this.heap.push(k);
        }
      }
    }
    return work;
  }

  /**
   * The point `ahead` along the way from the fish at (x, y, z), or null when no cell within
   * `reach` of it, in its sight, has a way to the hollow (it is over rock, behind it, or in water
   * cut off from the hollow): `from` the cell `entry` gives.
   */
  toward(x: number, y: number, z: number, reach: number, ahead: number): [number, number] | null {
    const c = this.entry(x, y, z, reach);
    return c < 0 ? null : this.from(c, ahead);
  }

  /**
   * The cell the fish at (x, y, z) joins the way by: the one with a way to the hollow nearest it
   * in plan, within `reach` of it and in its sight; -1 if none. Of cells equally near the first in
   * the grid is taken: least z, then least x. Up to `SIGHT_TRIES` lines of sight are followed, so
   * a fish that keeps asking where none is in sight should keep the answer for a while.
   */
  entry(x: number, y: number, z: number, reach: number): number {
    if (this.phase !== DONE) throw new Error('Route.entry: the way is not built yet; build() it');
    return this.nearest(x, y, z, reach);
  }

  /** The point `ahead` along the way from cell `start`, as `entry` gives it. */
  from(start: number, ahead: number): [number, number] {
    if (this.phase !== DONE) throw new Error('Route.from: the way is not built yet; build() it');
    if ((this.length[start] ?? Infinity) === Infinity) {
      throw new Error(`Route.from: cell ${start} has no way to the hollow; take one from entry()`);
    }
    let c = start;
    let gone = 0;
    while (gone < ahead) {
      const ix = c % this.nx;
      const iz = (c - ix) / this.nx;
      let next = -1;
      let best = this.length[c] ?? Infinity;
      let step = 0;
      for (const [dx, dz, w] of STEPS) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const k = jz * this.nx + jx;
        const l = this.length[k] ?? Infinity;
        if (l < best && this.passable(c, k, w)) {
          best = l;
          next = k;
          step = w * this.cell;
        }
      }
      if (next < 0) break;
      c = next;
      gone += step;
    }
    return [this.xOf(c), this.zOf(c)];
  }

  /** Water samples taken along lines of sight, while building and by `entry`, since the start. */
  get sightSamplesTaken(): number {
    return this.sampled;
  }

  private nearest(x: number, y: number, z: number, reach: number): number {
    const [ix0, ix1] = this.span(x, reach, this.x0, this.nx);
    const [iz0, iz1] = this.span(z, reach, this.z0, this.nz);
    const { nearD, nearC } = this;
    let found = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = iz * this.nx + ix;
        if ((this.length[c] ?? Infinity) === Infinity) continue;
        const d = Math.hypot(this.xOf(c) - x, this.zOf(c) - z);
        if (d > reach) continue;
        if (found === SIGHT_TRIES && d >= (nearD[found - 1] ?? Infinity)) continue;
        let k = Math.min(found, SIGHT_TRIES - 1);
        while (k > 0 && (nearD[k - 1] ?? Infinity) > d) {
          nearD[k] = nearD[k - 1] ?? Infinity;
          nearC[k] = nearC[k - 1] ?? -1;
          k--;
        }
        nearD[k] = d;
        nearC[k] = c;
        if (found < SIGHT_TRIES) found++;
      }
    }
    for (let k = 0; k < found; k++) {
      const c = nearC[k] ?? -1;
      if (this.inSight(x, y, z, this.xOf(c), this.y, this.zOf(c))) return c;
    }
    return -1;
  }

  /** Whether the water round cells `a` and `b` covers the step of `w` cells between them. */
  private passable(a: number, b: number, w: number): boolean {
    return (this.room[a] ?? 0) + (this.room[b] ?? 0) >= w * this.cell;
  }

  /**
   * Whether the straight line from (ax, ay, az) to (bx, by, bz) stays in water: every sample along
   * it is in water and each two neighbouring samples' room covers the gap between them, so no rock
   * between samples, however thin, is missed.
   */
  private inSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const distance = Math.hypot(bx - ax, by - ay, bz - az);
    const n = this.sightSamples(distance) - 1;
    const gap = distance / n;
    let prev = this.water.sample(ax, ay, az, this.n3);
    this.sampled++;
    if (prev <= 0) return false;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      this.sampled++;
      const r = this.water.sample(
        ax + (bx - ax) * t,
        ay + (by - ay) * t,
        az + (bz - az) * t,
        this.n3,
      );
      if (r <= 0 || prev + r < gap) return false;
      prev = r;
    }
    return true;
  }

  private sightSamples(distance: number): number {
    return Math.max(1, Math.ceil((SIGHT_SAMPLES_PER_CELL * distance) / this.cell)) + 1;
  }

  /** The first and last grid index within `reach` of `at` along one axis. */
  private span(at: number, reach: number, origin: number, n: number): [number, number] {
    return [
      Math.max(0, Math.ceil((at - reach - origin) / this.cell)),
      Math.min(n - 1, Math.floor((at + reach - origin) / this.cell)),
    ];
  }

  private xOf(c: number): number {
    return this.x0 + (c % this.nx) * this.cell;
  }

  private zOf(c: number): number {
    return this.z0 + Math.floor(c / this.nx) * this.cell;
  }
}

/** A binary min-heap of cell indices keyed by `keys`, ties broken by index; stale entries skipped. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly at: number[] = [];
  private readonly keys: Float64Array;

  constructor(keys: Float64Array) {
    this.keys = keys;
  }

  push(c: number): void {
    const key = this.keys[c] ?? Infinity;
    const { items, at } = this;
    items.push(c);
    at.push(key);
    let k = items.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(key, c, at[p] ?? Infinity, items[p] ?? 0)) break;
      items[k] = items[p] ?? 0;
      at[k] = at[p] ?? Infinity;
      k = p;
    }
    items[k] = c;
    at[k] = key;
  }

  /** The cell with the least key, or -1 when the heap is empty. */
  pop(): number {
    const { items, at } = this;
    while (items.length > 0) {
      const top = items[0] ?? -1;
      const key = at[0] ?? Infinity;
      const lastItem = items.pop() ?? 0;
      const lastKey = at.pop() ?? Infinity;
      if (items.length > 0) {
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          if (l >= items.length) break;
          const r = l + 1;
          const m =
            r < items.length &&
            this.less(at[r] ?? Infinity, items[r] ?? 0, at[l] ?? Infinity, items[l] ?? 0)
              ? r
              : l;
          if (!this.less(at[m] ?? Infinity, items[m] ?? 0, lastKey, lastItem)) break;
          items[k] = items[m] ?? 0;
          at[k] = at[m] ?? Infinity;
          k = m;
        }
        items[k] = lastItem;
        at[k] = lastKey;
      }
      if (key === this.keys[top]) return top;
    }
    return -1;
  }

  private less(ka: number, a: number, kb: number, b: number): boolean {
    return ka < kb || (ka === kb && a < b);
  }
}
