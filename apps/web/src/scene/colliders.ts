/**
 * Collider shapes in tank space (metres), as plain structured-cloneable data so they can be
 * posted to the sim worker. `ColliderField.hard` follows the sim's `Sdf` contract: positive in
 * free water, negative inside, unit gradient written to `normal`.
 */

export type Vec3Tuple = readonly [number, number, number];

export interface CapsuleCollider {
  readonly kind: 'capsule';
  readonly hard: boolean;
  readonly a: Vec3Tuple;
  readonly b: Vec3Tuple;
  readonly radius: number;
}

/** A convex polytope: the intersection of the half-spaces `n . p <= d`, `planes` = n.x, n.y, n.z, d. */
export interface HullCollider {
  readonly kind: 'hull';
  readonly hard: true;
  readonly planes: readonly number[];
  readonly centre: Vec3Tuple;
  readonly boundRadius: number;
}

export type Collider = CapsuleCollider | HullCollider;

const DIRECTION_COUNT = 48;
const AXES: readonly Vec3Tuple[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

let cachedDirections: number[] | null = null;

function hullDirections(): number[] {
  if (cachedDirections) return cachedDirections;
  const out: number[] = [];
  for (const axis of AXES) out.push(...axis);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < DIRECTION_COUNT; i++) {
    const y = 1 - (2 * (i + 0.5)) / DIRECTION_COUNT;
    const r = Math.sqrt(1 - y * y);
    out.push(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
  }
  cachedDirections = out;
  return out;
}

/**
 * Tight convex envelope of a point cloud: for each of 54 fixed directions the support plane of
 * the points. Cheap to evaluate (54 dot products) and never smaller than the mesh.
 */
export function fitHull(points: ArrayLike<number>): HullCollider {
  const count = Math.floor(points.length / 3);
  if (count < 4) throw new RangeError('fitHull needs at least 4 points');
  const directions = hullDirections();
  const planes: number[] = [];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += points[i * 3] ?? 0;
    cy += points[i * 3 + 1] ?? 0;
    cz += points[i * 3 + 2] ?? 0;
  }
  cx /= count;
  cy /= count;
  cz /= count;
  let bound = 0;
  for (let i = 0; i < count; i++) {
    bound = Math.max(
      bound,
      Math.hypot(
        (points[i * 3] ?? 0) - cx,
        (points[i * 3 + 1] ?? 0) - cy,
        (points[i * 3 + 2] ?? 0) - cz,
      ),
    );
  }
  for (let k = 0; k < directions.length; k += 3) {
    const nx = directions[k] ?? 0;
    const ny = directions[k + 1] ?? 0;
    const nz = directions[k + 2] ?? 0;
    let d = -Infinity;
    for (let i = 0; i < count; i++) {
      d = Math.max(
        d,
        nx * (points[i * 3] ?? 0) + ny * (points[i * 3 + 1] ?? 0) + nz * (points[i * 3 + 2] ?? 0),
      );
    }
    planes.push(nx, ny, nz, d);
  }
  return { kind: 'hull', hard: true, planes, centre: [cx, cy, cz], boundRadius: bound };
}

function principalAxis(points: ArrayLike<number>, mean: Vec3Tuple): [number, number, number] {
  const count = Math.floor(points.length / 3);
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let i = 0; i < count; i++) {
    const x = (points[i * 3] ?? 0) - mean[0];
    const y = (points[i * 3 + 1] ?? 0) - mean[1];
    const z = (points[i * 3 + 2] ?? 0) - mean[2];
    xx += x * x;
    xy += x * y;
    xz += x * z;
    yy += y * y;
    yz += y * z;
    zz += z * z;
  }
  let vx = 1;
  let vy = 0.7;
  let vz = 0.3;
  for (let it = 0; it < 40; it++) {
    const nx = xx * vx + xy * vy + xz * vz;
    const ny = xy * vx + yy * vy + yz * vz;
    const nz = xz * vx + yz * vy + zz * vz;
    const len = Math.hypot(nx, ny, nz) || 1;
    vx = nx / len;
    vy = ny / len;
    vz = nz / len;
  }
  return [vx, vy, vz];
}

function distanceToSegment(
  px: number,
  py: number,
  pz: number,
  a: Vec3Tuple,
  b: Vec3Tuple,
  closest?: Float64Array,
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lenSq > 1e-18) {
    t = ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const qx = a[0] + abx * t;
  const qy = a[1] + aby * t;
  const qz = a[2] + abz * t;
  if (closest) {
    closest[0] = qx;
    closest[1] = qy;
    closest[2] = qz;
  }
  return Math.hypot(px - qx, py - qy, pz - qz);
}

/**
 * Chain of capsules along a long thin object such as driftwood: the points are cut into slices
 * along their principal axis, and each pair of slice centroids becomes one capsule whose radius
 * covers 95% of the points assigned to it.
 */
export function fitCapsuleChain(
  points: ArrayLike<number>,
  segments: number,
  hard = true,
): CapsuleCollider[] {
  const count = Math.floor(points.length / 3);
  if (count < 2 || segments < 1) throw new RangeError('fitCapsuleChain needs points and segments');
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < count; i++) {
    mx += points[i * 3] ?? 0;
    my += points[i * 3 + 1] ?? 0;
    mz += points[i * 3 + 2] ?? 0;
  }
  const mean: Vec3Tuple = [mx / count, my / count, mz / count];
  const axis = principalAxis(points, mean);
  const t = new Float64Array(count);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    t[i] =
      ((points[i * 3] ?? 0) - mean[0]) * axis[0] +
      ((points[i * 3 + 1] ?? 0) - mean[1]) * axis[1] +
      ((points[i * 3 + 2] ?? 0) - mean[2]) * axis[2];
    lo = Math.min(lo, t[i] ?? 0);
    hi = Math.max(hi, t[i] ?? 0);
  }
  const span = Math.max(hi - lo, 1e-9);
  const slices = segments + 1;
  const sums = Array.from({ length: slices }, () => ({ n: 0, x: 0, y: 0, z: 0 }));
  const slice = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const s = Math.min(slices - 1, Math.floor((((t[i] ?? 0) - lo) / span) * slices));
    slice[i] = s;
    const acc = sums[s];
    if (!acc) continue;
    acc.n++;
    acc.x += points[i * 3] ?? 0;
    acc.y += points[i * 3 + 1] ?? 0;
    acc.z += points[i * 3 + 2] ?? 0;
  }
  const centroids: Vec3Tuple[] = [];
  for (let s = 0; s < slices; s++) {
    const acc = sums[s];
    if (acc && acc.n > 0) centroids.push([acc.x / acc.n, acc.y / acc.n, acc.z / acc.n]);
  }
  const first = centroids[0];
  if (!first) throw new Error('fitCapsuleChain: no occupied slice');
  if (centroids.length === 1) centroids.push([first[0] + axis[0] * 1e-4, first[1], first[2]]);

  const segs = centroids.length - 1;
  const distances: number[][] = Array.from({ length: segs }, () => []);
  for (let i = 0; i < count; i++) {
    const px = points[i * 3] ?? 0;
    const py = points[i * 3 + 1] ?? 0;
    const pz = points[i * 3 + 2] ?? 0;
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let s = 0; s < segs; s++) {
      const a = centroids[s];
      const b = centroids[s + 1];
      if (!a || !b) continue;
      const d = distanceToSegment(px, py, pz, a, b);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = s;
      }
    }
    distances[nearest]?.push(nearestDistance);
  }
  const out: CapsuleCollider[] = [];
  for (let s = 0; s < segs; s++) {
    const a = centroids[s];
    const b = centroids[s + 1];
    const d = distances[s];
    if (!a || !b || !d || d.length === 0) continue;
    d.sort((p, q) => p - q);
    const radius = d[Math.min(d.length - 1, Math.floor(d.length * 0.95))] ?? 0;
    out.push({ kind: 'capsule', hard, a, b, radius: Math.max(radius, 0.005) });
  }
  return out;
}

export interface Bounds {
  readonly centre: Vec3Tuple;
  readonly radius: number;
}

function bounds(c: Collider): Bounds {
  if (c.kind === 'hull') return { centre: c.centre, radius: c.boundRadius };
  return {
    centre: [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2, (c.a[2] + c.b[2]) / 2],
    radius: Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]) / 2 + c.radius,
  };
}

function sampleCapsule(c: CapsuleCollider, x: number, y: number, z: number, normal: Float64Array) {
  const closest = SCRATCH;
  const d = distanceToSegment(x, y, z, c.a, c.b, closest);
  if (d > 1e-9) {
    normal[0] = (x - (closest[0] ?? 0)) / d;
    normal[1] = (y - (closest[1] ?? 0)) / d;
    normal[2] = (z - (closest[2] ?? 0)) / d;
  } else {
    normal[0] = 0;
    normal[1] = 1;
    normal[2] = 0;
  }
  return d - c.radius;
}

const SCRATCH = new Float64Array(3);

function sampleHull(c: HullCollider, x: number, y: number, z: number, normal: Float64Array) {
  let best = -Infinity;
  const p = c.planes;
  for (let i = 0; i < p.length; i += 4) {
    const d = (p[i] ?? 0) * x + (p[i + 1] ?? 0) * y + (p[i + 2] ?? 0) * z - (p[i + 3] ?? 0);
    if (d > best) {
      best = d;
      normal[0] = p[i] ?? 0;
      normal[1] = p[i + 1] ?? 0;
      normal[2] = p[i + 2] ?? 0;
    }
  }
  return best;
}

/**
 * Signed distance to a set of colliders. The hull distance is the largest plane distance, which
 * never exceeds the true distance, so avoidance errs on the cautious side near corners.
 */
export class ColliderField {
  private readonly hardList: { collider: Collider; bound: Bounds }[] = [];
  private readonly softList: { collider: Collider; bound: Bounds }[] = [];
  private readonly scratch = new Float64Array(3);

  constructor(readonly colliders: readonly Collider[]) {
    for (const collider of colliders) {
      (collider.hard ? this.hardList : this.softList).push({ collider, bound: bounds(collider) });
    }
  }

  get hardCount(): number {
    return this.hardList.length;
  }

  get softCount(): number {
    return this.softList.length;
  }

  hard(x: number, y: number, z: number, normal: Float64Array): number {
    return this.sampleList(this.hardList, x, y, z, normal);
  }

  /** Structurally the sim's `Sdf`: the hard colliders fish may not enter. */
  sample(x: number, y: number, z: number, normal: Float64Array): number {
    return this.hard(x, y, z, normal);
  }

  soft(x: number, y: number, z: number, normal: Float64Array): number {
    return this.sampleList(this.softList, x, y, z, normal);
  }

  private sampleList(
    list: readonly { collider: Collider; bound: Bounds }[],
    x: number,
    y: number,
    z: number,
    normal: Float64Array,
  ): number {
    let best = Infinity;
    normal[0] = 0;
    normal[1] = 1;
    normal[2] = 0;
    for (const { collider, bound } of list) {
      const lower =
        Math.hypot(x - bound.centre[0], y - bound.centre[1], z - bound.centre[2]) - bound.radius;
      if (lower >= best) continue;
      const d =
        collider.kind === 'hull'
          ? sampleHull(collider, x, y, z, this.scratch)
          : sampleCapsule(collider, x, y, z, this.scratch);
      if (d < best) {
        best = d;
        normal[0] = this.scratch[0] ?? 0;
        normal[1] = this.scratch[1] ?? 0;
        normal[2] = this.scratch[2] ?? 0;
      }
    }
    return best;
  }
}

export function transformPoints(
  positions: ArrayLike<number>,
  matrix: ArrayLike<number>,
): Float64Array {
  const count = Math.floor(positions.length / 3);
  const out = new Float64Array(count * 3);
  const m = matrix;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    out[i * 3] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
    out[i * 3 + 1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
    out[i * 3 + 2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
  }
  return out;
}
