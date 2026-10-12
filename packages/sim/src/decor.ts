import type { Sdf, TankDimensions } from './sdf.ts';

export type Point3 = readonly [number, number, number];

export type DecorShape =
  | { readonly kind: 'sphere'; readonly center: Point3; readonly radius: number }
  | {
      readonly kind: 'box';
      readonly center: Point3;
      readonly halfExtents: Point3;
      /** Yaw about +Y, same convention as fish yaw: +Z turns towards +X. */
      readonly rotationY?: number;
      /** Edge radius, included in `halfExtents`. */
      readonly rounding?: number;
    }
  | { readonly kind: 'capsule'; readonly a: Point3; readonly b: Point3; readonly radius: number };

/**
 * One collision proxy of a decor item, in tank space. Solid colliders (rock, driftwood, glass
 * ornaments) are never penetrated; non-solid ones (plants) only push fish aside.
 */
export interface DecorCollider {
  readonly id: string;
  readonly solid: boolean;
  readonly shape: DecorShape;
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

function finite(v: number, what: string, id: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`decor "${id}": ${what} must be finite, got ${v}`);
  return v;
}

function positive(v: number, what: string, id: string): number {
  if (!(Number.isFinite(v) && v > 0)) {
    throw new RangeError(`decor "${id}": ${what} must be a positive number of metres, got ${v}`);
  }
  return v;
}

function point(p: Point3, what: string, id: string): Point3 {
  if (!Array.isArray(p) || p.length !== 3) {
    throw new RangeError(`decor "${id}": ${what} must be an [x, y, z] array`);
  }
  return [
    finite(p[0], `${what}[0]`, id),
    finite(p[1], `${what}[1]`, id),
    finite(p[2], `${what}[2]`, id),
  ];
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

export function compileCollider(collider: DecorCollider): Primitive {
  const { id, shape } = collider;
  if (typeof id !== 'string' || id === '') {
    throw new RangeError(`decor collider id must be a non-empty string, got ${String(id)}`);
  }
  if (typeof collider.solid !== 'boolean') {
    throw new RangeError(`decor "${id}": solid must be true or false`);
  }
  if (typeof shape !== 'object' || shape === null) {
    throw new RangeError(`decor "${id}": shape must be an object`);
  }
  switch (shape.kind) {
    case 'sphere': {
      const [x, y, z] = point(shape.center, 'center', id);
      return new SpherePrimitive(id, x, y, z, positive(shape.radius, 'radius', id));
    }
    case 'box': {
      const [x, y, z] = point(shape.center, 'center', id);
      point(shape.halfExtents, 'halfExtents', id);
      const hx = positive(shape.halfExtents[0], 'halfExtents[0]', id);
      const hy = positive(shape.halfExtents[1], 'halfExtents[1]', id);
      const hz = positive(shape.halfExtents[2], 'halfExtents[2]', id);
      const rounding = finite(shape.rounding ?? 0, 'rounding', id);
      if (rounding < 0 || rounding > Math.min(hx, hy, hz)) {
        throw new RangeError(`decor "${id}": rounding must be within [0, smallest half extent]`);
      }
      const rotation = finite(shape.rotationY ?? 0, 'rotationY', id);
      return new BoxPrimitive(id, x, y, z, hx, hy, hz, rotation, rounding);
    }
    case 'capsule': {
      const [ax, ay, az] = point(shape.a, 'a', id);
      const [bx, by, bz] = point(shape.b, 'b', id);
      return new CapsulePrimitive(id, ax, ay, az, bx, by, bz, positive(shape.radius, 'radius', id));
    }
    default: {
      const unknown: never = shape;
      throw new RangeError(
        `decor "${id}": unknown shape kind ${JSON.stringify((unknown as { kind?: unknown }).kind)}; expected sphere, box or capsule`,
      );
    }
  }
}

/**
 * Exact signed distance to the union of decor colliders, for any point closer than `reach`;
 * beyond that it reports `reach` (steering never looks further). A uniform grid over the tank
 * keeps, per cell, the colliders that can be within `reach` of it, so a query touches a handful
 * of primitives and moving one collider rebuilds only the cells its old and new bounds cover.
 */
export class DecorField implements Sdf {
  readonly reach: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly ox: number;
  private readonly oz: number;
  private readonly cells: number[][];
  private readonly slots: (Primitive | null)[] = [];
  private readonly slotOf = new Map<string, number>();
  private readonly shapeKey = new Map<string, string>();
  private readonly free: number[] = [];
  private readonly scratch = new Float64Array(3);

  constructor(tank: TankDimensions, reach: number, cellSize = 0.05) {
    if (!(reach > 0 && Number.isFinite(reach))) {
      throw new RangeError(`DecorField reach must be a positive number of metres, got ${reach}`);
    }
    this.reach = reach;
    this.cell = cellSize;
    this.nx = Math.max(1, Math.ceil(tank.width / cellSize));
    this.ny = Math.max(1, Math.ceil(tank.height / cellSize));
    this.nz = Math.max(1, Math.ceil(tank.depth / cellSize));
    this.ox = -tank.width / 2;
    this.oz = -tank.depth / 2;
    this.cells = Array.from({ length: this.nx * this.ny * this.nz }, () => []);
  }

  get size(): number {
    return this.slotOf.size;
  }

  has(id: string): boolean {
    return this.slotOf.has(id);
  }

  /** Adds or replaces colliders and returns how many grid cells were rebuilt; unchanged ones are skipped. */
  upsert(colliders: readonly DecorCollider[]): number {
    // Compile everything first, so a bad collider leaves the field exactly as it was.
    const changed: { id: string; key: string; primitive: Primitive }[] = [];
    for (const c of colliders) {
      const primitive = compileCollider(c);
      const key = JSON.stringify(c.shape);
      if (this.shapeKey.get(c.id) !== key) changed.push({ id: c.id, key, primitive });
    }
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
  set(colliders: readonly DecorCollider[]): number {
    const keep = new Set(colliders.map((c) => c.id));
    if (keep.size !== colliders.length) throw new Error('decor collider ids must be unique');
    for (const c of colliders) compileCollider(c);
    const gone = [...this.slotOf.keys()].filter((id) => !keep.has(id));
    return this.remove(gone) + this.upsert(colliders);
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    let ix = Math.floor((x - this.ox) / this.cell);
    let iy = Math.floor(y / this.cell);
    let iz = Math.floor((z - this.oz) / this.cell);
    ix = ix < 0 ? 0 : ix >= this.nx ? this.nx - 1 : ix;
    iy = iy < 0 ? 0 : iy >= this.ny ? this.ny - 1 : iy;
    iz = iz < 0 ? 0 : iz >= this.nz ? this.nz - 1 : iz;
    const list = this.cells[(iz * this.ny + iy) * this.nx + ix];
    let best = this.reach;
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
    const r = this.reach;
    const x0 = Math.max(0, Math.floor((p.minX - r - this.ox) / this.cell));
    const x1 = Math.min(this.nx - 1, Math.floor((p.maxX + r - this.ox) / this.cell));
    const y0 = Math.max(0, Math.floor((p.minY - r) / this.cell));
    const y1 = Math.min(this.ny - 1, Math.floor((p.maxY + r) / this.cell));
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
