import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Material } from '@gltf-transform/core';
import {
  KHRMaterialsPBRSpecularGlossiness,
  type PBRSpecularGlossiness,
} from '@gltf-transform/extensions';
import {
  buildDocument,
  emitAsset,
  writeTextureEntries,
  type LodPlan,
  type TextureEntry,
} from './emit.ts';
import type { FishContext } from './fish.ts';
import { sha256, writeFileTracked } from './glb.ts';
import type { AssetKind, OutputAsset } from './index-schema.ts';
import {
  extractParts,
  materialDefFrom,
  weldPart,
  type MaterialDef,
  type MaterialOptions,
  type Part,
} from './parts.ts';
import { RAW_ROOT, bakeToWorldSpace, readGltf, type SkinPose } from './source.ts';
import { decodeImage, type Rgba } from './textures.ts';

export interface EnvironmentRecipe {
  id: string;
  kind: Extract<AssetKind, 'plant' | 'coral' | 'driftwood' | 'rock' | 'decor'>;
  sourceId: string;
  /** Path of the glTF inside the raw directory. */
  gltf?: string;
  skinPose?: SkinPose;
  /** Meshes whose name matches are removed before anything else. */
  dropMeshes?: RegExp;
  /** Longest bounding-box edge in metres after normalisation. */
  longestM: number;
  /** Triangle budget for LOD0; the source is simplified to it when heavier. */
  maxTriangles: number;
  /** Removes triangles whose centroid lies in the lowest fraction of the height (a museum plinth, a scan base). */
  clipBelowFraction?: number;
  material?: MaterialOptions;
  /** Paint a green leaf texture for sources that only carry a flat colour. */
  proceduralLeafTexture?: boolean;
  modifications: string[];
}

function bounds(parts: Part[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts)
    for (let i = 0; i < part.positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, part.positions[i + a]!);
        max[a] = Math.max(max[a]!, part.positions[i + a]!);
      }
  return { min, max };
}

/** Drops vertices no triangle references. */
export function compactPart(part: Part): Part {
  const count = part.positions.length / 3;
  const remap = new Int32Array(count).fill(-1);
  const kept: number[] = [];
  for (const index of part.indices) {
    if (remap[index] === -1) {
      remap[index] = kept.length;
      kept.push(index);
    }
  }
  const out: Part = {
    positions: new Float32Array(kept.length * 3),
    normals: new Float32Array(kept.length * 3),
    uvs: new Float32Array(kept.length * 2),
    indices: Uint32Array.from(part.indices, (i) => remap[i]!),
    material: part.material,
    extra: Object.fromEntries(
      Object.keys(part.extra).map((k) => [k, new Float32Array(kept.length)]),
    ),
  };
  kept.forEach((src, dst) => {
    out.positions.set(part.positions.subarray(src * 3, src * 3 + 3), dst * 3);
    out.normals.set(part.normals.subarray(src * 3, src * 3 + 3), dst * 3);
    out.uvs.set(part.uvs.subarray(src * 2, src * 2 + 2), dst * 2);
    for (const k of Object.keys(part.extra)) out.extra[k]![dst] = part.extra[k]![src]!;
  });
  return out;
}

function clipBelow(parts: Part[], fraction: number): Part[] {
  const { min, max } = bounds(parts);
  const limit = min[1] + (max[1] - min[1]) * fraction;
  return parts.map((part) => {
    const kept: number[] = [];
    for (let t = 0; t < part.indices.length; t += 3) {
      const y =
        (part.positions[part.indices[t]! * 3 + 1]! +
          part.positions[part.indices[t + 1]! * 3 + 1]! +
          part.positions[part.indices[t + 2]! * 3 + 1]!) /
        3;
      if (y >= limit) kept.push(part.indices[t]!, part.indices[t + 1]!, part.indices[t + 2]!);
    }
    return compactPart({ ...part, indices: Uint32Array.from(kept) });
  });
}

/** Moves the base centre to the origin and scales the longest edge to `longestM`. */
export function normaliseToBase(parts: Part[], longestM: number): void {
  const { min, max } = bounds(parts);
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const scale = longestM / extent;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  for (const part of parts)
    for (let i = 0; i < part.positions.length; i += 3) {
      part.positions[i] = (part.positions[i]! - cx) * scale;
      part.positions[i + 1] = (part.positions[i + 1]! - min[1]) * scale;
      part.positions[i + 2] = (part.positions[i + 2]! - cz) * scale;
    }
}

function leafTexture(): Rgba {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const vein = 0.5 + 0.5 * Math.cos((x / size) * Math.PI * 2 * 6);
      const streak = hash(x >> 2, y >> 4);
      const shade = 0.78 + 0.14 * vein + 0.1 * streak;
      const o = (y * size + x) * 4;
      data[o] = Math.round(46 * shade * 1.1);
      data[o + 1] = Math.round(112 * shade);
      data[o + 2] = Math.round(58 * shade);
      data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}

function assertTexcoordZero(source: Material, recipe: string): void {
  const specGloss = source.getExtension<PBRSpecularGlossiness>(
    KHRMaterialsPBRSpecularGlossiness.EXTENSION_NAME,
  );
  const infos = [
    specGloss ? specGloss.getDiffuseTextureInfo() : source.getBaseColorTextureInfo(),
    source.getNormalTextureInfo(),
  ];
  for (const info of infos) {
    if (info && info.getTexCoord() !== 0) {
      throw new Error(
        `${recipe}: material "${source.getName()}" samples TEXCOORD_${info.getTexCoord()}; only TEXCOORD_0 is exported`,
      );
    }
  }
}

export async function buildEnvironment(
  recipe: EnvironmentRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  const path = join(RAW_ROOT, recipe.sourceId, recipe.gltf ?? 'gltf/scene.gltf');
  const doc = await readGltf(path);
  const dropMesh = recipe.dropMeshes;
  bakeToWorldSpace(
    doc,
    (name) => (dropMesh ? dropMesh.test(name) : false),
    recipe.skinPose ?? 'bind',
  );

  let parts = extractParts(doc).map(weldPart);
  if (recipe.clipBelowFraction !== undefined) parts = clipBelow(parts, recipe.clipBelowFraction);
  if (parts.length === 0) throw new Error(`${recipe.id}: no geometry left after dropping meshes`);
  normaliseToBase(parts, recipe.longestM);

  const used = new Set(parts.map((p) => p.material));
  const materials: MaterialDef[] = [];
  for (const source of doc.getRoot().listMaterials()) {
    if (!used.has(source.getName())) continue;
    assertTexcoordZero(source, recipe.id);
    const def = await materialDefFrom(source, { metallic: 0, ...recipe.material });
    if (recipe.proceduralLeafTexture && !def.baseColor) {
      materials.push({
        ...def,
        baseColorFactor: [1, 1, 1, 1],
        baseColor: { role: 'baseColor', codec: 'etc1s', image: leafTexture() },
      });
    } else {
      materials.push(def);
    }
  }
  if (materials.length === 0) throw new Error(`${recipe.id}: no material survived`);

  const triangles = parts.reduce((s, p) => s + p.indices.length / 3, 0);
  const lod0 = Math.min(1, recipe.maxTriangles / triangles);
  const plan: LodPlan = { ratios: [lod0, lod0 * 0.35, lod0 * 0.12], minTriangles: 200 };

  const built = buildDocument(recipe.id, parts, materials);
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: recipe.kind,
    id: recipe.id,
    built,
    plan,
    meta: {
      origin: 'model',
      sources: [recipe.sourceId],
      licence: ctx.licenceOf(recipe.sourceId),
      modifications: [
        'merged meshes, dropped unused attributes, skeleton and animation',
        `origin at the centre of the base, scaled so the longest edge is ${recipe.longestM} m`,
        `LOD0 capped at ${recipe.maxTriangles} triangles, LOD1 and LOD2 simplified further`,
        'textures downscaled and re-encoded to KTX2 at 1k and 2k, PBR metallic-roughness with constant roughness',
        ...recipe.modifications,
      ],
    },
  });
}

export interface SubstrateRecipe {
  id: string;
  sourceId: string;
  prefix: string;
}

export async function buildSubstrate(
  recipe: SubstrateRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  const dir = join(RAW_ROOT, recipe.sourceId);
  const load = async (suffix: string): Promise<Rgba> =>
    decodeImage(readFileSync(join(dir, `${recipe.prefix}_${suffix}_2k.jpg`)));
  const entries: TextureEntry[] = [
    {
      name: `${recipe.id}_basecolor`,
      colorSpace: 'srgb',
      source: { role: 'baseColor', codec: 'etc1s', image: await load('diff') },
    },
    {
      name: `${recipe.id}_normal`,
      colorSpace: 'linear',
      source: { role: 'normal', codec: 'uastc', image: await load('nor_gl') },
    },
    {
      name: `${recipe.id}_arm`,
      colorSpace: 'linear',
      source: { role: 'occlusionRoughnessMetal', codec: 'etc1s', image: await load('arm') },
    },
  ];
  const { files, textures } = await writeTextureEntries(
    ctx.outRoot,
    `substrate/${recipe.id}`,
    entries,
  );
  files.sort((a, b) => (a.file < b.file ? -1 : 1));
  return {
    id: recipe.id,
    kind: 'substrate',
    origin: 'texture-set',
    sources: [recipe.sourceId],
    licence: ctx.licenceOf(recipe.sourceId),
    modifications: [
      'tileable PBR set re-encoded to KTX2 at 1k and 2k: base colour, GL normal map, ARM (occlusion, roughness, metalness)',
      'displacement and roughness maps not shipped',
    ],
    lods: [],
    textures,
    files,
  };
}

export interface HdriRecipe {
  id: string;
  sourceId: string;
  file: string;
}

export function buildHdri(recipe: HdriRecipe, ctx: FishContext): OutputAsset {
  const bytes = readFileSync(join(RAW_ROOT, recipe.sourceId, recipe.file));
  const file = writeFileTracked(ctx.outRoot, `hdri/${recipe.id}/${recipe.file}`, bytes);
  if (file.sha256 !== sha256(bytes)) throw new Error(`${recipe.id}: hash mismatch after copy`);
  return {
    id: recipe.id,
    kind: 'hdri',
    origin: 'passthrough',
    sources: [recipe.sourceId],
    licence: ctx.licenceOf(recipe.sourceId),
    modifications: ['copied unchanged (Radiance .hdr, 2k)'],
    lods: [],
    textures: [],
    files: [file],
  };
}
