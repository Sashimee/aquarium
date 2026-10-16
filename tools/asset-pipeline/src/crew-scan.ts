import {
  opaqueCopy,
  extractParts,
  materialDefFrom,
  mergeParts,
  weldPart,
  type Part,
} from './parts.ts';
import type { FishContext } from './fish.ts';
import type { Vec3 } from './math.ts';
import { bakeToWorldSpace, readGltf } from './source.ts';
import { resizeImage, type Rgba } from './textures.ts';

export interface Scan {
  part: Part;
  image: Rgba;
}

/** Reads a photogrammetry scan, drops the named meshes (a colour-checker cube), merges the rest and caps the colour map. */
export async function loadScan(
  ctx: FishContext,
  sourceId: string,
  dropMeshes: RegExp,
  maxTexture: number,
): Promise<Scan> {
  ctx.verifySource(sourceId);
  const doc = await readGltf(sourceId, 'gltf/scene.gltf');
  bakeToWorldSpace(doc, (name) => dropMeshes.test(name));
  const parts = extractParts(doc);
  if (parts.length === 0) throw new Error(`${sourceId}: no geometry left after dropping meshes`);
  const used = new Set(parts.map((p) => p.material));
  const material = doc
    .getRoot()
    .listMaterials()
    .find((m) => used.has(m.getName()));
  if (!material) throw new Error(`${sourceId}: no material survived`);
  const def = await materialDefFrom(material, { metallic: 0 });
  if (!def.baseColor) throw new Error(`${sourceId}: the scan has no base colour texture`);
  const image = opaqueCopy(await resizeImage(def.baseColor.image, maxTexture));
  return { part: weldPart(mergeParts(parts, 'scan')), image };
}

export function boundsOf(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, positions[i + a]!);
      max[a] = Math.max(max[a]!, positions[i + a]!);
    }
  return { min, max };
}

/** Maps every vertex to the first vertex at the same quantised position, so UV-seam duplicates share one id. */
export function canonicalVertices(positions: ArrayLike<number>, quantum: number): Int32Array {
  const count = positions.length / 3;
  const first = new Map<string, number>();
  const canon = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(positions[i * 3]! / quantum)},${Math.round(positions[i * 3 + 1]! / quantum)},${Math.round(positions[i * 3 + 2]! / quantum)}`;
    const existing = first.get(key);
    if (existing === undefined) {
      first.set(key, i);
      canon[i] = i;
    } else {
      canon[i] = existing;
    }
  }
  return canon;
}

class DisjointSet {
  readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, i) => i);
  }

  find(a: number): number {
    let node = a;
    while (this.parent[node] !== node) {
      this.parent[node] = this.parent[this.parent[node]!]!;
      node = this.parent[node]!;
    }
    return node;
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

export interface Components {
  /** Component of every vertex, -1 where `include` was false. Components are numbered by descending size. */
  label: Int32Array;
  sizes: number[];
}

/** Connected components of the triangle edges whose two ends both pass `include`; seam duplicates count as one vertex. */
export function connectedComponents(
  canon: Int32Array,
  indices: ArrayLike<number>,
  include: (vertex: number) => boolean,
): Components {
  const count = canon.length;
  const sets = new DisjointSet(count);
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]!;
      const b = indices[t + ((k + 1) % 3)]!;
      if (include(a) && include(b)) sets.union(canon[a]!, canon[b]!);
    }
  const sizeOfRoot = new Map<number, number>();
  for (let i = 0; i < count; i++)
    if (include(i)) {
      const root = sets.find(canon[i]!);
      sizeOfRoot.set(root, (sizeOfRoot.get(root) ?? 0) + 1);
    }
  const order = [...sizeOfRoot].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const number = new Map(order.map(([root], k) => [root, k]));
  const label = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) if (include(i)) label[i] = number.get(sets.find(canon[i]!))!;
  return { label, sizes: order.map(([, size]) => size) };
}

/** Vertex loops along edges that only one triangle uses, largest first. A seam is not a boundary. */
export function boundaryLoops(canon: Int32Array, indices: ArrayLike<number>): number[][] {
  const count = canon.length;
  const uses = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * count + b : b * count + a);
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = canon[indices[t + k]!]!;
      const b = canon[indices[t + ((k + 1) % 3)]!]!;
      if (a === b) continue;
      uses.set(key(a, b), (uses.get(key(a, b)) ?? 0) + 1);
    }
  const sets = new DisjointSet(count);
  const onBoundary = new Set<number>();
  for (const [edge, used] of uses) {
    if (used !== 1) continue;
    const a = Math.floor(edge / count);
    const b = edge % count;
    sets.union(a, b);
    onBoundary.add(a);
    onBoundary.add(b);
  }
  const loops = new Map<number, number[]>();
  for (const v of [...onBoundary].sort((a, b) => a - b)) {
    const root = sets.find(v);
    (loops.get(root) ?? loops.set(root, []).get(root)!).push(v);
  }
  return [...loops.values()].sort((a, b) => b.length - a.length);
}

export interface PrincipalAxes {
  centre: Vec3;
  /** Unit axes by descending variance. */
  axes: [Vec3, Vec3, Vec3];
  variances: Vec3;
}

/** Principal axes of a point set (Jacobi sweeps on the 3x3 covariance). */
export function principalAxes(points: Vec3[]): PrincipalAxes {
  if (points.length === 0) throw new Error('principalAxes: no points');
  const centre: Vec3 = [0, 0, 0];
  for (const p of points) for (let a = 0; a < 3; a++) centre[a]! += p[a]! / points.length;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        cov[r * 3 + c]! += ((p[r]! - centre[r]!) * (p[c]! - centre[c]!)) / points.length;
  const vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = cov[p * 3 + q]!;
      off += Math.abs(apq);
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (cov[q * 3 + q]! - cov[p * 3 + p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = cov[k * 3 + p]!;
        const akq = cov[k * 3 + q]!;
        cov[k * 3 + p] = c * akp - s * akq;
        cov[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = cov[p * 3 + k]!;
        const aqk = cov[q * 3 + k]!;
        cov[p * 3 + k] = c * apk - s * aqk;
        cov[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = vectors[k * 3 + p]!;
        const vkq = vectors[k * 3 + q]!;
        vectors[k * 3 + p] = c * vkp - s * vkq;
        vectors[k * 3 + q] = s * vkp + c * vkq;
      }
    }
    if (off < 1e-18) break;
  }
  const order = [0, 1, 2].sort((a, b) => cov[b * 3 + b]! - cov[a * 3 + a]!);
  const axis = (k: number): Vec3 => [vectors[k], vectors[3 + k], vectors[6 + k]] as Vec3;
  return {
    centre,
    axes: [axis(order[0]!), axis(order[1]!), axis(order[2]!)],
    variances: [cov[order[0]! * 4]!, cov[order[1]! * 4]!, cov[order[2]! * 4]!],
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n === 0) throw new Error('unit: zero-length vector');
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function pointAt(positions: ArrayLike<number>, i: number): Vec3 {
  return [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
}

export interface Placement {
  origin: Vec3;
  /** Source-space directions that become model +X, +Y and +Z. */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  scale: number;
  /** Added after the scaled rotation, in model space. */
  shift: Vec3;
}

/** Rotates, scales and shifts positions and normals in place. */
export function place(part: Part, at: Placement): void {
  const { origin, right, up, forward, scale, shift } = at;
  const axes = [right, up, forward];
  for (let i = 0; i < part.positions.length; i += 3) {
    const p: Vec3 = [
      part.positions[i]! - origin[0],
      part.positions[i + 1]! - origin[1],
      part.positions[i + 2]! - origin[2],
    ];
    for (let a = 0; a < 3; a++) part.positions[i + a] = dot(p, axes[a]!) * scale + shift[a]!;
    const n: Vec3 = [part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!];
    for (let a = 0; a < 3; a++) part.normals[i + a] = dot(n, axes[a]!);
  }
}

export function areaCentroid(positions: ArrayLike<number>, indices: ArrayLike<number>): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = pointAt(positions, indices[t]!);
    const b = pointAt(positions, indices[t + 1]!);
    const c = pointAt(positions, indices[t + 2]!);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const w =
      Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ) / 2;
    area += w;
    for (let k = 0; k < 3; k++) sum[k]! += ((a[k]! + b[k]! + c[k]!) / 3) * w;
  }
  return area === 0 ? [0, 0, 0] : [sum[0] / area, sum[1] / area, sum[2] / area];
}
