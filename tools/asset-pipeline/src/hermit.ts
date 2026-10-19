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
import { writeShippedDebugRenders } from './crew-debug.ts';
import { weldDense, type Dense } from './rebake.ts';
import { bakeScanPart } from './scan-bake.ts';
import { createGrid, fillSolid, open, rasteriseSurface, toCell, voxelIndex } from './voxel.ts';

export interface HermitRecipe {
  id: string;
  species: string;
  sourceId: string;
  dropMeshes: RegExp;
  fallbackLengthM: number;
  maxTriangles: number;
  /** Antenna islands smaller than this many vertices after simplification are loose debris and are removed. */
  minAntennaVertices: number;
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
    fallbackLengthM: 0.03,
    maxTriangles: 12000,
    minAntennaVertices: 25,
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

/** Removes antenna islands of fewer than `minVertices` vertices: simplified hair-thin antennae leave loose orange flecks. */
export function dropAntennaFlecks(part: Part, quantum: number, minVertices: number): Part {
  const ids = part.extra[FIN_ID_ATTRIBUTE]!;
  const count = ids.length;
  const canon = canonicalVertices(part.positions, quantum);
  const antenna = (v: number): boolean => ids[v] === SHRIMP_PART_IDS.antenna;
  const islands = connectedComponents(canon, part.indices, antenna);
  const kept: number[] = [];
  for (let t = 0; t < part.indices.length; t += 3) {
    const tri = [part.indices[t]!, part.indices[t + 1]!, part.indices[t + 2]!];
    const fleck = tri.some((v) => antenna(v) && islands.sizes[islands.label[v]!]! < minVertices);
    if (!fleck) kept.push(...tri);
  }
  const remap = new Int32Array(count).fill(-1);
  const order: number[] = [];
  const indices = Uint32Array.from(kept, (v) => {
    if (remap[v]! < 0) {
      remap[v] = order.length;
      order.push(v);
    }
    return remap[v]!;
  });
  const gather = (source: Float32Array<ArrayBuffer>, size: number): Float32Array<ArrayBuffer> => {
    const out = new Float32Array(order.length * size);
    order.forEach((v, k) => out.set(source.subarray(v * size, v * size + size), k * size));
    return out;
  };
  const extra: Part['extra'] = {};
  for (const [key, values] of Object.entries(part.extra)) extra[key] = gather(values, 1);
  return {
    ...part,
    positions: gather(part.positions, 3),
    normals: gather(part.normals, 3),
    uvs: gather(part.uvs, 2),
    indices,
    extra,
  };
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

  const dense = weldDense(part, scan.image, standardLengthM / 4000);
  const denseKind = Uint8Array.from(dense.extra[FIN_ID_ATTRIBUTE]!, (id) =>
    id === SHRIMP_PART_IDS.abdomen
      ? CRAB_KIND.stem
      : id === SHRIMP_PART_IDS.leg
        ? CRAB_KIND.leg
        : id === SHRIMP_PART_IDS.antenna
          ? CRAB_KIND.antenna
          : CRAB_KIND.shell,
  );
  recolourDense(dense, denseKind, dense.extra[FIN_MASK_ATTRIBUTE]!);
  const baked = bakeScanPart(dense, HERMIT_MATERIAL, {
    targetTriangles: recipe.maxTriangles,
    atlasSize: recipe.textureSize,
    gutter: 4,
    bleed: 6,
    colourWeight: 0.5,
  });
  const image = baked.image;
  const cleaned = dropAntennaFlecks(baked.part, standardLengthM / 4000, recipe.minAntennaVertices);

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
  const plan: LodPlan = { ratios: [1, 0.4, 0.15], minTriangles: 400, keepSeams: true };
  const built = buildDocument(recipe.id, [cleaned], [material]);
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
        'photogrammetry scan: colour-checker cube removed, merged and welded by position',
        'segmented into rigid shell, exposed soft body and limbs by a voxel opening; limb pieces carry a root-to-tip weight and a leg index',
        'oriented to +Z forward (towards the legs) / +Y up, origin at the area centroid, scaled so the shell longest edge is the standard length',
        '_FIN_ID part ids 0 shell, 6 walking leg, 7 antenna, 9 exposed soft body (rigid); _FIN_MASK weight along the limb; _LEG limb index pair * 2 + side, side 0 = -x',
        `re-simplified to ${recipe.maxTriangles} triangles for LOD0 (LOD1 and LOD2 at 40% and 15% of that, simplified with UV seams kept), box-projected into a fresh ${recipe.textureSize} px atlas and the colour re-baked from the scan's vertex colours, so simplification cannot scramble the scan texture`,
        'limb and soft-body colours painted per vertex from the segmentation before the bake; antenna fragments below a vertex floor dropped',
        `length is the shell length (${standardLengthM} m) taken from the recipe: no content/species/hermit-crab.json exists yet, and a species file is a separate contract PR`,
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
