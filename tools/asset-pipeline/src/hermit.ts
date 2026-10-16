import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import {
  areaCentroid,
  boundsOf,
  canonicalVertices,
  connectedComponents,
  loadScan,
  place,
  pointAt,
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
import { vertexNormals } from './loft.ts';
import { clamp, cross, type Vec3 } from './math.ts';
import type { MaterialDef, Part } from './parts.ts';
import { renderSheet } from './raster.ts';
import type { Rgba } from './textures.ts';
import { createGrid, fillSolid, open, rasteriseSurface, toCell, voxelIndex } from './voxel.ts';

export interface HermitRecipe {
  id: string;
  species: string;
  sourceId: string;
  dropMeshes: RegExp;
  fallbackLengthM: number;
  maxTriangles: number;
  textureSize: number;
  /** Voxel edge as a fraction of the scan's longest edge. */
  voxelFraction: number;
  /** Radius of the opening that strips legs from the shell, as a fraction of the longest edge. */
  bodyOpeningFraction: number;
  /** Radius of the opening that separates thick limbs from antennae. */
  thinOpeningFraction: number;
  /** Non-shell components whose centroid lies beyond this fraction of the +z extent are the crab. */
  crabZFraction: number;
  /** Limb pieces start where a vertex is farther than this fraction of the farthest from the hip. */
  limbCutFraction: number;
  /** Limb pieces reaching less than this fraction of the farthest radius are folded into the stem. */
  minPieceReach: number;
  note: string;
}

export const HERMIT_RECIPES: HermitRecipe[] = [
  {
    id: 'hermit-crab',
    species: 'hermit-crab',
    sourceId: 'sketchfab-5ebe7794',
    dropMeshes: /^Object_0$/,
    fallbackLengthM: 0.02,
    maxTriangles: 25000,
    textureSize: 2048,
    voxelFraction: 1 / 200,
    bodyOpeningFraction: 0.03,
    thinOpeningFraction: 0.006,
    crabZFraction: 0.55,
    limbCutFraction: 0.35,
    minPieceReach: 0.15,
    note: 'legs and antennae recoloured towards Clibanarius tricolor (blue legs, orange joints and antennae) by eye from the reference description; the scan is Clibanarius longitarsus',
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
  shellCentroid: Vec3;
}

export interface LimbPiece {
  kind: typeof CRAB_KIND.leg | typeof CRAB_KIND.antenna;
  vertices: number;
  centroid: Vec3;
}

interface SegmentOptions {
  voxelFraction: number;
  bodyOpeningFraction: number;
  thinOpeningFraction: number;
  crabZFraction: number;
  limbCutFraction: number;
  minPieceReach: number;
}

function cellAt(grid: ReturnType<typeof createGrid>, p: Vec3): [number, number, number] {
  return [toCell(grid, p[0], 0), toCell(grid, p[1], 1), toCell(grid, p[2], 2)];
}

function inGrid(grid: ReturnType<typeof createGrid>, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < grid.nx && y < grid.ny && z < grid.nz;
}

/**
 * Splits a crab-in-a-shell scan into the rigid shell and the limbs hanging from its mouth. A morphological
 * opening keeps only the bulky shell; what it removes and what hangs towards +z is the crab. Limb pieces are
 * the parts of the crab farther from the hip than a cut radius.
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
  const bulky = open(grid, solid, (options.bodyOpeningFraction * longest) / voxel);
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

  const bodyMask = new Uint8Array(count);
  for (let i = 0; i < count; i++) bodyMask[i] = inside(bulky, pointAt(positions, i), 2) ? 1 : 0;

  const canon = canonicalVertices(positions, voxel / 4);
  const loose = connectedComponents(canon, indices, (v) => bodyMask[v] === 0);
  const sums = loose.sizes.map(() => [0, 0, 0] as Vec3);
  for (let i = 0; i < count; i++) {
    const c = loose.label[i]!;
    if (c < 0) continue;
    for (let a = 0; a < 3; a++) sums[c]![a]! += positions[i * 3 + a]!;
  }
  const zLimit = min[2] + (max[2] - min[2]) * options.crabZFraction;
  const crabComponents = new Set<number>();
  loose.sizes.forEach((size, c) => {
    if (size >= 100 && sums[c]![2]! / size > zLimit) crabComponents.add(c);
  });
  const isCrab = new Uint8Array(count);
  for (let i = 0; i < count; i++) isCrab[i] = crabComponents.has(loose.label[i]!) ? 1 : 0;

  const hip: Vec3 = [0, 0, 0];
  let hipCount = 0;
  const bodyCells = new Set<number>();
  for (let i = 0; i < count; i++)
    if (bodyMask[i]) {
      const [x, y, z] = cellAt(grid, pointAt(positions, i));
      bodyCells.add(voxelIndex(grid, x, y, z));
    }
  for (let i = 0; i < count; i++) {
    if (!isCrab[i]) continue;
    const [cx, cy, cz] = cellAt(grid, pointAt(positions, i));
    let near = false;
    for (let dz = -3; dz <= 3 && !near; dz++)
      for (let dy = -3; dy <= 3 && !near; dy++)
        for (let dx = -3; dx <= 3; dx++)
          if (bodyCells.has(voxelIndex(grid, cx + dx, cy + dy, cz + dz))) {
            near = true;
            break;
          }
    if (near) {
      hipCount++;
      for (let a = 0; a < 3; a++) hip[a]! += positions[i * 3 + a]!;
    }
  }
  if (hipCount === 0)
    throw new Error('segmentCrab: the crab does not touch the shell; recheck the recipe');
  for (let a = 0; a < 3; a++) hip[a]! /= hipCount;

  const radius = new Float32Array(count);
  let farthest = 0;
  for (let i = 0; i < count; i++)
    if (isCrab[i]) {
      const p = pointAt(positions, i);
      radius[i] = Math.hypot(p[0] - hip[0], p[1] - hip[1], p[2] - hip[2]);
      farthest = Math.max(farthest, radius[i]!);
    }
  const cut = farthest * options.limbCutFraction;
  const limbs = connectedComponents(canon, indices, (v) => isCrab[v] === 1 && radius[v]! >= cut);

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

  const kind = new Uint8Array(count).fill(CRAB_KIND.shell);
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
    if (!isCrab[i]) continue;
    const p = pieceOf.get(limbs.label[i]!);
    if (p === undefined) {
      kind[i] = CRAB_KIND.stem;
      continue;
    }
    const r = reach[limbs.label[i]!]!;
    kind[i] = pieces[p]!.kind;
    piece[i] = p;
    weight[i] = clamp((radius[i]! - r.low) / (r.high - r.low), 0, 1);
  }

  const shell: Vec3 = [0, 0, 0];
  let shellCount = 0;
  for (let i = 0; i < count; i++)
    if (kind[i] === CRAB_KIND.shell && bodyMask[i]) {
      shellCount++;
      for (let a = 0; a < 3; a++) shell[a]! += positions[i * 3 + a]!;
    }
  for (let a = 0; a < 3; a++) shell[a]! /= Math.max(1, shellCount);
  return { kind, piece, weight, pieces, hip, shellCentroid: shell };
}

/**
 * Walking pairs run front to back, so the two picking pairs are the frontmost legs; long antennae take
 * the 2/3 slot. `lateral` and `ahead` are the piece centroids in the model frame.
 */
export function assignLimbIndices(
  pieces: { kind: number; lateral: number; ahead: number }[],
): number[] {
  const legs = pieces
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.kind === CRAB_KIND.leg)
    .sort((a, b) => b.ahead - a.ahead);
  const index = new Array<number>(pieces.length).fill(-1);
  const taken = new Set<number>();
  const takeFree = (preferred: number): number => {
    let candidate = preferred;
    while (taken.has(candidate)) candidate += 2;
    taken.add(candidate);
    return candidate;
  };
  legs.forEach((leg, rank) => {
    const side = leg.lateral < 0 ? 0 : 1;
    index[leg.i] = takeFree(Math.min(rank, 4) * 2 + side);
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

const STEM: Rgb = [0.2, 0.12, 0.08];
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

export interface PaintMask {
  kind: Uint8Array;
  weight: Float32Array;
  width: number;
  height: number;
}

/** Rasterises every triangle whose three vertices are crab into UV space, then grows the mask to cover seams. */
export function paintMask(
  uvs: Float32Array,
  indices: Uint32Array,
  kind: Uint8Array,
  weight: Float32Array,
  size: number,
  growTexels = 2,
): PaintMask {
  const texKind = new Uint8Array(size * size);
  const texWeight = new Float32Array(size * size);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const k = kind[a]!;
    if (k === CRAB_KIND.shell || kind[b] === CRAB_KIND.shell || kind[c] === CRAB_KIND.shell)
      continue;
    const ux = [uvs[a * 2]! * size, uvs[b * 2]! * size, uvs[c * 2]! * size];
    const uy = [uvs[a * 2 + 1]! * size, uvs[b * 2 + 1]! * size, uvs[c * 2 + 1]! * size];
    const x0 = Math.max(0, Math.floor(Math.min(...ux)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(...ux)));
    const y0 = Math.max(0, Math.floor(Math.min(...uy)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(...uy)));
    const det = (uy[1]! - uy[2]!) * (ux[0]! - ux[2]!) + (ux[2]! - ux[1]!) * (uy[0]! - uy[2]!);
    if (Math.abs(det) < 1e-9) {
      const x = clamp(Math.floor((ux[0]! + ux[1]! + ux[2]!) / 3), 0, size - 1);
      const y = clamp(Math.floor((uy[0]! + uy[1]! + uy[2]!) / 3), 0, size - 1);
      texKind[y * size + x] = k;
      texWeight[y * size + x] = (weight[a]! + weight[b]! + weight[c]!) / 3;
      continue;
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const l0 = ((uy[1]! - uy[2]!) * (px - ux[2]!) + (ux[2]! - ux[1]!) * (py - uy[2]!)) / det;
        const l1 = ((uy[2]! - uy[0]!) * (px - ux[2]!) + (ux[0]! - ux[2]!) * (py - uy[2]!)) / det;
        const l2 = 1 - l0 - l1;
        if (l0 < -0.05 || l1 < -0.05 || l2 < -0.05) continue;
        texKind[y * size + x] = k;
        texWeight[y * size + x] = l0 * weight[a]! + l1 * weight[b]! + l2 * weight[c]!;
      }
  }
  for (let pass = 0; pass < growTexels; pass++) {
    const nextKind = texKind.slice();
    const nextWeight = texWeight.slice();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (texKind[y * size + x]) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const source = texKind[ny * size + nx]!;
          if (source) {
            nextKind[y * size + x] = source;
            nextWeight[y * size + x] = texWeight[ny * size + nx]!;
            break;
          }
        }
      }
    texKind.set(nextKind);
    texWeight.set(nextWeight);
  }
  return { kind: texKind, weight: texWeight, width: size, height: size };
}

/** Recolours the masked texels, keeping the scan's own light and shadow as a multiplier. */
export function recolour(image: Rgba, mask: PaintMask): Rgba {
  if (image.width !== mask.width || image.height !== mask.height)
    throw new Error('recolour: mask and image sizes differ');
  const data = new Uint8Array(image.data);
  const lum = (o: number): number =>
    (0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!) / 255;
  const sums: Record<number, { sum: number; n: number }> = {};
  for (let i = 0; i < mask.kind.length; i++) {
    const k = mask.kind[i]!;
    if (!k) continue;
    const entry = (sums[k] ??= { sum: 0, n: 0 });
    entry.sum += lum(i * 4);
    entry.n++;
  }
  for (let i = 0; i < mask.kind.length; i++) {
    const k = mask.kind[i]!;
    if (!k) continue;
    const mean = sums[k]!.sum / sums[k]!.n || 1;
    const shade = clamp(lum(i * 4) / mean, 0.55, 1.45);
    const rgb = crabColour(k, mask.weight[i]!);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(clamp(rgb[c]! * shade, 0, 1) * 255);
  }
  return { ...image, data };
}

const PART_RGB: Record<number, Vec3> = {
  0: [0.55, 0.55, 0.6],
  6: [0.2, 0.55, 0.95],
  7: [0.95, 0.5, 0.1],
  9: [0.75, 0.55, 0.35],
};

async function writeHermitDebugRenders(
  repoRoot: string,
  id: string,
  part: Part,
  image: Rgba,
): Promise<{ textured: string; parts: string }> {
  const dir = join(repoRoot, 'tools', 'asset-pipeline', 'debug');
  mkdirSync(dir, { recursive: true });
  const views = [
    { view: 'side', pixelsAcross: 1100 },
    { view: 'top', pixelsAcross: 1100 },
    { view: 'front', pixelsAcross: 1100 },
  ] as const;
  const mesh = { positions: part.positions, indices: part.indices, normals: part.normals };
  const textured = await renderSheet({ ...mesh, uvs: part.uvs }, [...views], {
    data: image.data,
    width: image.width,
    height: image.height,
    channels: 4,
  });
  const ids = part.extra[FIN_ID_ATTRIBUTE]!;
  const weights = part.extra[FIN_MASK_ATTRIBUTE]!;
  const limbs = part.extra[LEG_ATTRIBUTE]!;
  const colors = new Float32Array(ids.length * 3);
  for (let i = 0; i < ids.length; i++) {
    const base = PART_RGB[ids[i]!] ?? PART_RGB[0]!;
    const k = ids[i] === 0 || ids[i] === 9 ? 1 : 0.4 + 0.6 * weights[i]!;
    const tint = ids[i] === 6 ? 0.8 + 0.2 * ((limbs[i]! % 5) / 4) : 1;
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = base[c]! * k * tint;
  }
  const partsSheet = await renderSheet({ ...mesh, colors }, [...views]);
  writeFileSync(join(dir, `${id}.png`), textured);
  writeFileSync(join(dir, `${id}-parts.png`), partsSheet);
  return { textured: `debug/${id}.png`, parts: `debug/${id}-parts.png` };
}

export async function buildHermit(recipe: HermitRecipe, ctx: FishContext): Promise<OutputAsset> {
  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM = fromSpecies ?? recipe.fallbackLengthM;
  const scan = await loadScan(ctx, recipe.sourceId, recipe.dropMeshes, recipe.textureSize);
  const part = scan.part;
  part.material = HERMIT_MATERIAL;
  const seg = segmentCrab(part.positions, part.indices, recipe);

  const up: Vec3 = [0, 1, 0];
  const toCrab = sub(seg.hip, seg.shellCentroid);
  const forward = unit([toCrab[0], 0, toCrab[2]]);
  const right = unit(cross(up, forward));
  const origin = areaCentroid(part.positions, part.indices);
  place(part, { origin, right, up, forward, scale: 1, shift: [0, 0, 0] });

  const count = part.positions.length / 3;
  const shellPoints: number[] = [];
  for (let i = 0; i < count; i++) if (seg.kind[i] === CRAB_KIND.shell) shellPoints.push(i);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const i of shellPoints)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, part.positions[i * 3 + a]!);
      hi[a] = Math.max(hi[a]!, part.positions[i * 3 + a]!);
    }
  const shellLength = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const scale = standardLengthM / shellLength;
  for (let i = 0; i < part.positions.length; i++) part.positions[i] = part.positions[i]! * scale;
  part.normals.set(vertexNormals(part.positions, part.indices));

  const pieceFrame = seg.pieces.map((p, i) => {
    const members: number[] = [];
    for (let v = 0; v < count; v++) if (seg.piece[v] === i) members.push(v);
    const c: Vec3 = [0, 0, 0];
    for (const v of members)
      for (let a = 0; a < 3; a++) c[a]! += part.positions[v * 3 + a]! / members.length;
    return { kind: p.kind as number, lateral: c[0], ahead: c[2] };
  });
  const limbIndex = assignLimbIndices(pieceFrame);

  const ids = new Float32Array(count);
  const weights = new Float32Array(count);
  const limb = new Float32Array(count);
  let standoff = 0;
  let stemMinZ = Infinity;
  let stemY = 0;
  let stemCount = 0;
  let rearZ = Infinity;
  for (let i = 0; i < count; i++) {
    const k = seg.kind[i]!;
    const y = part.positions[i * 3 + 1]!;
    const z = part.positions[i * 3 + 2]!;
    if (k === CRAB_KIND.shell) {
      ids[i] = SHRIMP_PART_IDS.body;
      rearZ = Math.min(rearZ, z);
    } else if (k === CRAB_KIND.stem) {
      ids[i] = SHRIMP_PART_IDS.abdomen;
      stemMinZ = Math.min(stemMinZ, z);
      stemY += y;
      stemCount++;
    } else {
      ids[i] = k === CRAB_KIND.leg ? SHRIMP_PART_IDS.leg : SHRIMP_PART_IDS.antenna;
      weights[i] = seg.weight[i]!;
      limb[i] = limbIndex[seg.piece[i]!]!;
      if (k === CRAB_KIND.leg) standoff = Math.max(standoff, -y);
    }
  }
  if (stemCount === 0)
    throw new Error('hermit: no exposed soft body found; recheck the segmentation recipe');
  if (!(stemMinZ > rearZ))
    throw new Error('hermit: the soft body starts behind the shell; recheck the orientation');
  part.extra[FIN_ID_ATTRIBUTE] = ids;
  part.extra[FIN_MASK_ATTRIBUTE] = weights;
  part.extra[LEG_ATTRIBUTE] = limb;

  const mask = paintMask(part.uvs, part.indices, seg.kind, seg.weight, scan.image.width);
  const image = recolour(scan.image, mask);
  const debug = await writeHermitDebugRenders(ctx.repoRoot, recipe.id, part, image);

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
  const triangles = part.indices.length / 3;
  const lod0 = Math.min(1, recipe.maxTriangles / triangles);
  const plan: LodPlan = { ratios: [lod0, lod0 * 0.4, lod0 * 0.15], minTriangles: 400 };
  const built = buildDocument(recipe.id, [part], [material]);
  return emitAsset({
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
        'photogrammetry scan: colour-checker cube removed, merged and welded, texture downscaled to 2048 px and re-encoded to KTX2',
        'segmented into rigid shell, exposed soft body and limbs by a voxel opening; limb pieces carry a root-to-tip weight and a leg index',
        'oriented to +Z forward (towards the legs) / +Y up, origin at the area centroid, scaled so the shell longest edge is the standard length',
        '_FIN_ID part ids 0 shell, 6 walking leg, 7 antenna, 9 exposed soft body (rigid); _FIN_MASK weight along the limb; _LEG limb index pair * 2 + side, side 0 = -x',
        `LOD0 capped at ${recipe.maxTriangles} triangles, LOD1 and LOD2 simplified further`,
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
        debugRender: debug.textured,
        debugPartsRender: debug.parts,
      },
    },
  });
}
