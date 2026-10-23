import type { Basin } from './basin.ts';
import type { Anchor } from './behaviour.ts';
import type { DecorBounds, DecorShape, Point3 } from './decor.ts';
import type { Sdf } from './sdf.ts';

/** Crevice shelters found in the hardscape when the scene offers no cave; sources in BEHAVIOUR.md. */
export const NOOK = {
  maxNooks: 4,
  gridCells: 40,
  stepBodyLengths: 0.25,
  maxStepBodyLengths: 0.5,
  rockTouchBodyLengths: 0.25,
  coverBodyLengths: 1.5,
  minCoverShare: 0.45,
  spacingBodyLengths: 2,
  traceSteps: 24,
} as const;

/** The 26 unit directions to the neighbours of a cube cell. */
const DIRECTIONS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const l = Math.hypot(dx, dy, dz);
        out.push([dx / l, dy / l, dz / l]);
      }
    }
  }
  return out;
})();

/**
 * `DIRECTIONS` indices, upward first: water above is the likeliest to be open, so a point in the
 * open is turned down after a few rays.
 */
const PROBE_ORDER: readonly number[] = DIRECTIONS.map((_, k) => k).sort(
  (a, b) => (DIRECTIONS[b]?.[1] ?? 0) - (DIRECTIONS[a]?.[1] ?? 0) || a - b,
);

/** Covered on at least `minCoverShare` of the directions is open on at most this many. */
const MAX_OPEN = Math.floor(DIRECTIONS.length * (1 - NOOK.minCoverShare));

/** Which directions the point being tested is open on. */
const OPEN = new Uint8Array(DIRECTIONS.length);

export interface NookField {
  readonly basin: Basin;
  /** Glass, sand and hard decor, without the water surface: what a fish can hide against. */
  readonly cover: Sdf;
  /** Glass, sand, surface and hard decor: what a fish's body must clear. */
  readonly water: Sdf;
  /** Hard decor alone. */
  readonly rock: Sdf;
}

/** The hard decor a search ran against: each collider's shape and bounds, and the field's reach. */
export interface NookDecor {
  readonly shapes: readonly DecorShape[];
  readonly reach: number;
}

interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly clearance: number;
  readonly cover: number;
  readonly facing: Point3;
}

/**
 * The lattice for a fish of `length`: columns `step` apart over the floor, each a row of points
 * `step` apart from a body radius over the sand to one under the surface. It is never built out;
 * a point is a key, and only the points near rock are tested.
 */
interface Grid {
  readonly length: number;
  readonly step: number;
  readonly nx: number;
  readonly nz: number;
  /** More points than any column has, so `(ix * nz + iz) * rows + iy` is in grid order. */
  readonly rows: number;
  /** Each column's lowest point. */
  readonly lo: Float64Array;
  /** Each column's point count. */
  readonly count: Int32Array;
  readonly x0: number;
  readonly z0: number;
}

/**
 * Up to `NOOK.maxNooks` crevices against the hardscape for a cave-dweller of body length `length`:
 * free water with room for its whole body, touching rock, and walled in (rock, sand or glass) on
 * at least `minCoverShare` of the 26 directions within `coverBodyLengths`. Each opens toward its
 * open directions, as a cave mouth does. They lie `spacingBodyLengths` apart. Those with
 * `turnRoom` of clearance, where the fish can turn round, come first, then the tighter ones to
 * fill up; the best covered first within each. Never fewer than the best covered alone would
 * give. Deterministic: a fixed grid, no RNG. With `decor`, the bounds of the colliders in
 * `field.rock`, only the points near them are tested.
 */
export function findNooks(
  field: NookField,
  length: number,
  turnRoom: number,
  idPrefix = 'nook:',
  decor?: NookDecor,
): Anchor[] {
  return new NookSearch().find(field, length, turnRoom, idPrefix, decor);
}

/**
 * `findNooks` that keeps the crevices it found. A search again for the same fish length,
 * fields and decor reach tests anew only the points within `nookInfluence` of a collider that
 * came, went or changed, so a nudged rock or a grown coral costs its corner of the tank only.
 */
export class NookSearch {
  private grid: Grid | null = null;
  private field: NookField | null = null;
  private decor: NookDecor | null = null;
  private readonly verdicts = new Map<number, Candidate>();
  private _tested = 0;

  /** Points tested by the last `find`: those near rock, or near the decor that changed. */
  get tested(): number {
    return this._tested;
  }

  find(
    field: NookField,
    length: number,
    turnRoom: number,
    idPrefix = 'nook:',
    decor?: NookDecor,
  ): Anchor[] {
    const before = this.decor;
    const reuse =
      decor !== undefined &&
      before !== null &&
      this.grid?.length === length &&
      before.reach === decor.reach &&
      this.field !== null &&
      sameField(this.field, field);
    this._tested = 0;
    // Outside a collider's box grown by `touch` on each axis no shape samples within `touch`, so
    // only the points inside one can touch rock; without the boxes every point is tested.
    const touch = touchOf(length);
    if (reuse) {
      const dirty = dirtyBounds(before.shapes, decor.shapes).map((b) =>
        grown(b, nookInfluence(length)),
      );
      this.forget(dirty);
      const near = decor.shapes.map((b) => grown(b, touch));
      this.retest(
        field,
        dirty.flatMap((d) => near.flatMap((b) => overlap(d, b) ?? [])),
      );
    } else {
      const grid = gridFor(field.basin, length);
      this.grid = grid;
      this.verdicts.clear();
      if (decor !== undefined && decor.reach > touch) {
        this.retest(
          field,
          decor.shapes.map((b) => grown(b, touch)),
        );
      } else {
        for (let c = 0; c < grid.nx * grid.nz; c++) this.scan(field, grid, c, 0, Infinity);
      }
    }
    this.field = field;
    this.decor = decor ?? null;
    const found = [...this.verdicts].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    return pick(found, length, turnRoom, idPrefix);
  }

  /** Drops the verdicts on the grid points inside any of `boxes`. */
  private forget(boxes: readonly Box[]): void {
    const grid = this.grid;
    if (grid === null) return;
    const { nz, rows } = grid;
    for (const key of [...this.verdicts.keys()]) {
      const c = Math.floor(key / rows);
      const ix = Math.floor(c / nz);
      const iz = c - ix * nz;
      const iy = key - c * rows;
      const hit = boxes.some((b) => {
        const s = cells(grid, b);
        if (ix < s.ix0 || ix > s.ix1 || iz < s.iz0 || iz > s.iz1) return false;
        const [from, to] = rowsOf(grid, b, c);
        return iy >= from && iy <= to;
      });
      if (hit) this.verdicts.delete(key);
    }
  }

  /** Tests again the grid points inside any of `boxes`. */
  private retest(field: NookField, boxes: readonly Box[]): void {
    const grid = this.grid;
    if (grid === null) return;
    const spans = new Map<number, [number, number][]>();
    for (const b of boxes) {
      const { ix0, ix1, iz0, iz1 } = cells(grid, b);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const c = ix * grid.nz + iz;
          const span = rowsOf(grid, b, c);
          if (span[0] > span[1]) continue;
          const list = spans.get(c);
          if (list === undefined) spans.set(c, [span]);
          else list.push(span);
        }
      }
    }
    for (const [c, list] of spans) {
      list.sort((a, b) => a[0] - b[0]);
      let [from, to] = list[0] ?? [0, -1];
      for (const [a, b] of list.slice(1)) {
        if (a > to + 1) {
          this.scan(field, grid, c, from, to);
          from = a;
        }
        to = Math.max(to, b);
      }
      this.scan(field, grid, c, from, to);
    }
  }

  /** Tests column `c` from point `from` to `to`. */
  private scan(field: NookField, grid: Grid, c: number, from: number, to: number): void {
    const { length, step, rows } = grid;
    const last = Math.min(to, (grid.count[c] ?? 0) - 1);
    const ix = Math.floor(c / grid.nz);
    const x = grid.x0 + ix * step;
    const z = grid.z0 + (c - ix * grid.nz) * step;
    const base = grid.lo[c] ?? 0;
    const r = 0.5 * length;
    const touch = touchOf(length);
    const n = new Float64Array(3);
    for (let iy = from; iy <= last; iy++) {
      const key = c * rows + iy;
      this.verdicts.delete(key);
      const y = base + iy * step;
      const rock = field.rock.sample(x, y, z, n);
      this._tested++;
      // The water field holds the rock, so a point under a body radius from rock has no room.
      if (rock > touch || rock < r) continue;
      const v = test(field, length, x, y, z, n);
      if (v !== null) this.verdicts.set(key, v);
    }
  }
}

/**
 * How far from a grid point a change in the decor can alter its verdict. A distance sampled at
 * `t` along a cover ray decides the ray only while it is under the hit margin or the `reach - t`
 * left to go, and a collider changes it only by lying that close, so the rays see no further than
 * `reach` plus the margin. The clearance and rock tests see no further than the touching
 * distance, and the mouth lies a body length past that and needs half a body of room.
 */
function nookInfluence(length: number): number {
  const r = 0.5 * length;
  const reach = NOOK.coverBodyLengths * length;
  return Math.max(reach + 0.25 * r, touchOf(length) + length + r);
}

/** How far from rock a crevice may lie: its centre a body radius out, plus the touching gap. */
function touchOf(length: number): number {
  return (0.5 + NOOK.rockTouchBodyLengths) * length;
}

type Box = Omit<DecorBounds, 'id'>;

function grown(b: Box, pad: number): Box {
  return {
    minX: b.minX - pad,
    minY: b.minY - pad,
    minZ: b.minZ - pad,
    maxX: b.maxX + pad,
    maxY: b.maxY + pad,
    maxZ: b.maxZ + pad,
  };
}

function overlap(a: Box, b: Box): Box | null {
  const o = {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    minZ: Math.max(a.minZ, b.minZ),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
  return o.minX <= o.maxX && o.minY <= o.maxY && o.minZ <= o.maxZ ? o : null;
}

/** The grid columns inside `b`. */
function cells(grid: Grid, b: Box): { ix0: number; ix1: number; iz0: number; iz1: number } {
  const { step, x0, z0 } = grid;
  return {
    ix0: Math.max(0, Math.ceil((b.minX - x0) / step)),
    ix1: Math.min(grid.nx - 1, Math.floor((b.maxX - x0) / step)),
    iz0: Math.max(0, Math.ceil((b.minZ - z0) / step)),
    iz1: Math.min(grid.nz - 1, Math.floor((b.maxZ - z0) / step)),
  };
}

/** The first and last point of column `c` inside `b`'s height. */
function rowsOf(grid: Grid, b: Box, c: number): [number, number] {
  const base = grid.lo[c] ?? 0;
  return [
    Math.max(0, Math.ceil((b.minY - base) / grid.step)),
    Math.floor((b.maxY - base) / grid.step),
  ];
}

function sameField(a: NookField, b: NookField): boolean {
  return a.basin === b.basin && a.cover === b.cover && a.water === b.water && a.rock === b.rock;
}

/** The old and new bounds of every collider that came, went or changed shape. */
function dirtyBounds(before: readonly DecorShape[], after: readonly DecorShape[]): DecorBounds[] {
  const old = new Map(before.map((s) => [s.id, s]));
  const dirty: DecorBounds[] = [];
  for (const s of after) {
    const was = old.get(s.id);
    old.delete(s.id);
    if (was?.key === s.key) continue;
    dirty.push(s);
    if (was !== undefined) dirty.push(was);
  }
  for (const was of old.values()) dirty.push(was);
  return dirty;
}

function gridFor(basin: Basin, length: number): Grid {
  const r = 0.5 * length;
  const span = Math.max(basin.width, basin.maxY - basin.minY, basin.depth);
  // Water a body radius wide by the rock slips between points further apart than that (#1464);
  // only the points near rock are tested, so the cap costs little in a big tank.
  const step = Math.min(
    NOOK.maxStepBodyLengths * length,
    Math.max(NOOK.stepBodyLengths * length, span / NOOK.gridCells),
  );
  const nx = Math.floor((basin.width - 2 * r) / step) + 1;
  const nz = Math.floor((basin.depth - 2 * r) / step) + 1;
  const x0 = basin.minX + r;
  const z0 = basin.minZ + r;
  const lo = new Float64Array(nx * nz);
  const count = new Int32Array(nx * nz);
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const c = ix * nz + iz;
      const base = basin.ground(x0 + ix * step, z0 + iz * step) + r;
      lo[c] = base;
      count[c] = Math.max(0, Math.floor((basin.maxY - r - base) / step) + 1);
    }
  }
  const rows = Math.floor((basin.maxY - basin.minY) / step) + 2;
  return { length, step, nx, nz, rows, lo, count, x0, z0 };
}

/** The crevice at (x, y, z), a point touching rock, for a fish of `length`, or null. */
function test(
  field: NookField,
  length: number,
  x: number,
  y: number,
  z: number,
  n: Float64Array,
): Candidate | null {
  const { cover, water } = field;
  const r = 0.5 * length;
  const reach = NOOK.coverBodyLengths * length;
  const clearance = water.sample(x, y, z, n);
  if (clearance < r) return null;
  let open = 0;
  for (const k of PROBE_ORDER) {
    const [dx, dy, dz] = DIRECTIONS[k] ?? [0, 0, 0];
    const free = !blocked(cover, x, y, z, dx, dy, dz, reach, 0.25 * r, n);
    OPEN[k] = free ? 1 : 0;
    if (free && ++open > MAX_OPEN) return null;
  }
  // Summed in `DIRECTIONS` order, whatever order the rays went in.
  let fx = 0;
  let fz = 0;
  DIRECTIONS.forEach(([dx, , dz], k) => {
    if (OPEN[k] === 0) return;
    fx += dx;
    fz += dz;
  });
  const covered = DIRECTIONS.length - open;
  // Cave mouths open sideways, so a nook does too, toward its open water.
  const fl = Math.hypot(fx, fz);
  if (fl < 1e-6) return null;
  const facing: Point3 = [fx / fl, 0, fz / fl];
  const out = clearance + length;
  if (water.sample(x + facing[0] * out, y, z + facing[2] * out, n) < r) return null;
  return { x, y, z, clearance, cover: covered, facing };
}

function pick(
  found: readonly Candidate[],
  length: number,
  turnRoom: number,
  idPrefix: string,
): Anchor[] {
  const candidates = [...found];
  // Stable sort: equal cover keeps grid order, so the choice never depends on the engine.
  candidates.sort((a, b) => b.cover - a.cover || a.y - b.y);
  const byCover = spaced(candidates, length, idPrefix);
  // Roomy first: a firefish that overshoots a tight slot cannot turn back into it (#1429). Most
  // cave-dwellers still hold a tight one all night, so those fill the places left (#1440), and a
  // roomy one that crowds out more tight ones than it is worth loses to the cover order.
  const roomyFirst = spaced(
    [
      ...candidates.filter((c) => c.clearance >= turnRoom),
      ...candidates.filter((c) => c.clearance < turnRoom),
    ],
    length,
    idPrefix,
  );
  return roomyFirst.length >= byCover.length ? roomyFirst : byCover;
}

function spaced(ordered: readonly Candidate[], length: number, idPrefix: string): Anchor[] {
  const spacing = NOOK.spacingBodyLengths * length;
  const nooks: Anchor[] = [];
  for (const c of ordered) {
    if (nooks.length >= NOOK.maxNooks) break;
    const apart = nooks.every(
      (k) => Math.hypot(k.position[0] - c.x, k.position[1] - c.y, k.position[2] - c.z) >= spacing,
    );
    if (!apart) continue;
    nooks.push({
      id: `${idPrefix}${nooks.length}`,
      kind: 'cave',
      position: [c.x, c.y, c.z],
      radius: c.clearance,
      facing: c.facing,
    });
  }
  return nooks;
}

function blocked(
  sdf: Sdf,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  reach: number,
  hit: number,
  n: Float64Array,
): boolean {
  let t = 0;
  for (let k = 0; k < NOOK.traceSteps && t <= reach; k++) {
    const d = sdf.sample(x + dx * t, y + dy * t, z + dz * t, n);
    if (d < hit) return true;
    t += Math.max(d, hit);
  }
  return false;
}
