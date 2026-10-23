import type { Basin } from './basin.ts';
import type { Sdf } from './sdf.ts';

/** Grid cells across the tank's longest side at most, so a small fish in a big tank stays cheap. */
const MAX_CELLS = 256;
const DIAGONAL = Math.SQRT2;
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

/**
 * The shortest way through the water to a hollow, in plan view at one height: the length of the
 * way from every grid cell with `clearance` of water round it, Dijkstra over eight neighbours.
 * A fish behind a pile of rock follows it round by whichever side is open instead of guessing a
 * side from where the hollow faces.
 */
export class Route {
  readonly y: number;
  readonly clearance: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly length: Float64Array;

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
    this.y = y;
    this.clearance = clearance;
    const span = Math.max(basin.maxX - basin.minX, basin.maxZ - basin.minZ);
    this.cell = Math.max(cell, span / MAX_CELLS);
    this.nx = Math.max(1, Math.floor((basin.maxX - basin.minX) / this.cell));
    this.nz = Math.max(1, Math.floor((basin.maxZ - basin.minZ) / this.cell));
    this.x0 = basin.minX + 0.5 * (basin.maxX - basin.minX - (this.nx - 1) * this.cell);
    this.z0 = basin.minZ + 0.5 * (basin.maxZ - basin.minZ - (this.nz - 1) * this.cell);
    const count = this.nx * this.nz;
    const room = new Float64Array(count);
    const n3 = new Float64Array(3);
    for (let c = 0; c < count; c++) room[c] = water.sample(this.xOf(c), y, this.zOf(c), n3);
    this.length = new Float64Array(count).fill(Infinity);
    const heap = new MinHeap(this.length);
    for (let c = 0; c < count; c++) {
      const d = Math.hypot(this.xOf(c) - x, this.zOf(c) - z);
      if (d <= reach && (room[c] ?? 0) > 0) {
        this.length[c] = d;
        heap.push(c);
      }
    }
    for (let c = heap.pop(); c >= 0; c = heap.pop()) {
      const here = this.length[c] ?? Infinity;
      const ix = c % this.nx;
      const iz = (c - ix) / this.nx;
      for (const [dx, dz, w] of STEPS) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const k = jz * this.nx + jx;
        if ((room[k] ?? 0) < clearance) continue;
        const via = here + w * this.cell;
        if (via < (this.length[k] ?? Infinity)) {
          this.length[k] = via;
          heap.push(k);
        }
      }
    }
  }

  /**
   * The point `ahead` along the way from (x, z), or null when no cell within `reach` of it has a
   * way to the hollow (it is over rock, or in water cut off from the hollow).
   */
  toward(x: number, z: number, reach: number, ahead: number): [number, number] | null {
    let c = this.nearest(x, z, reach);
    if (c < 0) return null;
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
        if (l < best) {
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

  /** The cell with a way to the hollow nearest (x, z), within `reach`; -1 if there is none. */
  private nearest(x: number, z: number, reach: number): number {
    const cx = Math.round((x - this.x0) / this.cell);
    const cz = Math.round((z - this.z0) / this.cell);
    const rings = Math.ceil(reach / this.cell);
    let found = -1;
    let closest = Infinity;
    for (let iz = Math.max(0, cz - rings); iz <= Math.min(this.nz - 1, cz + rings); iz++) {
      for (let ix = Math.max(0, cx - rings); ix <= Math.min(this.nx - 1, cx + rings); ix++) {
        const c = iz * this.nx + ix;
        if ((this.length[c] ?? Infinity) === Infinity) continue;
        const d = Math.hypot(this.xOf(c) - x, this.zOf(c) - z);
        if (d <= reach && d < closest) {
          closest = d;
          found = c;
        }
      }
    }
    return found;
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
