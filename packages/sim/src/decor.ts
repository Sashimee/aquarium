import { colliderSchema, type Collider } from '@aquarium/shared';
import { basinOf, type Basin, type TankDimensions } from './basin.ts';
import type { Sdf } from './sdf.ts';

export type Point3 = readonly [number, number, number];

export type DecorShape =
  | { readonly kind: 'sphere'; readonly center: Point3; readonly radius: number }
  | {
      readonly kind: 'box';
      readonly center: Point3;
      readonly halfExtents: Point3;
      readonly rotationY?: number;
      readonly rounding?: number;
    }
  | { readonly kind: 'capsule'; readonly a: Point3; readonly b: Point3; readonly radius: number };

/**
 * The nested collider format the sim took before the shared `Collider` contract; `solid` is
 * `hard`. Still accepted by `compileCollider` because apps/web's decorate mode emits it.
 */
export interface DecorCollider {
  readonly id: string;
  readonly solid: boolean;
  readonly shape: DecorShape;
}

function flattenDecorCollider(collider: unknown): unknown {
  if (typeof collider !== 'object' || collider === null || !('shape' in collider)) return collider;
  const { shape, solid, ...rest } = collider as Record<string, unknown>;
  if (typeof shape !== 'object' || shape === null) return collider;
  return { ...rest, hard: solid, ...shape };
}

interface Primitive {
  readonly id: string;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  sample(x: number, y: number, z: number, normal: Float64Array): number;
}

class SpherePrimitive implements Primitive {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;

  readonly id: string;
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly r: number;

  constructor(id: string, cx: number, cy: number, cz: number, r: number) {
    this.id = id;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.r = r;
    this.minX = cx - r;
    this.minY = cy - r;
    this.minZ = cz - r;
    this.maxX = cx + r;
    this.maxY = cy + r;
    this.maxZ = cz + r;
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dz = z - this.cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) {
      normal[0] = 0;
      normal[1] = 1;
      normal[2] = 0;
    } else {
      normal[0] = dx / len;
      normal[1] = dy / len;
      normal[2] = dz / len;
    }
    return len - this.r;
  }
}

class BoxPrimitive implements Primitive {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  private readonly cos: number;
  private readonly sin: number;
  private readonly bx: number;
  private readonly by: number;
  private readonly bz: number;
  readonly id: string;
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly rounding: number;

  constructor(
    id: string,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    rotationY: number,
    rounding: number,
  ) {
    this.id = id;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.rounding = rounding;
    this.cos = Math.cos(rotationY);
    this.sin = Math.sin(rotationY);
    this.bx = hx - rounding;
    this.by = hy - rounding;
    this.bz = hz - rounding;
    const ex = Math.abs(this.cos) * hx + Math.abs(this.sin) * hz;
    const ez = Math.abs(this.sin) * hx + Math.abs(this.cos) * hz;
    this.minX = cx - ex;
    this.maxX = cx + ex;
    this.minY = cy - hy;
    this.maxY = cy + hy;
    this.minZ = cz - ez;
    this.maxZ = cz + ez;
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    const wx = x - this.cx;
    const wz = z - this.cz;
    const lx = wx * this.cos - wz * this.sin;
    const ly = y - this.cy;
    const lz = wx * this.sin + wz * this.cos;
    const qx = Math.abs(lx) - this.bx;
    const qy = Math.abs(ly) - this.by;
    const qz = Math.abs(lz) - this.bz;
    let nx: number;
    let ny: number;
    let nz: number;
    let d: number;
    if (qx > 0 || qy > 0 || qz > 0) {
      const ox = qx > 0 ? qx : 0;
      const oy = qy > 0 ? qy : 0;
      const oz = qz > 0 ? qz : 0;
      const len = Math.hypot(ox, oy, oz);
      nx = (ox / len) * (lx < 0 ? -1 : 1);
      ny = (oy / len) * (ly < 0 ? -1 : 1);
      nz = (oz / len) * (lz < 0 ? -1 : 1);
      d = len - this.rounding;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
      if (qx >= qy && qx >= qz) {
        d = qx;
        nx = lx < 0 ? -1 : 1;
      } else if (qy >= qz) {
        d = qy;
        ny = ly < 0 ? -1 : 1;
      } else {
        d = qz;
        nz = lz < 0 ? -1 : 1;
      }
      d -= this.rounding;
    }
    normal[0] = nx * this.cos + nz * this.sin;
    normal[1] = ny;
    normal[2] = -nx * this.sin + nz * this.cos;
    return d;
  }
}

class CapsulePrimitive implements Primitive {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  private readonly abx: number;
  private readonly aby: number;
  private readonly abz: number;
  private readonly invLenSq: number;
  readonly id: string;
  private readonly ax: number;
  private readonly ay: number;
  private readonly az: number;
  private readonly r: number;

  constructor(
    id: string,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
  ) {
    this.id = id;
    this.ax = ax;
    this.ay = ay;
    this.az = az;
    this.r = r;
    this.abx = bx - ax;
    this.aby = by - ay;
    this.abz = bz - az;
    const lenSq = this.abx ** 2 + this.aby ** 2 + this.abz ** 2;
    this.invLenSq = lenSq > 0 ? 1 / lenSq : 0;
    this.minX = Math.min(ax, bx) - r;
    this.minY = Math.min(ay, by) - r;
    this.minZ = Math.min(az, bz) - r;
    this.maxX = Math.max(ax, bx) + r;
    this.maxY = Math.max(ay, by) + r;
    this.maxZ = Math.max(az, bz) + r;
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    const px = x - this.ax;
    const py = y - this.ay;
    const pz = z - this.az;
    let t = (px * this.abx + py * this.aby + pz * this.abz) * this.invLenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - this.abx * t;
    const dy = py - this.aby * t;
    const dz = pz - this.abz * t;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) {
      normal[0] = 0;
      normal[1] = 1;
      normal[2] = 0;
    } else {
      normal[0] = dx / len;
      normal[1] = dy / len;
      normal[2] = dz / len;
    }
    return len - this.r;
  }
}

const HULL_SPIRAL_DIRECTIONS = 48;

/**
 * The 54 fixed directions of the scene's k-DOP hulls: the six axes, then a golden-angle spiral.
 * Must match `fitHull` in apps/web/src/scene/colliders.ts direction for direction, so the planes
 * rebuilt from a hull's vertices are the planes the scene uses.
 */
const HULL_DIRECTIONS: Float64Array = (() => {
  const out = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < HULL_SPIRAL_DIRECTIONS; i++) {
    const y = 1 - (2 * (i + 0.5)) / HULL_SPIRAL_DIRECTIONS;
    const r = Math.sqrt(1 - y * y);
    out.push(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
  }
  return Float64Array.from(out);
})();

/**
 * The support plane of `vertices` along each k-DOP direction, packed as `nx, ny, nz, d`: the hull
 * is every point with `n . p <= d`. Never smaller than the vertices' convex hull.
 */
export function fitHull(vertices: readonly Point3[]): Float64Array {
  if (vertices.length < 4) throw new RangeError('fitHull needs at least 4 vertices');
  const planes = new Float64Array((HULL_DIRECTIONS.length / 3) * 4);
  for (let k = 0, p = 0; k < HULL_DIRECTIONS.length; k += 3, p += 4) {
    const nx = HULL_DIRECTIONS[k] ?? 0;
    const ny = HULL_DIRECTIONS[k + 1] ?? 0;
    const nz = HULL_DIRECTIONS[k + 2] ?? 0;
    let d = -Infinity;
    for (const v of vertices) d = Math.max(d, nx * v[0] + ny * v[1] + nz * v[2]);
    planes[p] = nx;
    planes[p + 1] = ny;
    planes[p + 2] = nz;
    planes[p + 3] = d;
  }
  return planes;
}

/**
 * A convex k-DOP. Inside, the largest plane distance is the exact depth; outside it never exceeds
 * the true distance, so avoidance only errs towards caution past edges and corners.
 */
class HullPrimitive implements Primitive {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly id: string;
  private readonly planes: Float64Array;

  constructor(id: string, vertices: readonly Point3[]) {
    this.id = id;
    const p = fitHull(vertices);
    this.planes = p;
    // The first six directions are the axes, so their planes are the vertices' bounding box.
    this.maxX = p[3] ?? 0;
    this.minX = -(p[7] ?? 0);
    this.maxY = p[11] ?? 0;
    this.minY = -(p[15] ?? 0);
    this.maxZ = p[19] ?? 0;
    this.minZ = -(p[23] ?? 0);
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    const p = this.planes;
    let best = -Infinity;
    let at = 0;
    for (let k = 0; k < p.length; k += 4) {
      const d = (p[k] ?? 0) * x + (p[k + 1] ?? 0) * y + (p[k + 2] ?? 0) * z - (p[k + 3] ?? 0);
      if (d > best) {
        best = d;
        at = k;
      }
    }
    normal[0] = p[at] ?? 0;
    normal[1] = p[at + 1] ?? 0;
    normal[2] = p[at + 2] ?? 0;
    return best;
  }
}

/**
 * Validates one collider in the shared format, or the nested `DecorCollider` one (it may come
 * from another thread), and builds its distance function.
 */
export function compileCollider(collider: Collider | DecorCollider): Primitive {
  const parsed = colliderSchema.safeParse(flattenDecorCollider(collider));
  if (!parsed.success) {
    const raw: unknown = collider;
    const id =
      typeof raw === 'object' && raw !== null && 'id' in raw ? JSON.stringify(raw.id) : '(no id)';
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new RangeError(`decor ${id}: ${issues.join('; ')}`);
  }
  const c = parsed.data;
  switch (c.kind) {
    case 'sphere':
      return new SpherePrimitive(c.id, c.center[0], c.center[1], c.center[2], c.radius);
    case 'box':
      return new BoxPrimitive(
        c.id,
        c.center[0],
        c.center[1],
        c.center[2],
        c.halfExtents[0],
        c.halfExtents[1],
        c.halfExtents[2],
        c.rotationY,
        c.rounding,
      );
    case 'capsule':
      return new CapsulePrimitive(c.id, ...c.a, ...c.b, c.radius);
    case 'hull':
      return new HullPrimitive(c.id, c.vertices);
  }
}

interface DecorChange {
  readonly id: string;
  readonly key: string;
  readonly primitive: Primitive;
}

export interface DecorPlan {
  readonly gone: readonly string[];
  readonly changed: readonly DecorChange[];
}

/**
 * Exact signed distance to the union of decor colliders, for any point closer than `reach`;
 * beyond that it reports `reach` (steering never looks further). A uniform grid over the tank
 * keeps, per cell, the colliders that can be within `reach` of it, so a query touches a handful
 * of primitives and moving one collider rebuilds only the cells its old and new bounds cover.
 */
export class DecorField implements Sdf {
  private reachM: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly cells: number[][];
  private readonly slots: (Primitive | null)[] = [];
  private readonly slotOf = new Map<string, number>();
  private readonly shapeKey = new Map<string, string>();
  private readonly free: number[] = [];
  private readonly scratch = new Float64Array(3);

  constructor(tank: Basin | TankDimensions, reach: number, cellSize = 0.05) {
    if (!(reach > 0 && Number.isFinite(reach))) {
      throw new RangeError(`DecorField reach must be a positive number of metres, got ${reach}`);
    }
    const basin = basinOf(tank);
    this.reachM = reach;
    this.cell = cellSize;
    this.nx = Math.max(1, Math.ceil(basin.width / cellSize));
    this.ny = Math.max(1, Math.ceil(basin.height / cellSize));
    this.nz = Math.max(1, Math.ceil(basin.depth / cellSize));
    this.ox = basin.minX;
    this.oy = basin.minY;
    this.oz = basin.minZ;
    this.cells = Array.from({ length: this.nx * this.ny * this.nz }, () => []);
  }

  get size(): number {
    return this.slotOf.size;
  }

  /** Beyond this distance from every collider `sample` reports exactly this, with an up normal. */
  get reach(): number {
    return this.reachM;
  }

  /** Raises the reach to `reach` and rebins every collider; returns cells rebuilt. Never lowers it. */
  widen(reach: number): number {
    if (!(reach > this.reachM && Number.isFinite(reach))) return 0;
    return this.rebin(reach);
  }

  /**
   * Sets the reach back to `reach`, a value it had before a `widen` that has to be taken back.
   * Cells hold slots sorted, so the field ends up exactly as it was.
   */
  restoreReach(reach: number): number {
    if (!(reach > 0 && Number.isFinite(reach))) {
      throw new RangeError(`DecorField reach must be a positive number of metres, got ${reach}`);
    }
    return reach === this.reachM ? 0 : this.rebin(reach);
  }

  private rebin(reach: number): number {
    let touched = 0;
    this.slots.forEach((p, slot) => {
      if (p) touched += this.bin(p, slot, false);
    });
    this.reachM = reach;
    this.slots.forEach((p, slot) => {
      if (p) touched += this.bin(p, slot, true);
    });
    return touched;
  }

  has(id: string): boolean {
    return this.slotOf.has(id);
  }

  /** Adds or replaces colliders and returns how many grid cells were rebuilt; unchanged ones are skipped. */
  upsert(colliders: readonly Collider[]): number {
    return this.apply({ gone: [], changed: this.compileChanged(colliders) });
  }

  /**
   * Validates `colliders` without touching the field and returns what `apply` must do to make the
   * field hold exactly them. A collider identical to the one already held under its id was
   * validated when it went in, so only new and changed ones are compiled.
   */
  plan(colliders: readonly Collider[]): DecorPlan {
    const keep = new Set(colliders.map((c) => c.id));
    if (keep.size !== colliders.length) throw new Error('decor collider ids must be unique');
    const changed = this.compileChanged(colliders);
    const gone = [...this.slotOf.keys()].filter((id) => !keep.has(id));
    return { gone, changed };
  }

  /** Carries out a `plan` made against this field's current contents; returns cells rebuilt. */
  apply(plan: DecorPlan): number {
    return this.remove(plan.gone) + this.place(plan.changed);
  }

  private compileChanged(colliders: readonly Collider[]): DecorChange[] {
    const changed: DecorChange[] = [];
    for (const c of colliders) {
      const key = JSON.stringify(c);
      if (this.shapeKey.get(c.id) !== key) {
        changed.push({ id: c.id, key, primitive: compileCollider(c) });
      }
    }
    return changed;
  }

  private place(changed: readonly DecorChange[]): number {
    let touched = 0;
    for (const { id, key, primitive } of changed) {
      const existing = this.slotOf.get(id);
      if (existing !== undefined) {
        const old = this.slots[existing];
        if (old) touched += this.bin(old, existing, false);
        this.slots[existing] = primitive;
        touched += this.bin(primitive, existing, true);
      } else {
        const slot = this.free.pop() ?? this.slots.length;
        this.slots[slot] = primitive;
        this.slotOf.set(id, slot);
        touched += this.bin(primitive, slot, true);
      }
      this.shapeKey.set(id, key);
    }
    return touched;
  }

  remove(ids: readonly string[]): number {
    let touched = 0;
    for (const id of ids) {
      const slot = this.slotOf.get(id);
      if (slot === undefined) throw new Error(`decor "${id}" is not in the field`);
      const old = this.slots[slot];
      if (old) touched += this.bin(old, slot, false);
      this.slots[slot] = null;
      this.slotOf.delete(id);
      this.shapeKey.delete(id);
      this.free.push(slot);
    }
    return touched;
  }

  /** Makes the field hold exactly `colliders`, touching only what changed. */
  set(colliders: readonly Collider[]): number {
    return this.apply(this.plan(colliders));
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    let ix = Math.floor((x - this.ox) / this.cell);
    let iy = Math.floor((y - this.oy) / this.cell);
    let iz = Math.floor((z - this.oz) / this.cell);
    ix = ix < 0 ? 0 : ix >= this.nx ? this.nx - 1 : ix;
    iy = iy < 0 ? 0 : iy >= this.ny ? this.ny - 1 : iy;
    iz = iz < 0 ? 0 : iz >= this.nz ? this.nz - 1 : iz;
    const list = this.cells[(iz * this.ny + iy) * this.nx + ix];
    let best = this.reachM;
    normal[0] = 0;
    normal[1] = 1;
    normal[2] = 0;
    if (list === undefined || list.length === 0) return best;
    const s = this.scratch;
    for (const slot of list) {
      const p = this.slots[slot];
      if (!p) continue;
      const ex = x < p.minX ? p.minX - x : x > p.maxX ? x - p.maxX : 0;
      const ey = y < p.minY ? p.minY - y : y > p.maxY ? y - p.maxY : 0;
      const ez = z < p.minZ ? p.minZ - z : z > p.maxZ ? z - p.maxZ : 0;
      if (ex * ex + ey * ey + ez * ez >= best * best) continue;
      const d = p.sample(x, y, z, s);
      if (d < best) {
        best = d;
        normal[0] = s[0] ?? 0;
        normal[1] = s[1] ?? 0;
        normal[2] = s[2] ?? 0;
      }
    }
    return best;
  }

  private bin(p: Primitive, slot: number, add: boolean): number {
    const r = this.reachM;
    const x0 = Math.max(0, Math.floor((p.minX - r - this.ox) / this.cell));
    const x1 = Math.min(this.nx - 1, Math.floor((p.maxX + r - this.ox) / this.cell));
    const y0 = Math.max(0, Math.floor((p.minY - r - this.oy) / this.cell));
    const y1 = Math.min(this.ny - 1, Math.floor((p.maxY + r - this.oy) / this.cell));
    const z0 = Math.max(0, Math.floor((p.minZ - r - this.oz) / this.cell));
    const z1 = Math.min(this.nz - 1, Math.floor((p.maxZ + r - this.oz) / this.cell));
    let touched = 0;
    for (let iz = z0; iz <= z1; iz++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const list = this.cells[(iz * this.ny + iy) * this.nx + ix];
          if (list === undefined) continue;
          if (add) {
            list.push(slot);
            list.sort((a, b) => a - b);
          } else {
            const at = list.indexOf(slot);
            if (at >= 0) list.splice(at, 1);
          }
          touched++;
        }
      }
    }
    return touched;
  }
}

/** Distance to the nearest of several fields; the gradient is that of the nearest. */
export class UnionSdf implements Sdf {
  private readonly scratch = new Float64Array(3);
  private readonly parts: readonly Sdf[];

  constructor(parts: readonly Sdf[]) {
    this.parts = parts;
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    let best = Infinity;
    const s = this.scratch;
    for (const part of this.parts) {
      const d = part.sample(x, y, z, s);
      if (d < best) {
        best = d;
        normal[0] = s[0] ?? 0;
        normal[1] = s[1] ?? 0;
        normal[2] = s[2] ?? 0;
      }
    }
    return best;
  }
}
