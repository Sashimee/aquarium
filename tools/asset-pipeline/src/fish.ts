import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesSchema } from '@aquarium/shared';
import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import { seatEyes, type EyePlacement } from './eyes.ts';
import {
  bodyCentreOfMass,
  classifyFins,
  finDebugColors,
  medianX,
  orient,
  scaleCaudal,
  type Axes,
  type FinHints,
} from './fins.ts';
import { FIN_ID_ATTRIBUTE, FIN_IDS, FIN_MASK_ATTRIBUTE, type OutputAsset } from './index-schema.ts';
import { extractParts, materialDefFrom, mergeParts, weldPart, type Part } from './parts.ts';
import { renderSheet } from './raster.ts';
import { bakeToWorldSpace, readGltf, type SkinPose } from './source.ts';

export const FISH_LOD_PLAN: LodPlan = { ratios: [1, 0.4, 0.15], minTriangles: 150 };

export interface FishRecipe {
  id: string;
  species: string;
  sourceId: string;
  axes: Axes;
  skinPose?: SkinPose;
  dropMeshes?: RegExp;
  keepMaterial: RegExp;
  /** Eyeballs that live in their own mesh: baked separately, re-seated on the head and kept out of fin classification. */
  eyes?: { meshes: RegExp; placement: EyePlacement };
  fallbackLengthM: number;
  /** Multiplies the species-JSON length, for sexes or morphs that differ from the species value. */
  lengthFactor?: number;
  hints?: FinHints | undefined;
  roughness?: number;
  modifications?: string[];
}

export interface FishContext {
  repoRoot: string;
  outRoot: string;
  licenceOf(sourceId: string): string;
  /** Throws unless the raw files of the source match the manifest hashes. */
  verifySource(sourceId: string): void;
}

const speciesFileSchema = speciesSchema.partial({
  behaviour: true,
  locomotion: true,
  render: true,
});

/** Standard length in metres from content/species/<species>.json, or null while the file has no locomotion block yet. */
export function speciesLengthM(repoRoot: string, species: string): number | null {
  const path = join(repoRoot, 'content', 'species', `${species}.json`);
  if (!existsSync(path)) return null;
  const parsed = speciesFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success)
    throw new Error(`${path} does not match the species schema: ${parsed.error.message}`);
  return parsed.data.locomotion?.bodyLengthM ?? null;
}

export interface NormaliseInput {
  parts: Part[];
  /** Rigid parts, such as eyes, that follow the body transform but never take part in fin classification. */
  attachments?: Part[];
  hints?: FinHints | undefined;
  standardLengthM: number;
  recipeId: string;
}

function slicePart(
  part: Part,
  vertexStart: number,
  vertexEnd: number,
  indexStart: number,
  indexEnd: number,
): Part {
  const indices = part.indices.slice(indexStart, indexEnd);
  for (let i = 0; i < indices.length; i++) indices[i] = indices[i]! - vertexStart;
  return {
    positions: part.positions.slice(vertexStart * 3, vertexEnd * 3),
    normals: part.normals.slice(vertexStart * 3, vertexEnd * 3),
    uvs: part.uvs.slice(vertexStart * 2, vertexEnd * 2),
    indices,
    material: part.material,
    extra: Object.fromEntries(
      Object.entries(part.extra).map(([k, v]) => [k, v.slice(vertexStart, vertexEnd)]),
    ),
  };
}

/** Centres on the body, classifies fins across all parts together, scales the standard length to metres and bakes the fin attributes. */
export function normaliseFish(input: NormaliseInput): Part[] {
  const welded = input.parts.map(weldPart);
  const attachments = (input.attachments ?? []).map(weldPart);
  const merged = mergeParts(welded, welded[0]!.material);
  const xShift = medianX(merged.positions);
  for (const part of [merged, ...welded, ...attachments]) {
    for (let i = 0; i < part.positions.length; i += 3)
      part.positions[i] = part.positions[i]! - xShift;
  }

  const fins = classifyFins(merged.positions, merged.indices, input.hints);
  if (input.hints?.caudalScale !== undefined)
    scaleCaudal(merged.positions, merged.normals, fins, input.hints.caudalScale, input.recipeId);
  const scale = input.standardLengthM / (fins.zSnout - fins.zPeduncle);
  for (const part of [merged, ...attachments])
    for (let i = 0; i < part.positions.length; i++) part.positions[i] = part.positions[i]! * scale;
  const centre = bodyCentreOfMass(merged.positions, merged.indices, fins.id);
  for (const part of [merged, ...attachments])
    for (let i = 0; i < part.positions.length; i += 3) {
      part.positions[i + 1] = part.positions[i + 1]! - centre[1];
      part.positions[i + 2] = part.positions[i + 2]! - centre[2];
    }
  merged.extra[FIN_MASK_ATTRIBUTE] = fins.mask;
  merged.extra[FIN_ID_ATTRIBUTE] = fins.id;

  const out: Part[] = [];
  let vertex = 0;
  let index = 0;
  for (const part of welded) {
    const vertices = part.positions.length / 3;
    const split = slicePart(merged, vertex, vertex + vertices, index, index + part.indices.length);
    split.material = part.material;
    out.push(split);
    vertex += vertices;
    index += part.indices.length;
  }
  for (const part of attachments) {
    const vertices = part.positions.length / 3;
    part.extra[FIN_MASK_ATTRIBUTE] = new Float32Array(vertices);
    part.extra[FIN_ID_ATTRIBUTE] = new Float32Array(vertices);
    out.push(part);
  }
  return out;
}

export async function writeDebugRender(
  repoRoot: string,
  id: string,
  parts: Part[],
): Promise<string> {
  const part = mergeParts(parts, parts[0]!.material);
  const rel = `debug/${id}.png`;
  const dir = join(repoRoot, 'tools', 'asset-pipeline', 'debug');
  mkdirSync(dir, { recursive: true });
  const png = await renderSheet(
    {
      positions: part.positions,
      indices: part.indices,
      colors: finDebugColors(part.extra[FIN_MASK_ATTRIBUTE]!, part.extra[FIN_ID_ATTRIBUTE]!),
    },
    [
      { view: 'side', pixelsAcross: 520 },
      { view: 'top', pixelsAcross: 520 },
      { view: 'front', pixelsAcross: 260 },
    ],
  );
  writeFileSync(join(dir, `${id}.png`), png);
  return rel;
}

export function fishInfo(
  standardLengthM: number,
  lengthSource: 'species-json' | 'recipe',
  debugRender: string,
): NonNullable<OutputAsset['fish']> {
  return {
    standardLengthM,
    lengthSource,
    axes: { forward: '+z', up: '+y' },
    origin: 'centre-of-mass',
    finMask: {
      maskAttribute: FIN_MASK_ATTRIBUTE,
      idAttribute: FIN_ID_ATTRIBUTE,
      ids: { ...FIN_IDS },
    },
    debugRender,
  };
}

async function bakeEyes(
  recipe: FishRecipe,
  eyeMeshes: RegExp,
  materials: Set<string>,
): Promise<Part[]> {
  const doc = await readGltf(recipe.sourceId, 'gltf/scene.gltf');
  bakeToWorldSpace(doc, (name) => !eyeMeshes.test(name), recipe.skinPose ?? 'bind');
  const parts = extractParts(doc).filter((p) => materials.has(p.material));
  if (parts.length === 0) throw new Error(`${recipe.id}: no mesh matches the eyes ${eyeMeshes}`);
  for (const part of parts) orient(part.positions, part.normals, recipe.axes);
  return parts;
}

export async function buildSourceFish(recipe: FishRecipe, ctx: FishContext): Promise<OutputAsset> {
  ctx.verifySource(recipe.sourceId);
  const doc = await readGltf(recipe.sourceId, 'gltf/scene.gltf');
  const dropMesh = recipe.dropMeshes;
  bakeToWorldSpace(
    doc,
    (name) => (dropMesh ? dropMesh.test(name) : false),
    recipe.skinPose ?? 'bind',
  );

  const sourceMaterials = doc
    .getRoot()
    .listMaterials()
    .filter((m) => recipe.keepMaterial.test(m.getName()));
  if (sourceMaterials.length === 0)
    throw new Error(`${recipe.id}: no material matches ${recipe.keepMaterial}`);
  const names = new Set(sourceMaterials.map((m) => m.getName()));
  const parts = extractParts(doc).filter((p) => names.has(p.material));
  if (parts.length === 0)
    throw new Error(`${recipe.id}: no geometry uses ${[...names].join(', ')}`);
  for (const part of parts) orient(part.positions, part.normals, recipe.axes);
  const eyeParts = recipe.eyes ? await bakeEyes(recipe, recipe.eyes.meshes, names) : [];
  if (recipe.eyes) {
    const eyes = mergeParts(eyeParts, eyeParts[0]!.material);
    seatEyes(eyes, parts, recipe.eyes.placement);
    eyeParts.splice(0, eyeParts.length, eyes);
  }

  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM =
    fromSpecies !== null ? fromSpecies * (recipe.lengthFactor ?? 1) : recipe.fallbackLengthM;
  const normalised = normaliseFish({
    parts,
    attachments: eyeParts,
    hints: recipe.hints,
    standardLengthM,
    recipeId: recipe.id,
  });

  const materials = await Promise.all(
    sourceMaterials.map((m) => materialDefFrom(m, { roughness: recipe.roughness ?? 0.45 })),
  );
  const debugRender = await writeDebugRender(ctx.repoRoot, recipe.id, normalised);
  const built = buildDocument(recipe.id, normalised, materials);
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'fish',
    id: recipe.id,
    built,
    plan: FISH_LOD_PLAN,
    meta: {
      species: recipe.species,
      origin: 'model',
      sources: [recipe.sourceId],
      licence: ctx.licenceOf(recipe.sourceId),
      modifications: [
        'merged meshes, dropped skeleton, animation and unused attributes',
        'oriented to +Z forward / +Y up, origin at body centre of mass, scaled to standard length',
        'baked fin mask and fin id vertex attributes',
        'colour and normal maps re-encoded to KTX2 at 1k and 2k',
        ...(recipe.modifications ?? []),
      ],
      fish: fishInfo(
        standardLengthM,
        fromSpecies !== null ? 'species-json' : 'recipe',
        debugRender,
      ),
    },
  });
}
