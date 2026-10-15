import type { Part } from './parts.ts';
import {
  createGrid,
  fillSolid,
  open,
  rasteriseSurface,
  squaredDistance,
  toCell,
  voxelIndex,
} from './voxel.ts';

export interface DespikeSpec {
  /** Only the head is touched: vertices closer to the snout than this fraction of the body length. */
  headFraction: number;
  /** Features thinner than this fraction of the body length count as spikes. */
  thickness: number;
  /** A vertex this fraction of the body length or further outside the spike-free solid is a spike. */
  reach: number;
  /** Rings of neighbours around each spike vertex that are refilled too, to take the stubs of the spike base with them. */
  rings?: number;
}

export interface Welded {
  /** Canonical vertex of every vertex of the part, so split normals and uv seams move together. */
  canon: Uint32Array;
  positions: Float32Array;
  neighbours: number[][];
  triangles: Uint32Array;
}

export function weldByPosition(part: Part): Welded {
  const count = part.positions.length / 3;
  const seen = new Map<string, number>();
  const canon = new Uint32Array(count);
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = [0, 1, 2].map((a) => Math.round(part.positions[i * 3 + a]! * 1e5)).join(',');
    let id = seen.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      seen.set(key, id);
      positions.push(
        part.positions[i * 3]!,
        part.positions[i * 3 + 1]!,
        part.positions[i * 3 + 2]!,
      );
    }
    canon[i] = id;
  }
  const triangles = part.indices.map((i) => canon[i]!);
  const sets: Set<number>[] = Array.from({ length: positions.length / 3 }, () => new Set());
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k]!;
      const b = triangles[t + ((k + 1) % 3)]!;
      if (a === b) continue;
      sets[a]!.add(b);
      sets[b]!.add(a);
    }
  }
  return {
    canon,
    positions: Float32Array.from(positions),
    neighbours: sets.map((s) => [...s].sort((x, y) => x - y)),
    triangles,
  };
}

export function relax(
  positions: Float32Array,
  neighbours: number[][],
  free: (v: number) => boolean,
  passes: number,
  weights: readonly number[] = [1],
): Float32Array {
  let current = Float32Array.from(positions);
  for (let pass = 0; pass < passes; pass++) {
    const weight = weights[pass % weights.length]!;
    const next = Float32Array.from(current);
    for (let v = 0; v < neighbours.length; v++) {
      const around = neighbours[v]!;
      if (!free(v) || around.length === 0) continue;
      for (let a = 0; a < 3; a++) {
        let sum = 0;
        for (const n of around) sum += current[n * 3 + a]!;
        next[v * 3 + a] =
          current[v * 3 + a]! + weight * (sum / around.length - current[v * 3 + a]!);
      }
    }
    current = next;
  }
  return current;
}

export function recomputeNormals(part: Part, welded: Welded, touched: Set<number>): void {
  const accum = new Map<number, [number, number, number]>();
  const { positions, triangles } = welded;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    if (!touched.has(a) && !touched.has(b) && !touched.has(c)) continue;
    const e1 = [0, 1, 2].map((k) => positions[b * 3 + k]! - positions[a * 3 + k]!);
    const e2 = [0, 1, 2].map((k) => positions[c * 3 + k]! - positions[a * 3 + k]!);
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    for (const v of [a, b, c]) {
      const sum = accum.get(v) ?? [0, 0, 0];
      for (let k = 0; k < 3; k++) sum[k] = sum[k]! + n[k]!;
      accum.set(v, sum);
    }
  }
  for (let i = 0; i < welded.canon.length; i++) {
    const v = welded.canon[i]!;
    const sum = accum.get(v);
    if (!sum || !touched.has(v)) continue;
    const length = Math.hypot(sum[0], sum[1], sum[2]);
    if (length === 0) continue;
    for (let k = 0; k < 3; k++) part.normals[i * 3 + k] = sum[k]! / length;
  }
}

function measure(
  welded: Welded,
  spec: DespikeSpec,
): { inHead: (v: number) => boolean; flagged: Uint8Array } {
  const { positions, neighbours } = welded;
  const count = neighbours.length;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, positions[v * 3 + a]!);
      max[a] = Math.max(max[a]!, positions[v * 3 + a]!);
    }
  const length = max[2] - min[2];
  const inHead = (v: number): boolean =>
    positions[v * 3 + 2]! >= max[2] - spec.headFraction * length;

  const size = (spec.thickness * length) / 6;
  const grid = createGrid(min, max, size, 6);
  rasteriseSurface(grid, positions, welded.triangles);
  const core = open(grid, fillSolid(grid), (spec.thickness * length) / 2 / size);
  const outside = squaredDistance(grid, core);
  const flagged = new Uint8Array(count);
  const reach = (spec.reach * length) / size;
  for (let v = 0; v < count; v++) {
    if (!inHead(v)) continue;
    const [x, y, z] = [0, 1, 2].map((a) => toCell(grid, positions[v * 3 + a]!, a as 0 | 1 | 2));
    if (outside[voxelIndex(grid, x!, y!, z!)]! > reach * reach) flagged[v] = 1;
  }
  return { inHead, flagged };
}

const UV_DONORS = 8;
const SAME_ISLAND = 0.08;
const SEAM_EXTENT = 0.02;

/**
 * A spike's vertices keep the uvs of the spike texture, which would smear dark streaks over the skin they now lie on.
 * They take an inverse-distance blend of the nearest untouched vertices instead, skipping donors from another uv island.
 */
function reseatUvs(part: Part, welded: Welded, moved: Set<number>, stragglers: Set<number>): void {
  const donors: number[] = [];
  const receivers: number[] = [];
  for (let i = 0; i < welded.canon.length; i++)
    (moved.has(welded.canon[i]!) || stragglers.has(i) ? receivers : donors).push(i);
  const fixed = Float32Array.from(part.uvs);
  for (const i of receivers) {
    const nearest: { j: number; d: number }[] = [];
    for (const j of donors) {
      const d = Math.hypot(
        part.positions[i * 3]! - part.positions[j * 3]!,
        part.positions[i * 3 + 1]! - part.positions[j * 3 + 1]!,
        part.positions[i * 3 + 2]! - part.positions[j * 3 + 2]!,
      );
      if (nearest.length === UV_DONORS && d >= nearest[UV_DONORS - 1]!.d) continue;
      let at = nearest.length;
      while (at > 0 && nearest[at - 1]!.d > d) at--;
      nearest.splice(at, 0, { j, d });
      if (nearest.length > UV_DONORS) nearest.pop();
    }
    const anchor = nearest[0];
    if (!anchor) continue;
    let u = 0;
    let v = 0;
    let total = 0;
    for (const { j, d } of nearest) {
      if (
        Math.hypot(
          part.uvs[j * 2]! - part.uvs[anchor.j * 2]!,
          part.uvs[j * 2 + 1]! - part.uvs[anchor.j * 2 + 1]!,
        ) > SAME_ISLAND
      )
        continue;
      const weight = 1 / (d + 1e-6);
      u += part.uvs[j * 2]! * weight;
      v += part.uvs[j * 2 + 1]! * weight;
      total += weight;
    }
    fixed[i * 2] = u / total;
    fixed[i * 2 + 1] = v / total;
  }
  part.uvs.set(fixed);
}

/**
 * A triangle that straddles two uv islands smears a streak of texture across the skin. Where such a triangle is on
 * the head its corners are split off and given the mean uv, so it shows one flat tone instead.
 */
function flattenSeamTriangles(part: Part, welded: Welded, inHead: (v: number) => boolean): void {
  const flat: number[] = [];
  for (let t = 0; t < part.indices.length; t += 3) {
    const corners = [part.indices[t]!, part.indices[t + 1]!, part.indices[t + 2]!];
    if (!corners.some((c) => inHead(welded.canon[c]!))) continue;
    const us = corners.map((c) => part.uvs[c * 2]!);
    const vs = corners.map((c) => part.uvs[c * 2 + 1]!);
    if (
      Math.max(...us) - Math.min(...us) <= SEAM_EXTENT &&
      Math.max(...vs) - Math.min(...vs) <= SEAM_EXTENT
    )
      continue;
    flat.push(t);
  }
  if (flat.length === 0) return;
  const count = part.positions.length / 3;
  const total = count + flat.length * 3;
  const grow = <T extends Float32Array<ArrayBuffer>>(
    source: T,
    stride: number,
  ): Float32Array<ArrayBuffer> => {
    const out = new Float32Array(total * stride);
    out.set(source);
    return out;
  };
  const positions = grow(part.positions, 3);
  const normals = grow(part.normals, 3);
  const uvs = grow(part.uvs, 2);
  const extra = Object.fromEntries(Object.entries(part.extra).map(([k, v]) => [k, grow(v, 1)]));
  const indices = Uint32Array.from(part.indices);
  flat.forEach((t, n) => {
    const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const u = (uvs[corners[0]! * 2]! + uvs[corners[1]! * 2]! + uvs[corners[2]! * 2]!) / 3;
    const v =
      (uvs[corners[0]! * 2 + 1]! + uvs[corners[1]! * 2 + 1]! + uvs[corners[2]! * 2 + 1]!) / 3;
    corners.forEach((c, k) => {
      const at = count + n * 3 + k;
      positions.set(positions.subarray(c * 3, c * 3 + 3), at * 3);
      normals.set(normals.subarray(c * 3, c * 3 + 3), at * 3);
      uvs[at * 2] = u;
      uvs[at * 2 + 1] = v;
      for (const values of Object.values(extra)) values[at] = values[c]!;
      indices[t + k] = at;
    });
  });
  part.positions = positions;
  part.normals = normals;
  part.uvs = uvs;
  part.indices = indices;
  part.extra = extra;
}

const SMALL_ISLAND = 16;

/** Vertices of the head that sit on a tiny uv island: the leftovers of the spike texture, which show as dark flecks. */
function smallIslandVertices(part: Part, inHead: (index: number) => boolean): Set<number> {
  const parent = Uint32Array.from({ length: part.positions.length / 3 }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    for (let at = i; parent[at] !== root;) {
      const next = parent[at]!;
      parent[at] = root;
      at = next;
    }
    return root;
  };
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = find(part.indices[t]!);
    for (const k of [1, 2]) parent[find(part.indices[t + k]!)] = a;
  }
  const triangles = new Map<number, number>();
  for (let t = 0; t < part.indices.length; t += 3) {
    const root = find(part.indices[t]!);
    triangles.set(root, (triangles.get(root) ?? 0) + 1);
  }
  const small = new Set<number>();
  for (let i = 0; i < parent.length; i++)
    if (inHead(i) && (triangles.get(find(i)) ?? 0) < SMALL_ISLAND) small.add(i);
  return small;
}

export function countSpikeVertices(part: Part, spec: DespikeSpec): number {
  return measure(weldByPosition(part), spec).flagged.reduce((sum, f) => sum + f, 0);
}

/**
 * Flattens the rigid spikes some sources model on the head back into the skin, in place. A fused mesh offers
 * nothing to cut, so spikes are found as what a morphological opening of the voxelised body removes, and their
 * vertices are pulled onto the skin by harmonic fill from the neighbours that stay; topology is untouched, so
 * nothing tears. Returns how many vertices moved.
 */
export function despikeHead(part: Part, spec: DespikeSpec): number {
  const welded = weldByPosition(part);
  const { positions, neighbours } = welded;
  const count = neighbours.length;
  const { inHead, flagged } = measure(welded, spec);
  let grown = Uint8Array.from(flagged);
  for (let ring = 0; ring < (spec.rings ?? 2); ring++) {
    const next = Uint8Array.from(grown);
    for (let v = 0; v < count; v++)
      if (grown[v]) for (const n of neighbours[v]!) if (inHead(n)) next[n] = 1;
    grown = next;
  }

  const moved = new Set<number>();
  for (let v = 0; v < count; v++) if (grown[v]) moved.add(v);
  if (moved.size === 0) return 0;

  const filled = relax(positions, neighbours, (v) => grown[v] === 1, 800);
  const affected = new Set(moved);
  for (let ring = 0; ring < 3; ring++)
    for (const v of [...affected]) for (const n of neighbours[v]!) affected.add(n);
  const blended = relax(filled, neighbours, (v) => affected.has(v), 30, [0.5, -0.53]);
  for (const v of affected) for (let a = 0; a < 3; a++) positions[v * 3 + a] = blended[v * 3 + a]!;
  for (let i = 0; i < welded.canon.length; i++) {
    const v = welded.canon[i]!;
    if (!affected.has(v)) continue;
    for (let a = 0; a < 3; a++) part.positions[i * 3 + a] = positions[v * 3 + a]!;
  }
  reseatUvs(
    part,
    welded,
    moved,
    smallIslandVertices(part, (i) => inHead(welded.canon[i]!)),
  );
  const shading = new Set<number>();
  for (let v = 0; v < count; v++) if (inHead(v)) shading.add(v);
  recomputeNormals(part, welded, shading);
  flattenSeamTriangles(part, welded, inHead);
  return moved.size;
}
