import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import {
  areaCentroid,
  boundsOf,
  canonicalVertices,
  connectedComponents,
  dot,
  pointAt,
  principalAxes,
  sub,
  unit,
} from './crew-scan.ts';
import { speciesLengthM, type FishContext } from './fish.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  LEG_ATTRIBUTE,
  SHRIMP_PART_IDS,
  type OutputAsset,
} from './index-schema.ts';
import { clamp, cross, smoothstep, type Vec3 } from './math.ts';
import { extractParts, mergeParts, weldPart, type MaterialDef } from './parts.ts';
import { writeShippedDebugRenders } from './crew-debug.ts';
import { keepLargeComponents } from './lod.ts';
import { compactDense, weldDense, type Dense } from './rebake.ts';
import { bakeScanPart } from './scan-bake.ts';
import { readGltf } from './source.ts';
import type { Rgba } from './textures.ts';
import {
  createGrid,
  fillSolid,
  open,
  rasteriseSurface,
  squaredDistance,
  toCell,
  voxelIndex,
} from './voxel.ts';

export interface HermitRecipe {
  id: string;
  species: string;
  sourceId: string;
  fallbackLengthM: number;
  maxTriangles: number;
  textureSize: number;
  /** Direction in the source mesh that becomes model +z, towards the claws. */
  forward: Vec3;
  /** Direction in the source mesh that becomes model +y, away from the ground. */
  up: Vec3;
  /** Scan components smaller than this share of the second-largest are debris and dropped. */
  debrisShare: number;
  /** Voxel edge as a fraction of the crab's longest edge. */
  voxelFraction: number;
  /** Radius of the opening that leaves only the trunk, as a fraction of the crab's longest edge. */
  trunkOpeningFraction: number;
  /** Surface within this distance of the trunk, as a fraction of the crab's longest edge, is trunk too, so limbs rooted side by side are not joined through it. */
  trunkMarginFraction: number;
  /** Radius of the opening that separates thick limbs from antennae. */
  thinOpeningFraction: number;
  /** Limb pieces reaching less than this fraction of the farthest radius are folded into the trunk. */
  minPieceReach: number;
  /** Walking legs and the claw a side shows; welded legs on a side with fewer pieces are split apart by direction from the hip. */
  legsPerSide: number;
  /** A leg whose centroid is nearer the hip plane than this fraction of the shell length may land on the wrong side. */
  minLegLateralFraction: number;
  note: string;
}

export const HERMIT_RECIPES: HermitRecipe[] = [
  {
    id: 'hermit-crab',
    species: 'hermit-crab',
    sourceId: 'sketchfab-bce6689d',
    fallbackLengthM: 0.03,
    maxTriangles: 25000,
    textureSize: 2048,
    forward: [0, -1, 0],
    up: [0, 0, 1],
    debrisShare: 0.05,
    voxelFraction: 1 / 200,
    trunkOpeningFraction: 0.05,
    trunkMarginFraction: 0.1,
    thinOpeningFraction: 0.012,
    minPieceReach: 0.15,
    legsPerSide: 3,
    minLegLateralFraction: 0.01,
    note: 'the scan is Pagurus bernhardus, a cold-water species; legs, claws and antennae are painted towards Clibanarius tricolor (blue legs with orange joints, orange antennae) and the shell towards a warm banded reef-snail shell, procedurally and by eye, because the scan has no colour',
  },
];

const HERMIT_MATERIAL = 'hermit-crab';
export const CRAB_KIND = { shell: 0, stem: 1, leg: 2, antenna: 3 } as const;

export interface CrabSegmentation {
  kind: Uint8Array;
  /** Index of the limb piece a leg or antenna vertex belongs to, -1 elsewhere. */
  piece: Int32Array;
  /** Weight along the limb, 0 at the root to 1 at the tip. */
  weight: Float32Array;
  pieces: LimbPiece[];
  hip: Vec3;
}

export interface LimbPiece {
  kind: typeof CRAB_KIND.leg | typeof CRAB_KIND.antenna;
  vertices: number;
  centroid: Vec3;
}

interface SegmentOptions {
  voxelFraction: number;
  trunkOpeningFraction: number;
  trunkMarginFraction: number;
  thinOpeningFraction: number;
  minPieceReach: number;
  legsPerSide?: number;
}

/**
 * Splits points into `parts` groups by their direction from `hip`, with a farthest-point start and
 * Lloyd refinement on the unit sphere. Legs fan out from the hip, so welded legs part by direction.
 */
export function clusterByDirection(points: Vec3[], hip: Vec3, parts: number): number[] {
  const dirs = points.map((p) => unit(sub(p, hip)));
  const centres: Vec3[] = [dirs[0]!];
  while (centres.length < parts) {
    let best = 0;
    let bestGap = -Infinity;
    dirs.forEach((d, i) => {
      const gap = -Math.max(...centres.map((c) => dot(c, d)));
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    centres.push(dirs[best]!);
  }
  const label = new Array<number>(dirs.length).fill(0);
  for (let round = 0; round < 30; round++) {
    dirs.forEach((d, i) => {
      let top = -Infinity;
      centres.forEach((c, k) => {
        const v = dot(c, d);
        if (v > top) {
          top = v;
          label[i] = k;
        }
      });
    });
    centres.forEach((_, k) => {
      const sum: Vec3 = [0, 0, 0];
      dirs.forEach((d, i) => {
        if (label[i] === k) for (let a = 0; a < 3; a++) sum[a]! += d[a]!;
      });
      if (Math.hypot(...sum) > 0) centres[k] = unit(sum);
    });
  }
  return label;
}

function cellAt(grid: ReturnType<typeof createGrid>, p: Vec3): [number, number, number] {
  return [toCell(grid, p[0], 0), toCell(grid, p[1], 1), toCell(grid, p[2], 2)];
}

function inGrid(grid: ReturnType<typeof createGrid>, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < grid.nx && y < grid.ny && z < grid.nz;
}

const NEIGHBOURS6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

function largestVoxelComponent(grid: ReturnType<typeof createGrid>, mask: Uint8Array): Uint8Array {
  const label = new Int32Array(mask.length).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]! >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      size++;
      const x = current % grid.nx;
      const y = Math.floor(current / grid.nx) % grid.ny;
      const z = Math.floor(current / (grid.nx * grid.ny));
      for (const [dx, dy, dz] of NEIGHBOURS6) {
        if (!inGrid(grid, x + dx, y + dy, z + dz)) continue;
        const next = voxelIndex(grid, x + dx, y + dy, z + dz);
        if (mask[next] && label[next]! < 0) {
          label[next] = id;
          stack.push(next);
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length === 0) return new Uint8Array(mask.length);
  const best = sizes.indexOf(Math.max(...sizes));
  return Uint8Array.from(label, (l) => (l === best ? 1 : 0));
}

/**
 * Splits a crab's own mesh (no shell) into the trunk and the limbs. A morphological opening leaves the
 * bulky trunk, whose largest connected piece is the body; everything outside it is cut into limb pieces,
 * one per connected run of surface. Pieces too short to be limbs are folded back into the trunk.
 * Model space: +x right, +y up, +z towards the claws.
 */
export function segmentCrab(
  positions: Float32Array,
  indices: Uint32Array,
  options: SegmentOptions,
): CrabSegmentation {
  const count = positions.length / 3;
  const { min, max } = boundsOf(positions);
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const voxel = longest * options.voxelFraction;
  const grid = createGrid(min, max, voxel, 3);
  rasteriseSurface(grid, positions, indices);
  const solid = fillSolid(grid);
  const trunk = largestVoxelComponent(
    grid,
    open(grid, solid, (options.trunkOpeningFraction * longest) / voxel),
  );
  const slender = open(grid, solid, (options.thinOpeningFraction * longest) / voxel);

  const inside = (mask: Uint8Array, p: Vec3, reach: number): boolean => {
    const [cx, cy, cz] = cellAt(grid, p);
    for (let dz = -reach; dz <= reach; dz++)
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          if (!inGrid(grid, cx + dx, cy + dy, cz + dz)) continue;
          if (mask[voxelIndex(grid, cx + dx, cy + dy, cz + dz)]) return true;
        }
    return false;
  };

  const toTrunk = squaredDistance(grid, trunk);
  const marginSquared = ((options.trunkMarginFraction * longest) / voxel) ** 2;
  const onTrunk = new Uint8Array(count);
  const hip: Vec3 = [0, 0, 0];
  let trunkCount = 0;
  for (let i = 0; i < count; i++) {
    const p = pointAt(positions, i);
    const [cx, cy, cz] = cellAt(grid, p);
    const distance = toTrunk[voxelIndex(grid, cx, cy, cz)]!;
    if (distance <= marginSquared) onTrunk[i] = 1;
    if (distance > 4) continue;
    trunkCount++;
    for (let a = 0; a < 3; a++) hip[a]! += p[a]!;
  }
  if (trunkCount === 0)
    throw new Error('segmentCrab: no trunk survives the opening; lower trunkOpeningFraction');
  for (let a = 0; a < 3; a++) hip[a]! /= trunkCount;

  const radius = new Float32Array(count);
  let farthest = 0;
  for (let i = 0; i < count; i++) {
    const p = pointAt(positions, i);
    radius[i] = Math.hypot(p[0] - hip[0], p[1] - hip[1], p[2] - hip[2]);
    farthest = Math.max(farthest, radius[i]!);
  }
  const canon = canonicalVertices(positions, voxel / 4);
  const limbs = connectedComponents(canon, indices, (v) => onTrunk[v] === 0);

  const reach = limbs.sizes.map(() => ({ low: Infinity, high: 0, thin: 0, count: 0 }));
  const centroids = limbs.sizes.map(() => [0, 0, 0] as Vec3);
  for (let i = 0; i < count; i++) {
    const c = limbs.label[i]!;
    if (c < 0) continue;
    const r = reach[c]!;
    r.low = Math.min(r.low, radius[i]!);
    r.high = Math.max(r.high, radius[i]!);
    r.count++;
    if (!inside(slender, pointAt(positions, i), 0)) r.thin++;
    for (let a = 0; a < 3; a++) centroids[c]![a]! += positions[i * 3 + a]!;
  }

  const kind = new Uint8Array(count).fill(CRAB_KIND.stem);
  const piece = new Int32Array(count).fill(-1);
  const weight = new Float32Array(count);
  const pieces: LimbPiece[] = [];
  const pieceOf = new Map<number, number>();
  limbs.sizes.forEach((size, c) => {
    const r = reach[c]!;
    if (r.high - r.low < farthest * options.minPieceReach || size < 50) return;
    const antenna = r.thin / r.count > 0.5;
    pieceOf.set(c, pieces.length);
    pieces.push({
      kind: antenna ? CRAB_KIND.antenna : CRAB_KIND.leg,
      vertices: size,
      centroid: centroids[c]!.map((v) => v / size) as Vec3,
    });
  });
  for (let i = 0; i < count; i++) {
    const p = pieceOf.get(limbs.label[i]!);
    if (p === undefined) continue;
    const r = reach[limbs.label[i]!]!;
    kind[i] = pieces[p]!.kind;
    piece[i] = p;
    weight[i] = clamp((radius[i]! - r.low) / (r.high - r.low), 0, 1);
  }

  if (options.legsPerSide !== undefined)
    splitWeldedLegs(
      { positions, indices, canon, kind, piece, weight, pieces, radius, hip },
      options.legsPerSide,
    );
  return { kind, piece, weight, pieces, hip };
}

interface WeldState {
  positions: Float32Array;
  indices: Uint32Array;
  canon: Int32Array;
  kind: Uint8Array;
  piece: Int32Array;
  weight: Float32Array;
  pieces: LimbPiece[];
  radius: Float32Array;
  hip: Vec3;
}

class MinHeap {
  private readonly items: [number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(cost: number, node: number): void {
    const items = this.items;
    items.push([cost, node]);
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (items[parent]![0] <= items[at]![0]) break;
      [items[parent], items[at]] = [items[at]!, items[parent]!];
      at = parent;
    }
  }

  pop(): [number, number] {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let least = at;
        if (left < items.length && items[left]![0] < items[least]![0]) least = left;
        if (right < items.length && items[right]![0] < items[least]![0]) least = right;
        if (least === at) break;
        [items[least], items[at]] = [items[at]!, items[least]!];
        at = least;
      }
    }
    return top;
  }
}

/**
 * Grows each leg's region over the mesh from its own root, so every region is one connected piece that
 * touches the body. Roots are the welded piece's vertices that border the exposed soft body; they are
 * grouped by direction from the hip only to seed the growth. A vertex joins the root it is nearest to
 * along the surface, which cuts touching legs at the contact between them.
 */
export function growLegRegions(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  canon: Int32Array,
  members: ReadonlySet<number>,
  isRoot: (vertex: number) => boolean,
  hip: Vec3,
  parts: number,
): Map<number, number> {
  const inside = (v: number): boolean => members.has(canon[v]!);
  const edges = new Map<number, Map<number, number>>();
  const roots = new Set<number>();
  const link = (a: number, b: number): void => {
    const length = Math.hypot(
      positions[a * 3]! - positions[b * 3]!,
      positions[a * 3 + 1]! - positions[b * 3 + 1]!,
      positions[a * 3 + 2]! - positions[b * 3 + 2]!,
    );
    let out = edges.get(a);
    if (!out) edges.set(a, (out = new Map()));
    out.set(b, length);
  };
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]!;
      const b = indices[t + ((k + 1) % 3)]!;
      const ca = canon[a]!;
      const cb = canon[b]!;
      if (ca === cb) continue;
      if (inside(a) && inside(b)) {
        link(ca, cb);
        link(cb, ca);
      } else if (inside(a) && isRoot(b)) roots.add(ca);
      else if (inside(b) && isRoot(a)) roots.add(cb);
    }
  if (roots.size < parts)
    throw new Error(
      `growLegRegions: ${roots.size} root vertices touch the body, fewer than the ${parts} legs to separate`,
    );
  const rootList = [...roots].sort((a, b) => a - b);
  const seeds = clusterByDirection(
    rootList.map((v) => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!] as Vec3),
    hip,
    parts,
  );
  const best = new Map<number, { cost: number; part: number }>();
  const heap = new MinHeap();
  rootList.forEach((v, i) => {
    best.set(v, { cost: 0, part: seeds[i]! });
    heap.push(0, v);
  });
  while (heap.size > 0) {
    const [cost, v] = heap.pop();
    const here = best.get(v)!;
    if (cost > here.cost) continue;
    for (const [w, length] of edges.get(v) ?? []) {
      const known = best.get(w);
      if (!known || cost + length < known.cost) {
        best.set(w, { cost: cost + length, part: here.part });
        heap.push(cost + length, w);
      }
    }
  }
  return new Map([...best].map(([v, b]) => [v, b.part]));
}

function splitWeldedLegs(state: WeldState, legsPerSide: number): void {
  const { positions, indices, canon, kind, piece, weight, pieces, radius, hip } = state;
  const sideOf = (c: Vec3): number => (c[0] < hip[0] ? 0 : 1);
  for (const side of [0, 1]) {
    const onSide = pieces
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.kind === CRAB_KIND.leg && sideOf(p.centroid) === side);
    const missing = legsPerSide - onSide.length;
    if (missing <= 0) continue;
    if (onSide.length === 0)
      throw new Error(`segmentCrab: no leg piece on side ${side} to split; recheck the recipe`);
    const welded = onSide.reduce((a, b) => (b.p.vertices > a.p.vertices ? b : a));
    const members: number[] = [];
    for (let v = 0; v < piece.length; v++) if (piece[v] === welded.i) members.push(v);
    const region = growLegRegions(
      positions,
      indices,
      canon,
      new Set(members.map((v) => canon[v]!)),
      (v) => kind[v] === CRAB_KIND.stem,
      hip,
      missing + 1,
    );
    const ids = [welded.i];
    for (let k = 1; k <= missing; k++) {
      ids.push(pieces.length);
      pieces.push({ ...welded.p });
    }
    for (let k = 0; k <= missing; k++) {
      const own = members.filter((v) => region.get(canon[v]!) === k);
      if (own.length < 50)
        throw new Error(
          `segmentCrab: splitting the welded legs left a ${own.length}-vertex leg; recheck legsPerSide`,
        );
      let low = Infinity;
      let high = 0;
      const sum: Vec3 = [0, 0, 0];
      for (const v of own) {
        low = Math.min(low, radius[v]!);
        high = Math.max(high, radius[v]!);
        for (let a = 0; a < 3; a++) sum[a]! += positions[v * 3 + a]!;
      }
      for (const v of own) {
        piece[v] = ids[k]!;
        weight[v] = clamp((radius[v]! - low) / Math.max(high - low, 1e-9), 0, 1);
      }
      pieces[ids[k]!] = {
        kind: CRAB_KIND.leg,
        vertices: own.length,
        centroid: sum.map((x) => x / own.length) as Vec3,
      };
    }
  }
}

/** The two claws are different sizes in a real hermit crab, the left usually much the larger. */
const MAX_CLAW_REACH_RATIO = 4;
/** A claw's root must lead the walking legs on its side by this share of its own reach. */
const MIN_CLAW_LEAD = 0.05;

export interface LimbFrame {
  kind: number;
  /** Piece centroid across the body from the hip, positive towards +x. */
  lateral: number;
  /** Piece centroid along the model's +z. */
  ahead: number;
  /** Mean +z of the piece's root vertices, where it joins the trunk. */
  rootAhead: number;
  /** Distance from the piece's mean root to its mean tip. */
  reach: number;
}

/**
 * The claw pair (the chelipeds) is the leg whose root sits foremost on each side; the pair takes slot 0/1.
 * The walking legs follow fore to aft on their side, so a leg lands in slot `pair * 2 + side` whatever the
 * other side holds. Long antennae take the 2/3 slot. Throws when a side has no leg, a claw's root does not
 * lead the walking legs on its own side, or the two claws differ in reach by more than a real pair does.
 */
export function assignLimbIndices(pieces: LimbFrame[]): number[] {
  const index = new Array<number>(pieces.length).fill(-1);
  const legs = pieces
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.kind === CRAB_KIND.leg)
    .sort((a, b) => b.rootAhead - a.rootAhead || a.i - b.i);
  const sideOf = (p: { lateral: number }): number => (p.lateral < 0 ? 0 : 1);
  const claws = [0, 1].map((side) => legs.find((p) => sideOf(p) === side));
  if (claws[0] === undefined || claws[1] === undefined)
    throw new Error(
      'assignLimbIndices: one side of the body has no leg piece, so there is no claw pair; recheck the segmentation recipe',
    );
  const walkers = legs.filter((p) => p !== claws[0] && p !== claws[1]);
  if (walkers.length === 0)
    throw new Error(
      `assignLimbIndices: ${legs.length} leg pieces, need a claw pair and at least one walking leg; recheck the segmentation recipe`,
    );
  for (const claw of claws as typeof legs) {
    const behind = walkers.filter((w) => sideOf(w) === sideOf(claw));
    if (behind.length === 0) continue;
    const lead = claw.rootAhead - Math.max(...behind.map((w) => w.rootAhead));
    if (!(lead > MIN_CLAW_LEAD * claw.reach))
      throw new Error(
        `assignLimbIndices: the claw root leads the foremost walking leg on its side by only ${lead.toFixed(5)} (need over ${(MIN_CLAW_LEAD * claw.reach).toFixed(5)}); recheck the segmentation recipe`,
      );
  }
  const reaches = (claws as typeof legs).map((c) => c.reach);
  const ratio = Math.max(...reaches) / Math.max(Math.min(...reaches), 1e-9);
  if (ratio > MAX_CLAW_REACH_RATIO)
    throw new Error(
      `assignLimbIndices: the two claws differ in reach by ${ratio.toFixed(2)}x (limit ${MAX_CLAW_REACH_RATIO}x), so one is not a claw; recheck the segmentation recipe`,
    );
  for (const claw of claws as typeof legs) index[claw.i] = sideOf(claw);
  const taken = new Set<number>([0, 1]);
  const takeFree = (preferred: number): number => {
    let candidate = preferred;
    while (taken.has(candidate)) candidate += 2;
    taken.add(candidate);
    return candidate;
  };
  for (const side of [0, 1])
    walkers
      .filter((p) => sideOf(p) === side)
      .sort((a, b) => b.ahead - a.ahead)
      .forEach((leg, rank) => {
        index[leg.i] = takeFree(Math.min(rank + 1, 4) * 2 + side);
      });
  const antennae = pieces
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.kind === CRAB_KIND.antenna)
    .sort((a, b) => a.lateral - b.lateral);
  antennae.forEach((a, k) => {
    index[a.i] = 2 + (antennae.length === 1 ? (a.lateral < 0 ? 0 : 1) : Math.min(k, 1));
  });
  return index;
}

type Rgb = [number, number, number];

const STEM: Rgb = [0.42, 0.24, 0.14];
const LEG_BLUE: Rgb = [0.1, 0.34, 0.82];
const LEG_RING: Rgb = [0.95, 0.42, 0.08];
const LEG_TIP: Rgb = [0.08, 0.06, 0.05];
const ANTENNA: Rgb = [0.86, 0.27, 0.08];
const JOINT_BANDS = 5;
const RING_WIDTH = 0.16;

/** Colour of a limb or stem texel from its kind and weight along the limb. */
export function crabColour(kind: number, weight: number): Rgb {
  if (kind === CRAB_KIND.stem) return STEM;
  if (kind === CRAB_KIND.antenna) return ANTENNA;
  if (weight > 0.95) return LEG_TIP;
  const phase = (weight * JOINT_BANDS) % 1;
  return phase > 1 - RING_WIDTH ? LEG_RING : LEG_BLUE;
}

/** Recolours every non-shell vertex by its kind and limb weight, keeping the scan's own light and shadow as a multiplier. */
export function recolourDense(dense: Dense, kind: Uint8Array, weight: Float32Array): void {
  const count = kind.length;
  const lum = (v: number): number =>
    0.2126 * dense.colours[v * 3]! +
    0.7152 * dense.colours[v * 3 + 1]! +
    0.0722 * dense.colours[v * 3 + 2]!;
  const sums: Record<number, { sum: number; n: number }> = {};
  for (let v = 0; v < count; v++) {
    const k = kind[v]!;
    if (k === CRAB_KIND.shell) continue;
    const entry = (sums[k] ??= { sum: 0, n: 0 });
    entry.sum += lum(v);
    entry.n++;
  }
  for (let v = 0; v < count; v++) {
    const k = kind[v]!;
    if (k === CRAB_KIND.shell) continue;
    const mean = sums[k]!.sum / sums[k]!.n || 1;
    const shade = clamp(lum(v) / mean, 0.55, 1.45);
    const rgb = crabColour(k, weight[v]!);
    for (let c = 0; c < 3; c++) dense.colours[v * 3 + c] = clamp(rgb[c]! * shade, 0, 1);
  }
}

const PART_RGB: Record<number, Vec3> = {
  0: [0.55, 0.55, 0.6],
  6: [0.2, 0.55, 0.95],
  7: [0.95, 0.5, 0.1],
  9: [0.75, 0.55, 0.35],
};

function partColours(ids: Float32Array, weights: Float32Array): Float32Array {
  const colors = new Float32Array(ids.length * 3);
  for (let i = 0; i < ids.length; i++) {
    const base = PART_RGB[ids[i]!] ?? PART_RGB[0]!;
    const k = ids[i] === 0 || ids[i] === 9 ? 1 : 0.4 + 0.6 * weights[i]!;
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = base[c]! * k;
  }
  return colors;
}

const SHELL_GROUND: Rgb = [0.8, 0.64, 0.46];
const SHELL_BAND: Rgb = [0.4, 0.2, 0.1];
const SHELL_FLECK: Rgb = [0.25, 0.12, 0.07];
const SHELL_BANDS_PER_TURN = 3;
const SHELL_BAND_SHARE = 0.34;

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, z: number): number {
  const [ix, iy, iz] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [fx, fy, fz] = [x - ix, y - iy, z - iz].map((f) => f * f * (3 - 2 * f)) as Vec3;
  let value = 0;
  for (let corner = 0; corner < 8; corner++) {
    const [dx, dy, dz] = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    value += w * hash3(ix + dx, iy + dy, iz + dz);
  }
  return value;
}

/**
 * Spiral colour bands round the shell's long axis, a warm ground, and dark flecks from value noise.
 * `axis` are the shell's principal axes from the longest; `length` is the shell's longest edge.
 */
export function shellColour(p: Vec3, centre: Vec3, axes: [Vec3, Vec3, Vec3], length: number): Rgb {
  const q = sub(p, centre);
  const along = dot(q, axes[0]) / length;
  const turn = Math.atan2(dot(q, axes[2]), dot(q, axes[1])) / (Math.PI * 2);
  const phase = ((((turn + along * 2.2) * SHELL_BANDS_PER_TURN) % 1) + 1) % 1;
  const band =
    smoothstep(0, 0.06, phase) * (1 - smoothstep(SHELL_BAND_SHARE - 0.06, SHELL_BAND_SHARE, phase));
  const grain = valueNoise((p[0] / length) * 38, (p[1] / length) * 38, (p[2] / length) * 38);
  const fleck = smoothstep(0.62, 0.78, grain);
  const mottle =
    0.9 + 0.2 * valueNoise((p[0] / length) * 9, (p[1] / length) * 9, (p[2] / length) * 9);
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const banded = SHELL_GROUND[c]! + (SHELL_BAND[c]! - SHELL_GROUND[c]!) * band;
    out[c] = clamp((banded + (SHELL_FLECK[c]! - banded) * fleck * 0.7) * mottle, 0, 1);
  }
  return out;
}

/** Mean root (weight under 0.1) and mean tip (weight over 0.9) of a limb piece. Throws when the piece has no root or no tip vertices. */
export function limbEnds(
  positions: ArrayLike<number>,
  members: number[],
  weight: ArrayLike<number>,
): { root: Vec3; tip: Vec3 } {
  const root: Vec3 = [0, 0, 0];
  const tip: Vec3 = [0, 0, 0];
  let roots = 0;
  let tips = 0;
  for (const v of members) {
    const target = weight[v]! < 0.1 ? root : weight[v]! > 0.9 ? tip : null;
    if (!target) continue;
    for (let a = 0; a < 3; a++) target[a]! += positions[v * 3 + a]!;
    if (target === root) roots++;
    else tips++;
  }
  if (roots === 0 || tips === 0)
    throw new Error(
      `limbEnds: piece of ${members.length} vertices has ${roots} root and ${tips} tip vertices; recheck the segmentation recipe`,
    );
  return {
    root: root.map((v) => v / roots) as Vec3,
    tip: tip.map((v) => v / tips) as Vec3,
  };
}

/** Distance between the mean root and mean tip of a limb piece. */
export function limbReach(
  positions: ArrayLike<number>,
  members: number[],
  weight: ArrayLike<number>,
): number {
  const { root, tip } = limbEnds(positions, members, weight);
  return Math.hypot(root[0] - tip[0], root[1] - tip[1], root[2] - tip[2]);
}

export interface Bodies {
  dense: Dense;
  /** 1 on the shell's vertices, 0 on the crab's. */
  shell: Uint8Array;
}

function labelBodies(
  dense: Dense,
  forward: Vec3,
): { label: Int32Array; sizes: number[]; crab: number } {
  const count = dense.positions.length / 3;
  const used = new Uint8Array(count);
  for (const v of dense.indices) used[v] = 1;
  const identity = Int32Array.from({ length: count }, (_, i) => i);
  const parts = connectedComponents(identity, dense.indices, (v) => used[v] === 1);
  if (parts.sizes.length < 2)
    throw new Error(
      'hermit: the scan is one connected piece, so the crab cannot be told from its shell',
    );
  const front = [-Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    const c = parts.label[v]!;
    if (c >= 0 && c < 2) front[c] = Math.max(front[c]!, dot(pointAt(dense.positions, v), forward));
  }
  return { label: parts.label, sizes: parts.sizes, crab: front[0]! > front[1]! ? 0 : 1 };
}

/**
 * The crab and its shell are the two largest connected pieces of the scan, and the crab is the one that
 * reaches farther forward; any smaller piece is debris and is dropped. Throws unless the second piece is
 * clearly a body, so a mesh that is not split this way fails the build.
 */
export function isolateBodies(dense: Dense, forward: Vec3, debrisShare: number): Bodies {
  const first = labelBodies(dense, forward);
  if (first.sizes[1]! < debrisShare * first.sizes[0]!)
    throw new Error(
      `hermit: the second-largest scan piece has ${first.sizes[1]} vertices against ${first.sizes[0]}; it is debris, not a shell`,
    );
  const kept: number[] = [];
  for (let t = 0; t < dense.indices.length; t += 3)
    if (first.label[dense.indices[t]!]! < 2)
      kept.push(dense.indices[t]!, dense.indices[t + 1]!, dense.indices[t + 2]!);
  const compact = compactDense(dense, Uint32Array.from(kept));
  const second = labelBodies(compact, forward);
  const shell = Uint8Array.from(second.label, (l) => (l >= 0 && l !== second.crab ? 1 : 0));
  return { dense: compact, shell };
}

interface Orientation {
  origin: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

function orient(positions: Float32Array, at: Orientation): void {
  const axes = [at.right, at.up, at.forward];
  for (let i = 0; i < positions.length; i += 3) {
    const p = sub(pointAt(positions, i / 3), at.origin);
    for (let a = 0; a < 3; a++) positions[i + a] = dot(p, axes[a]!);
  }
}

function subsetOf(
  dense: Dense,
  keep: (vertex: number) => boolean,
): { positions: Float32Array; indices: Uint32Array; source: Int32Array } {
  const remap = new Int32Array(dense.positions.length / 3).fill(-1);
  const source: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < dense.indices.length; t += 3) {
    const tri = [dense.indices[t]!, dense.indices[t + 1]!, dense.indices[t + 2]!];
    if (!tri.every(keep)) continue;
    for (const v of tri) {
      if (remap[v]! < 0) {
        remap[v] = source.length;
        source.push(v);
      }
      indices.push(remap[v]!);
    }
  }
  const positions = new Float32Array(source.length * 3);
  source.forEach((v, k) => positions.set(dense.positions.subarray(v * 3, v * 3 + 3), k * 3));
  return { positions, indices: Uint32Array.from(indices), source: Int32Array.from(source) };
}

const NO_COLOUR_MAP: Rgba = {
  width: 1,
  height: 1,
  data: new Uint8Array([255, 255, 255, 255]),
};

export async function buildHermit(recipe: HermitRecipe, ctx: FishContext): Promise<OutputAsset> {
  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM = fromSpecies ?? recipe.fallbackLengthM;
  ctx.verifySource(recipe.sourceId);
  const parts = extractParts(await readGltf(recipe.sourceId, 'gltf/scene.gltf'));
  if (parts.length === 0) throw new Error(`${recipe.sourceId}: the scan has no geometry`);
  const merged = weldPart(mergeParts(parts, HERMIT_MATERIAL));
  const rawBounds = boundsOf(merged.positions);
  const rawLongest = Math.max(...[0, 1, 2].map((a) => rawBounds.max[a]! - rawBounds.min[a]!));

  const forward = unit(recipe.forward);
  const up = unit(recipe.up);
  if (Math.abs(dot(forward, up)) > 1e-6)
    throw new Error('hermit: the recipe forward and up are not perpendicular');
  const right = unit(cross(up, forward));
  const { dense, shell } = isolateBodies(
    weldDense(merged, NO_COLOUR_MAP, rawLongest / 200000),
    forward,
    recipe.debrisShare,
  );
  const origin = areaCentroid(dense.positions, dense.indices);
  orient(dense.positions, { origin, right, up, forward });
  const count = dense.positions.length / 3;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    if (shell[i])
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, dense.positions[i * 3 + a]!);
        hi[a] = Math.max(hi[a]!, dense.positions[i * 3 + a]!);
      }
  const shellLength = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const scale = standardLengthM / shellLength;
  for (let i = 0; i < dense.positions.length; i++) dense.positions[i] = dense.positions[i]! * scale;

  const crab = subsetOf(dense, (v) => shell[v] === 0);
  const seg = segmentCrab(crab.positions, crab.indices, recipe);
  const crabCount = crab.source.length;

  const hipLateral = seg.hip[0];
  for (let i = 0; i < dense.positions.length; i += 3)
    dense.positions[i] = dense.positions[i]! - hipLateral;
  for (let i = 0; i < crab.positions.length; i += 3)
    crab.positions[i] = crab.positions[i]! - hipLateral;
  const pieceFrame = seg.pieces.map((p, i) => {
    const members: number[] = [];
    for (let v = 0; v < crabCount; v++) if (seg.piece[v] === i) members.push(v);
    const c: Vec3 = [0, 0, 0];
    for (const v of members)
      for (let a = 0; a < 3; a++) c[a]! += crab.positions[v * 3 + a]! / members.length;
    const isLeg = p.kind === CRAB_KIND.leg;
    const ends = isLeg ? limbEnds(crab.positions, members, seg.weight) : null;
    return {
      kind: p.kind as number,
      lateral: c[0],
      ahead: c[2],
      rootAhead: ends ? ends.root[2] : 0,
      reach: ends ? Math.hypot(...([0, 1, 2].map((a) => ends.root[a]! - ends.tip[a]!) as Vec3)) : 0,
    };
  });
  const margin = recipe.minLegLateralFraction * standardLengthM;
  pieceFrame.forEach((p, i) => {
    if (p.kind === CRAB_KIND.leg && Math.abs(p.lateral) < margin)
      throw new Error(
        `hermit: leg piece ${i} sits ${(Math.abs(p.lateral) * 1000).toFixed(2)} mm from the hip plane, under the ${(margin * 1000).toFixed(2)} mm margin, so its side is unreliable; adjust the segmentation recipe`,
      );
  });
  const limbIndex = assignLimbIndices(pieceFrame);

  const kind = new Uint8Array(count).fill(CRAB_KIND.shell);
  const ids = new Float32Array(count);
  const weights = new Float32Array(count);
  const limb = new Float32Array(count);
  let standoff = 0;
  let stemMinZ = Infinity;
  let stemY = 0;
  let stemCount = 0;
  let rearZ = Infinity;
  for (let i = 0; i < count; i++)
    if (shell[i]) rearZ = Math.min(rearZ, dense.positions[i * 3 + 2]!);
  crab.source.forEach((v, k) => {
    const part = seg.kind[k]!;
    kind[v] = part;
    const y = dense.positions[v * 3 + 1]!;
    if (part === CRAB_KIND.stem) {
      ids[v] = SHRIMP_PART_IDS.abdomen;
      stemMinZ = Math.min(stemMinZ, dense.positions[v * 3 + 2]!);
      stemY += y;
      stemCount++;
    } else {
      ids[v] = part === CRAB_KIND.leg ? SHRIMP_PART_IDS.leg : SHRIMP_PART_IDS.antenna;
      weights[v] = seg.weight[k]!;
      limb[v] = limbIndex[seg.piece[k]!]!;
      if (part === CRAB_KIND.leg) standoff = Math.max(standoff, -y);
    }
  });
  if (stemCount === 0)
    throw new Error('hermit: no exposed soft body found; recheck the segmentation recipe');
  if (!(stemMinZ > rearZ))
    throw new Error('hermit: the soft body starts behind the shell; recheck the orientation');
  dense.extra[FIN_ID_ATTRIBUTE] = ids;
  dense.extra[FIN_MASK_ATTRIBUTE] = weights;
  dense.extra[LEG_ATTRIBUTE] = limb;

  const shellVertices: Vec3[] = [];
  for (let i = 0; i < count; i++) if (shell[i]) shellVertices.push(pointAt(dense.positions, i));
  const shape = principalAxes(shellVertices);
  for (let i = 0; i < count; i++) {
    if (!shell[i]) continue;
    const rgb = shellColour(
      pointAt(dense.positions, i),
      shape.centre,
      shape.axes,
      shellLength * scale,
    );
    for (let c = 0; c < 3; c++) dense.colours[i * 3 + c] = rgb[c]!;
  }
  recolourDense(dense, kind, weights);

  const baked = bakeScanPart(dense, HERMIT_MATERIAL, {
    targetTriangles: recipe.maxTriangles,
    atlasSize: recipe.textureSize,
    gutter: 4,
    bleed: 6,
    colourWeight: 0.5,
  });
  const image = baked.image;

  const material: MaterialDef = {
    name: HERMIT_MATERIAL,
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image },
    roughness: 0.5,
    metallic: 0,
    alphaMode: 'OPAQUE',
    doubleSided: false,
    normalScale: 1,
  };
  const plan: LodPlan = {
    ratios: [1, 0.4, 0.15],
    minTriangles: 400,
    keepSeams: true,
    finish: keepLargeComponents(0.05),
  };
  const built = buildDocument(recipe.id, [baked.part], [material]);
  const asset = await emitAsset({
    outRoot: ctx.outRoot,
    kind: 'crab',
    id: recipe.id,
    built,
    plan,
    meta: {
      species: recipe.species,
      origin: 'model',
      sources: [recipe.sourceId],
      licence: ctx.licenceOf(recipe.sourceId),
      modifications: [
        'scan: the 9 glTF chunks merged and duplicate vertices welded by position; the unused normals and vertex colours dropped, and the few stray fragments away from the two bodies removed',
        'segmented into the rigid shell, the exposed soft body and limbs (claws, walking legs, antennae) by a voxel opening of the crab; limb pieces carry a root-to-tip weight and a leg index',
        'oriented to +Z forward (towards the claws) / +Y up, origin at the area centroid, shifted sideways onto the hip of the crab so the side of a leg is the sign of its x, scaled so the shell longest edge is the standard length',
        '_FIN_ID part ids 0 shell, 6 walking leg and claw, 7 antenna, 9 exposed soft body (rigid); _FIN_MASK weight along the limb; _LEG limb index pair * 2 + side, side 0 = -x, pair 0 the claws',
        `re-simplified to ${recipe.maxTriangles} triangles for LOD0 (LOD1 and LOD2 at 40% and 15% of that, simplified with UV seams kept), box-projected into a fresh ${recipe.textureSize} px atlas and the colour baked from procedural per-vertex colours`,
        'procedural colour added, since the scan has none: banded and flecked shell, blue legs and claws with orange joints, orange antennae; every LOD keeps the shell and the crab and drops stray fragments',
        fromSpecies !== null
          ? `length is the shell length (${standardLengthM} m) from content/species/hermit-crab.json`
          : `length is the shell length (${standardLengthM} m) taken from the recipe: no species JSON exists`,
        `legs welded together in the scan are split by direction from the hip so each of the ${recipe.legsPerSide} legs a side has its own slot, numbered fore to aft per side`,
        recipe.note,
      ],
      crab: {
        standardLengthM,
        lengthSource: fromSpecies !== null ? 'species-json' : 'recipe',
        axes: { forward: '+z', up: '+y' },
        origin: 'centre-of-mass',
        standoffM: standoff,
        attributes: { partId: FIN_ID_ATTRIBUTE, weight: FIN_MASK_ATTRIBUTE, limb: LEG_ATTRIBUTE },
        partIds: { ...SHRIMP_PART_IDS },
        legPairs: 5,
        pleopodPairs: 0,
        abdomenHinge: { y: stemY / stemCount, z: stemMinZ },
        telsonZ: rearZ,
        debugRender: `debug/${recipe.id}.png`,
        debugPartsRender: `debug/${recipe.id}-parts.png`,
      },
    },
  });
  await writeShippedDebugRenders(
    ctx.repoRoot,
    ctx.outRoot,
    'crab',
    recipe.id,
    { [HERMIT_MATERIAL]: image },
    partColours,
  );
  return asset;
}
