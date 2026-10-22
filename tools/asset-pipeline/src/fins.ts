import { FIN_IDS, type FinName } from './index-schema.ts';
import { boundsOf } from './geometry.ts';
import { AXES, clamp, cross, percentile, type AxisName, type Vec3 } from './math.ts';
import {
  createGrid,
  fillSolid,
  open,
  rasteriseSurface,
  squaredDistance,
  toCell,
  voxelIndex,
} from './voxel.ts';

export interface Axes {
  forward: AxisName;
  up: AxisName;
}

export interface FinHints {
  /** Fraction of body length, measured from the snout, where the caudal peduncle ends. Taken from the opened body core when omitted. */
  peduncleFromSnout?: number;
  /** Ventral fins ahead of this fraction of body length (from the snout) are pelvic, behind it anal. */
  analFromSnout?: number;
  /** Range of body length from the snout where lateral protrusions count as pectoral fins. */
  pectoralRange?: [number, number];
  /** Voxels per longest bounding-box edge. */
  resolution?: number;
  /** Opening ball radius in voxels; structures thinner than twice this are fins. */
  openingRadius?: number;
  /** Distance from the body core, in voxels, beyond which a vertex counts as fin. */
  finThresholdVoxels?: number;
  /** Treat small pieces detached from the body on the flank as pectoral fins (sources that model them as flush shells). */
  shellPectorals?: boolean;
  /** Uniform scale of the caudal fin about its root, for sources whose tail is out of proportion to the body. */
  caudalScale?: number;
  /** Non-uniform scale of the whole mesh across the body (x) and top to bottom (y), for sources drawn far deeper or rounder than the species. */
  bodyScale?: { width: number; depth: number };
  /** Vertices ahead of the opened body core are the snout, never a fin, for sources whose snout tip is too thin to survive the opening. */
  rigidSnout?: boolean;
  /** Fins to leave unclassified, for species whose fin is part of the body mesh. */
  skip?: FinName[];
}

export interface FinResult {
  mask: Float32Array<ArrayBuffer>;
  id: Float32Array<ArrayBuffer>;
  zSnout: number;
  zPeduncle: number;
  zTail: number;
}

export function orient(positions: Float32Array, normals: Float32Array | null, axes: Axes): void {
  const forward = AXES[axes.forward]!;
  const up = AXES[axes.up]!;
  const side = cross(up, forward);
  const apply = (array: Float32Array): void => {
    for (let i = 0; i < array.length; i += 3) {
      const x = array[i]!;
      const y = array[i + 1]!;
      const z = array[i + 2]!;
      array[i] = x * side[0] + y * side[1] + z * side[2];
      array[i + 1] = x * up[0] + y * up[1] + z * up[2];
      array[i + 2] = x * forward[0] + y * forward[1] + z * forward[2];
    }
  };
  apply(positions);
  if (normals) apply(normals);
}

export function scaleBody(
  positions: Float32Array,
  normals: Float32Array,
  scale: { width: number; depth: number },
): void {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! * scale.width;
    positions[i + 1] = positions[i + 1]! * scale.depth;
    const nx = normals[i]! / scale.width;
    const ny = normals[i + 1]! / scale.depth;
    const nz = normals[i + 2]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[i] = nx / len;
    normals[i + 1] = ny / len;
    normals[i + 2] = nz / len;
  }
}

export function medianX(positions: Float32Array): number {
  const xs = new Float32Array(positions.length / 3);
  for (let i = 0; i < xs.length; i++) xs[i] = positions[i * 3]!;
  xs.sort();
  return percentile(xs, 0.5);
}

function sorted(values: number[]): Float64Array {
  return Float64Array.from(values).sort();
}

function medianFilter(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const window: number[] = [];
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++)
      window.push(values[k]!);
    return percentile(sorted(window), 0.5);
  });
}

function fillGaps(values: (number | null)[]): number[] {
  const known = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) throw new Error('classifyFins: the body core is empty');
  return values.map((v, i) => {
    if (v !== null) return v;
    let lo = -1;
    let hi = -1;
    for (const k of known) {
      if (k < i) lo = k;
      if (k > i && hi < 0) hi = k;
    }
    if (lo < 0) return values[hi]!;
    if (hi < 0) return values[lo]!;
    const t = (i - lo) / (hi - lo);
    return values[lo]! * (1 - t) + values[hi]! * t;
  });
}

interface ShellFinContext {
  zSnout: number;
  length: number;
  pectoralRange: [number, number];
  /** Half width of the body core at a z position. */
  halfWidthAt(z: number): number;
  /** Detached pieces larger than this fraction of all vertices are not fins. */
  maxShare?: number;
}

function connectedComponents(count: number, indices: ArrayLike<number>): Int32Array {
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (v: number): number => {
    let x = v;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]!);
    parent[find(indices[t + 1]!)] = a;
    parent[find(indices[t + 2]!)] = a;
  }
  const root = new Int32Array(count);
  for (let i = 0; i < count; i++) root[i] = find(i);
  return root;
}

function distance(positions: Float32Array, a: number, b: number): number {
  return Math.hypot(
    positions[a * 3]! - positions[b * 3]!,
    positions[a * 3 + 1]! - positions[b * 3 + 1]!,
    positions[a * 3 + 2]! - positions[b * 3 + 2]!,
  );
}

/**
 * Some sources model the paired fins as thin shells lying flush against the body, which no volumetric test can tell
 * from the body. A small piece that is not connected to the body, sits out on the flank and lies within the pectoral
 * range is a pectoral fin; its mask ramps from the edge that touches the body to the far tip.
 */
function markShellPectorals(
  positions: Float32Array,
  indices: ArrayLike<number>,
  mask: Float32Array,
  id: Float32Array,
  context: ShellFinContext,
): number {
  const count = positions.length / 3;
  const root = connectedComponents(count, indices);
  const members = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const list = members.get(root[i]!);
    if (list) list.push(i);
    else members.set(root[i]!, [i]);
  }
  let bodyRoot = -1;
  let bodySize = 0;
  for (const [r, list] of members) {
    if (list.length > bodySize) {
      bodySize = list.length;
      bodyRoot = r;
    }
  }
  const body = members.get(bodyRoot) ?? [];
  const maxShare = context.maxShare ?? 0.1;
  let marked = 0;

  for (const [r, list] of members) {
    if (r === bodyRoot || list.length > maxShare * count) continue;
    const cx = list.reduce((s, i) => s + Math.abs(positions[i * 3]!), 0) / list.length;
    const cz = list.reduce((s, i) => s + positions[i * 3 + 2]!, 0) / list.length;
    const fromSnout = (context.zSnout - cz) / context.length;
    if (fromSnout < context.pectoralRange[0] || fromSnout > context.pectoralRange[1]) continue;
    if (cx < 0.6 * context.halfWidthAt(cz)) continue;

    const gaps = list.map((i) => Math.min(...body.map((j) => distance(positions, i, j))));
    const nearest = Math.min(...gaps);
    const cutoff = nearest + 0.25 * (Math.max(...gaps) - nearest);
    const anchors = list.filter((_, k) => gaps[k]! <= cutoff);
    const ranges = list.map((i) => Math.min(...anchors.map((a) => distance(positions, i, a))));
    const reach = Math.max(...ranges, 1e-9);
    list.forEach((i, k) => {
      id[i] = FIN_IDS.pectoral;
      mask[i] = clamp(ranges[k]! / reach, 0, 1);
    });
    marked += list.length;
  }
  return marked;
}

/**
 * Separates the rigid body from the fins by morphological opening of the voxelised solid: anything thinner than the
 * opening ball (fin membranes) disappears from the core, and the distance from the core is the fin mask.
 */
export function classifyFins(
  positions: Float32Array,
  indices: ArrayLike<number>,
  hints: FinHints = {},
): FinResult {
  const count = positions.length / 3;
  const { min, max } = boundsOf(positions);
  const zs = new Float32Array(count);
  for (let i = 0; i < count; i++) zs[i] = positions[i * 3 + 2]!;
  const zSorted = Float32Array.from(zs).sort();
  const zTail = percentile(zSorted, 0.002);
  const zSnout = percentile(zSorted, 0.998);
  const length = zSnout - zTail;

  const size =
    Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / (hints.resolution ?? 120);
  const radius = hints.openingRadius ?? 3;
  const grid = createGrid(min, max, size, radius + 3);
  rasteriseSurface(grid, positions, indices);
  const solid = fillSolid(grid);
  const core = open(grid, solid, radius);
  const distance2 = squaredDistance(grid, core);

  const slices = grid.nz;
  const sliceTop: (number | null)[] = new Array(slices).fill(null);
  const sliceBottom: (number | null)[] = new Array(slices).fill(null);
  const sliceSide: (number | null)[] = new Array(slices).fill(null);
  let coreMinZ = Infinity;
  let coreMaxZ = -Infinity;
  for (let z = 0; z < slices; z++) {
    let yLo = Infinity;
    let yHi = -Infinity;
    let xHi = 0;
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        if (!core[voxelIndex(grid, x, y, z)]) continue;
        yLo = Math.min(yLo, y);
        yHi = Math.max(yHi, y + 1);
        xHi = Math.max(xHi, Math.abs(grid.origin[0] + (x + 0.5) * size) + size / 2);
      }
    if (yHi < 0) continue;
    sliceTop[z] = grid.origin[1] + yHi * size;
    sliceBottom[z] = grid.origin[1] + yLo * size;
    sliceSide[z] = xHi;
    coreMinZ = Math.min(coreMinZ, grid.origin[2] + z * size);
    coreMaxZ = Math.max(coreMaxZ, grid.origin[2] + (z + 1) * size);
  }
  if (!Number.isFinite(coreMinZ)) {
    throw new Error(
      'classifyFins: the opened body core is empty; the mesh is probably not watertight, lower openingRadius or raise resolution',
    );
  }
  const top = medianFilter(fillGaps(sliceTop), 1);
  const bottom = medianFilter(fillGaps(sliceBottom), 1);
  const side = medianFilter(fillGaps(sliceSide), 1);
  const at = (series: number[], z: number): number =>
    series[clamp(toCell(grid, z, 2), 0, slices - 1)]!;

  const zPeduncle =
    hints.peduncleFromSnout !== undefined
      ? zSnout - hints.peduncleFromSnout * length
      : Math.max(zTail, coreMinZ);
  const analFrom = hints.analFromSnout ?? 0.5;
  const [pectLo, pectHi] = hints.pectoralRange ?? [0.1, 0.55];
  const skip = new Set(hints.skip ?? []);
  const rigidSnout = hints.rigidSnout === true;
  const finThreshold = (hints.finThresholdVoxels ?? 1.5) * size;

  const kind = new Uint8Array(count);
  const reachDistance = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = Math.abs(positions[i * 3]!);
    const y = positions[i * 3 + 1]!;
    const z = zs[i]!;
    if (z < zPeduncle) {
      if (!skip.has('caudal')) {
        kind[i] = FIN_IDS.caudal;
        reachDistance[i] = zPeduncle - z;
      }
      continue;
    }
    const cx = clamp(toCell(grid, positions[i * 3]!, 0), 0, grid.nx - 1);
    const cy = clamp(toCell(grid, y, 1), 0, grid.ny - 1);
    const cz = clamp(toCell(grid, z, 2), 0, grid.nz - 1);
    if (rigidSnout && z > coreMaxZ) continue;
    const d = Math.sqrt(distance2[voxelIndex(grid, cx, cy, cz)]!) * size;
    if (d <= finThreshold) continue;
    const t = at(top, z);
    const b = at(bottom, z);
    const w = at(side, z);
    const centre = (t + b) / 2;
    const half = (t - b) / 2;
    const fromSnout = (zSnout - z) / length;
    const exceedLateral = x - w;
    const exceedVertical = Math.abs(y - centre) - half;
    let fin: FinName;
    if (
      exceedLateral > exceedVertical &&
      fromSnout >= pectLo &&
      fromSnout <= pectHi &&
      y - centre > -0.7 * half
    ) {
      fin = 'pectoral';
    } else if (y >= centre) {
      fin = 'dorsal';
    } else {
      fin = fromSnout < analFrom ? 'pelvic' : 'anal';
    }
    if (skip.has(fin)) continue;
    kind[i] = FIN_IDS[fin];
    reachDistance[i] = d;
  }

  const reach = new Map<number, number>();
  for (const id of Object.values(FIN_IDS)) {
    const ds: number[] = [];
    for (let i = 0; i < count; i++) if (kind[i] === id) ds.push(reachDistance[i]!);
    if (ds.length > 0) reach.set(id, Math.max(percentile(sorted(ds), 0.97), 1e-9));
  }

  const mask = new Float32Array(count);
  const id = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const k = kind[i]!;
    if (k === 0) continue;
    const m = clamp(reachDistance[i]! / reach.get(k)!, 0, 1);
    if (m <= 0) continue;
    mask[i] = m;
    id[i] = k;
  }
  if (hints.shellPectorals && !skip.has('pectoral')) {
    markShellPectorals(positions, indices, mask, id, {
      zSnout,
      length,
      pectoralRange: [pectLo, pectHi],
      halfWidthAt: (z) => at(side, z),
    });
  }
  return { mask, id, zSnout, zPeduncle, zTail };
}

const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * Mapping z -> -d * f(d) stays monotonic only while 1 - (1 - factor) * max(9t^2 - 8t^3) > 0; that maximum is 27/16 at
 * t = 3/4, so the tail folds onto itself below 1 - 16/27 (about 0.407).
 */
export const CAUDAL_SCALE_FOLD = 1 - 16 / 27;
export const CAUDAL_SCALE_MIN = 0.45;
export const CAUDAL_SCALE_MAX = 1;

/**
 * Shrinks everything behind the peduncle about its centre. The factor eases from 1 at the peduncle to `factor` half a
 * tail length behind it, so the rear of the dorsal and anal fins, which also run past the peduncle, follow without a
 * seam. Fin ids and masks are untouched; normals are transformed by the inverse transpose of the local Jacobian.
 */
export function scaleCaudal(
  positions: Float32Array,
  normals: Float32Array,
  fins: FinResult,
  factor: number,
  recipeId?: string,
): void {
  if (!(factor >= CAUDAL_SCALE_MIN && factor <= CAUDAL_SCALE_MAX))
    throw new Error(
      `${recipeId ?? 'scaleCaudal'}: caudalScale ${factor} is outside ${CAUDAL_SCALE_MIN}-${CAUDAL_SCALE_MAX}; below about ${CAUDAL_SCALE_FOLD.toFixed(2)} the tail folds onto itself, above 1 it grows. Change the recipe's caudalScale.`,
    );
  const bandEnd = fins.zPeduncle + 0.03 * (fins.zSnout - fins.zTail);
  let yBody = 0;
  let n = 0;
  for (let i = 0; i < fins.id.length; i++) {
    const z = positions[i * 3 + 2]!;
    if (fins.id[i] !== 0 || z < fins.zPeduncle || z > bandEnd) continue;
    yBody += positions[i * 3 + 1]!;
    n++;
  }
  if (n === 0)
    throw new Error('scaleCaudal: no body vertex just ahead of the peduncle to centre the tail on');
  const yRoot = yBody / n;
  const band = 0.5 * (fins.zPeduncle - fins.zTail);
  for (let i = 0; i < fins.id.length; i++) {
    const d = fins.zPeduncle - positions[i * 3 + 2]!;
    if (d <= 0) continue;
    const t = clamp(d / band, 0, 1);
    const f = 1 - (1 - factor) * smoothstep(t);
    const slope = d < band ? (-(1 - factor) * 6 * t * (1 - t)) / band : 0;
    const ux = positions[i * 3]!;
    const uy = positions[i * 3 + 1]! - yRoot;
    positions[i * 3] = ux * f;
    positions[i * 3 + 1] = yRoot + uy * f;
    positions[i * 3 + 2] = fins.zPeduncle - d * f;

    const nx = normals[i * 3]!;
    const ny = normals[i * 3 + 1]!;
    const nz = normals[i * 3 + 2]!;
    const k = (ux * nx + uy * ny - d * nz) / (f + slope * d);
    const mx = nx / f;
    const my = ny / f;
    const mz = (nz + slope * k) / f;
    const len = Math.hypot(mx, my, mz) || 1;
    normals[i * 3] = mx / len;
    normals[i * 3 + 1] = my / len;
    normals[i * 3 + 2] = mz / len;
  }
}

export function bodyCentreOfMass(
  positions: Float32Array,
  indices: ArrayLike<number>,
  id: Float32Array,
): Vec3 {
  let total = 0;
  const sum: Vec3 = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    if (id[a] !== 0 || id[b] !== 0 || id[c] !== 0) continue;
    const ax = positions[a * 3]!;
    const ay = positions[a * 3 + 1]!;
    const az = positions[a * 3 + 2]!;
    const e1: Vec3 = [
      positions[b * 3]! - ax,
      positions[b * 3 + 1]! - ay,
      positions[b * 3 + 2]! - az,
    ];
    const e2: Vec3 = [
      positions[c * 3]! - ax,
      positions[c * 3 + 1]! - ay,
      positions[c * 3 + 2]! - az,
    ];
    const n = cross(e1, e2);
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    total += area;
    sum[0] += (area * (ax + positions[b * 3]! + positions[c * 3]!)) / 3;
    sum[1] += (area * (ay + positions[b * 3 + 1]! + positions[c * 3 + 1]!)) / 3;
    sum[2] += (area * (az + positions[b * 3 + 2]! + positions[c * 3 + 2]!)) / 3;
  }
  if (total === 0)
    throw new Error('bodyCentreOfMass: no body triangles; fin classification claimed every vertex');
  return [sum[0] / total, sum[1] / total, sum[2] / total];
}

export const FIN_DEBUG_COLORS: Record<number, Vec3> = {
  0: [0.72, 0.72, 0.74],
  1: [1, 0.25, 0.2],
  2: [0.2, 0.85, 0.3],
  3: [0.25, 0.5, 1],
  4: [1, 0.85, 0.2],
  5: [0.9, 0.3, 0.9],
};

export function finDebugColors(mask: Float32Array, id: Float32Array): Float32Array {
  const colors = new Float32Array(mask.length * 3);
  for (let i = 0; i < mask.length; i++) {
    const base = FIN_DEBUG_COLORS[id[i]!] ?? FIN_DEBUG_COLORS[0]!;
    const k = id[i]! === 0 ? 1 : 0.45 + 0.55 * mask[i]!;
    colors[i * 3] = base[0] * k;
    colors[i * 3 + 1] = base[1] * k;
    colors[i * 3 + 2] = base[2] * k;
  }
  return colors;
}
