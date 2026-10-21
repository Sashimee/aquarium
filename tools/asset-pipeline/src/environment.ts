import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Document, Material } from '@gltf-transform/core';
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
import { addPores, packArm, tintImage, upscaleTo, type PoreSpec, type TintSpec } from './finish.ts';
import { writeFileTracked } from './glb.ts';
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
import {
  HDR_ENCODER_MAX,
  clampPixels,
  decodeRgbe,
  encodeRgbe,
  flipVertical,
  halve,
} from './rgbe.ts';
import { decodeImage, encodeHdrKtx2, type Rgba } from './textures.ts';

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
  /** LOD1 triangle count as a fraction of LOD0, default 0.35; LOD2 is 0.3 of LOD1 when set, else 0.12 of LOD0. */
  lod1Fraction?: number;
  /** Removes triangles whose centroid lies in the lowest fraction of the height (a museum plinth, a scan base). */
  clipBelowFraction?: number;
  /** With `clipBelowFraction`, scales so `longestM` refers to the uncropped scan, keeping the metric scale the full scan would have had. */
  keepUncroppedScale?: boolean;
  material?: MaterialOptions;
  /** Paint a green leaf texture for sources that only carry a flat colour. */
  proceduralLeafTexture?: boolean;
  /** Recolours the base colour map by luminance. */
  tint?: TintSpec;
  /** Adds procedural pores to the normal and colour maps; both are upscaled to 2048 px first. */
  pores?: PoreSpec;
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

function longestEdge(parts: Part[]): number {
  const { min, max } = bounds(parts);
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
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

function sameValues(
  a: ArrayLike<number> | null | undefined,
  b: ArrayLike<number> | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A texture on TEXCOORD_n is exportable only when that set is a copy of TEXCOORD_0 on every primitive. */
function assertTexcoordZero(doc: Document, source: Material, recipe: string): void {
  const specGloss = source.getExtension<PBRSpecularGlossiness>(
    KHRMaterialsPBRSpecularGlossiness.EXTENSION_NAME,
  );
  const infos = [
    specGloss ? specGloss.getDiffuseTextureInfo() : source.getBaseColorTextureInfo(),
    source.getNormalTextureInfo(),
  ];
  for (const info of infos) {
    const set = info?.getTexCoord() ?? 0;
    if (set === 0) continue;
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMaterial() !== source) continue;
        const target = prim.getAttribute(`TEXCOORD_${set}`);
        const first = prim.getAttribute('TEXCOORD_0');
        const same =
          target?.getNormalized() === first?.getNormalized() &&
          sameValues(target?.getArray(), first?.getArray());
        if (!same)
          throw new Error(
            `${recipe}: material "${source.getName()}" samples TEXCOORD_${set}, which differs from TEXCOORD_0; only TEXCOORD_0 is exported`,
          );
      }
  }
}

async function finishMaterial(def: MaterialDef, recipe: EnvironmentRecipe): Promise<MaterialDef> {
  if (!recipe.tint && !recipe.pores) return def;
  if (!def.baseColor) throw new Error(`${recipe.id}: tint and pores need a base colour texture`);
  let image = recipe.pores ? await upscaleTo(def.baseColor.image, 2048) : def.baseColor.image;
  if (recipe.tint) image = tintImage(image, recipe.tint);
  let normal = def.normal;
  if (recipe.pores) {
    if (!normal) throw new Error(`${recipe.id}: pores need a normal map to perturb`);
    const detailed = addPores(image, await upscaleTo(normal.image, 2048), recipe.pores);
    image = detailed.baseColor;
    normal = { ...normal, image: detailed.normal };
  }
  return {
    ...def,
    baseColor: { ...def.baseColor, image },
    ...(normal ? { normal } : {}),
  };
}

export function cropForRecipe(
  parts: Part[],
  recipe: Pick<EnvironmentRecipe, 'longestM' | 'clipBelowFraction' | 'keepUncroppedScale'>,
): { parts: Part[]; longestM: number } {
  const uncropped = longestEdge(parts);
  const kept =
    recipe.clipBelowFraction === undefined ? parts : clipBelow(parts, recipe.clipBelowFraction);
  const longestM = recipe.keepUncroppedScale
    ? (recipe.longestM * longestEdge(kept)) / uncropped
    : recipe.longestM;
  return { parts: kept, longestM };
}

export async function loadEnvironment(
  recipe: EnvironmentRecipe,
  ctx: Pick<FishContext, 'verifySource'>,
): Promise<{ parts: Part[]; materials: MaterialDef[] }> {
  ctx.verifySource(recipe.sourceId);
  const doc = await readGltf(recipe.sourceId, recipe.gltf ?? 'gltf/scene.gltf');
  const dropMesh = recipe.dropMeshes;
  bakeToWorldSpace(
    doc,
    (name) => (dropMesh ? dropMesh.test(name) : false),
    recipe.skinPose ?? 'bind',
  );

  let parts = extractParts(doc).map(weldPart);
  if (parts.length === 0) throw new Error(`${recipe.id}: no geometry left after dropping meshes`);
  const cropped = cropForRecipe(parts, recipe);
  parts = cropped.parts;
  normaliseToBase(parts, cropped.longestM);

  const used = new Set(parts.map((p) => p.material));
  const materials: MaterialDef[] = [];
  for (const source of doc.getRoot().listMaterials()) {
    if (!used.has(source.getName())) continue;
    assertTexcoordZero(doc, source, recipe.id);
    let def = await materialDefFrom(source, { metallic: 0, ...recipe.material });
    def = await finishMaterial(def, recipe);
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

  return { parts, materials };
}

export async function buildEnvironment(
  recipe: EnvironmentRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  const { parts, materials } = await loadEnvironment(recipe, ctx);
  const triangles = parts.reduce((s, p) => s + p.indices.length / 3, 0);
  const lod0 = Math.min(1, recipe.maxTriangles / triangles);
  const lod1 = recipe.lod1Fraction ?? 0.35;
  const lod2 = recipe.lod1Fraction === undefined ? 0.12 : lod1 * 0.3;
  const plan: LodPlan = { ratios: [lod0, lod0 * lod1, lod0 * lod2], minTriangles: 200 };

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
        `origin at the centre of the base, scaled so the longest edge is ${recipe.longestM} m${recipe.keepUncroppedScale ? ' before cropping' : ''}`,
        `LOD0 capped at ${recipe.maxTriangles} triangles, LOD1 and LOD2 simplified further`,
        recipe.pores
          ? 'textures re-encoded to KTX2 at 1k and 2k, PBR metallic-roughness with constant roughness'
          : 'textures downscaled and re-encoded to KTX2 at 1k and 2k, PBR metallic-roughness with constant roughness',
        ...recipe.modifications,
      ],
    },
  });
}

export interface SubstrateRecipe {
  id: string;
  sourceId: string;
  /** Poly Haven naming: `<prefix>_diff|nor_gl|arm_2k.jpg`. */
  prefix?: string;
  /** Separate occlusion and roughness maps (ambientCG), packed into an ARM texture here. */
  files?: { diff: string; normal: string; occlusion: string; roughness: string };
}

export async function buildSubstrate(
  recipe: SubstrateRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  ctx.verifySource(recipe.sourceId);
  const dir = join(RAW_ROOT, recipe.sourceId);
  const loadFile = async (name: string): Promise<Rgba> =>
    decodeImage(readFileSync(join(dir, name)));
  const load = async (suffix: string): Promise<Rgba> => {
    if (recipe.files) {
      const { files } = recipe;
      if (suffix === 'diff') return loadFile(files.diff);
      if (suffix === 'nor_gl') return loadFile(files.normal);
      return packArm(await loadFile(files.occlusion), await loadFile(files.roughness));
    }
    if (!recipe.prefix) throw new Error(`${recipe.id}: substrate recipe needs a prefix or files`);
    return loadFile(`${recipe.prefix}_${suffix}_2k.jpg`);
  };
  const entries: TextureEntry[] = [
    {
      name: `${recipe.id}_basecolor`,
      colorSpace: 'srgb',
      source: { role: 'baseColor', codec: 'etc1s', image: await load('diff') },
    },
    {
      name: `${recipe.id}_normal`,
      colorSpace: 'linear',
      source: { role: 'normal', codec: 'etc1s', image: await load('nor_gl') },
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
      recipe.files
        ? 'ARM packed from the separate occlusion and roughness maps; displacement map not shipped'
        : 'displacement and roughness maps not shipped',
    ],
    lods: [],
    textures,
    files,
  };
}

export interface HdriRecipe {
  id: string;
  sourceId: string;
  /** Radiance .hdr inside the raw directory. */
  file: string;
  /** Output name, `.ktx2`. */
  output: string;
  /** Number of 2x2 downsamples applied to the source before encoding. */
  halvings?: number;
}

export async function buildHdri(recipe: HdriRecipe, ctx: FishContext): Promise<OutputAsset> {
  ctx.verifySource(recipe.sourceId);
  const source = readFileSync(join(RAW_ROOT, recipe.sourceId, recipe.file));
  const halvings = recipe.halvings ?? 0;
  let image = decodeRgbe(source);
  for (let i = 0; i < halvings; i++) image = halve(image);
  const { image: limited, clamped } = clampPixels(image, HDR_ENCODER_MAX);
  // Compressed textures cannot flipY at upload and the equirect lookup expects the first row at v = 1.
  const hdr = encodeRgbe(flipVertical(limited));
  const file = writeFileTracked(
    ctx.outRoot,
    `hdri/${recipe.id}/${recipe.output}`,
    await encodeHdrKtx2(hdr),
  );
  return {
    id: recipe.id,
    kind: 'hdri',
    origin: 'texture-set',
    sources: [recipe.sourceId],
    licence: ctx.licenceOf(recipe.sourceId),
    modifications: [
      ...(halvings > 0
        ? [`downsampled ${2 ** halvings}x with a 2x2 box filter in linear light`]
        : []),
      ...(clamped > 0
        ? [`${clamped} pixel(s) above ${HDR_ENCODER_MAX} (the HDR encoder's ceiling) clamped to it`]
        : []),
      'equirectangular Radiance .hdr flipped vertically (compressed textures cannot flipY at upload) and re-encoded as KTX2 UASTC HDR 4x4 with Zstandard supercompression, no mipmaps; KTX2Loader transcodes it to BC6H or RGBA16F',
    ],
    lods: [],
    textures: [],
    files: [file],
  };
}
