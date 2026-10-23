import type { Basin } from './basin.ts';
import type { Anchor } from './behaviour.ts';
import type { DecorBounds, DecorShape } from './decor.ts';
import type { Sdf } from './sdf.ts';

/** Crevice shelters found in the hardscape when the scene offers no cave; sources in BEHAVIOUR.md. */
export const NOOK = {
  maxNooks: 4,
  gridCells: 40,
  stepBodyLengths: 0.25,
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
  readonly facing: [number, number, number];
}

/** The points tested for a fish of `length`, in grid order. */
interface Grid {
  readonly length: number;
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly zs: readonly number[];
}

/**
 * Up to `NOOK.maxNooks` crevices against the hardscape for a cave-dweller of body length `length`:
 * free water with room for its whole body, touching rock, and walled in (rock, sand or glass) on
 * at least `minCoverShare` of the 26 directions within `coverBodyLengths`. Each opens toward its
 * open directions, as a cave mouth does. The best covered come first, `spacingBodyLengths` apart.
 * Deterministic: a fixed grid, no RNG.
 */
export function findNooks(field: NookField, length: number, idPrefix = 'nook:'): Anchor[] {
  return new NookSearch().find(field, length, idPrefix);
}

/**
 * `findNooks` that keeps every grid point's verdict. A search again for the same fish length,
 * fields and decor reach tests anew only the points within `nookInfluence` of a collider that
 * came, went or changed, so a nudged rock or a grown coral costs its corner of the tank only.
 */
export class NookSearch {
  private grid: Grid | null = null;
  private field: NookField | null = null;
  private decor: NookDecor | null = null;
  private verdicts: (Candidate | null)[] = [];

  /** Points tested by the last `find`: the whole grid, or those near the decor that changed. */
  tested = 0;

  find(field: NookField, length: number, idPrefix = 'nook:', decor?: NookDecor): Anchor[] {
    const before = this.decor;
    const reuse =
      decor !== undefined &&
      before !== null &&
      this.grid?.length === length &&
      before.reach === decor.reach &&
      this.field !== null &&
      sameField(this.field, field);
    if (reuse) {
      this.retest(field, dirtyBounds(before.shapes, decor.shapes));
    } else {
      this.grid = gridFor(field.basin, length);
      this.verdicts = [];
      this.retest(field, null);
    }
    this.field = field;
    this.decor = decor ?? null;
    return pick(this.verdicts, length, idPrefix);
  }

  /** Tests every grid point again, or with `dirty` only those near one of its boxes. */
  private retest(field: NookField, dirty: readonly DecorBounds[] | null): void {
    const grid = this.grid;
    if (grid === null) return;
    const pad = nookInfluence(grid.length);
    const n = new Float64Array(3);
    const { xs, ys, zs } = grid;
    this.tested = 0;
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k] ?? 0;
      const y = ys[k] ?? 0;
      const z = zs[k] ?? 0;
      if (dirty !== null && !dirty.some((b) => near(b, x, y, z, pad))) continue;
      this.verdicts[k] = test(field, grid.length, x, y, z, n);
      this.tested++;
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
export function nookInfluence(length: number): number {
  const r = 0.5 * length;
  const reach = NOOK.coverBodyLengths * length;
  const touch = r + NOOK.rockTouchBodyLengths * length;
  return Math.max(reach + 0.25 * r, touch + length + r);
}

function near(b: DecorBounds, x: number, y: number, z: number, pad: number): boolean {
  return (
    x >= b.minX - pad &&
    x <= b.maxX + pad &&
    y >= b.minY - pad &&
    y <= b.maxY + pad &&
    z >= b.minZ - pad &&
    z <= b.maxZ + pad
  );
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
  const step = Math.max(NOOK.stepBodyLengths * length, span / NOOK.gridCells);
  const nx = Math.floor((basin.width - 2 * r) / step) + 1;
  const nz = Math.floor((basin.depth - 2 * r) / step) + 1;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let ix = 0; ix < nx; ix++) {
    const x = basin.minX + r + ix * step;
    for (let iz = 0; iz < nz; iz++) {
      const z = basin.minZ + r + iz * step;
      const lo = basin.ground(x, z) + r;
      const ny = Math.floor((basin.maxY - r - lo) / step) + 1;
      for (let iy = 0; iy < ny; iy++) {
        xs.push(x);
        ys.push(lo + iy * step);
        zs.push(z);
      }
    }
  }
  return { length, xs, ys, zs };
}

/** The crevice at (x, y, z) for a fish of `length`, or null when the point is not one. */
function test(
  field: NookField,
  length: number,
  x: number,
  y: number,
  z: number,
  n: Float64Array,
): Candidate | null {
  const { cover, water, rock } = field;
  const r = 0.5 * length;
  const reach = NOOK.coverBodyLengths * length;
  const touch = r + NOOK.rockTouchBodyLengths * length;
  // Most points lie away from the rock, and the rock alone is the cheaper field to ask.
  if (rock.sample(x, y, z, n) > touch) return null;
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
  const facing: [number, number, number] = [fx / fl, 0, fz / fl];
  const out = clearance + length;
  if (water.sample(x + facing[0] * out, y, z + facing[2] * out, n) < r) return null;
  return { x, y, z, clearance, cover: covered, facing };
}

function pick(verdicts: readonly (Candidate | null)[], length: number, idPrefix: string): Anchor[] {
  const candidates: Candidate[] = [];
  for (const c of verdicts) if (c !== null) candidates.push(c);
  // Stable sort: equal cover keeps grid order, so the choice never depends on the engine.
  candidates.sort((a, b) => b.cover - a.cover || a.y - b.y);
  const spacing = NOOK.spacingBodyLengths * length;
  const nooks: Anchor[] = [];
  for (const c of candidates) {
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
