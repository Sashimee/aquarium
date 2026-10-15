import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesSchema } from '@aquarium/shared';
import { despikeHead, type DespikeSpec } from './bristles.ts';
import {
  flattenEyeBeads,
  GLOSSY_EYE_MATERIAL,
  glossyEyeParts,
  type GlossyEyeSpec,
} from './glossy-eyes.ts';
import { BRISTLE_DETAIL, growBristles, pickSkinUv, type BristleSpec } from './tentacles.ts';
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
import {
  FIN_ID_ATTRIBUTE,
  FIN_IDS,
  FIN_MASK_ATTRIBUTE,
  MOUTH_ATTRIBUTE,
  type OutputAsset,
} from './index-schema.ts';
import { bakeMouthMask, type MouthHints } from './mouth.ts';
import {
  extractParts,
  materialDefFrom,
  mergeParts,
  weldPart,
  type MaterialDef,
  type Part,
} from './parts.ts';
import { spotImage, tintImage, type SpotSpec, type TintSpec } from './finish.ts';
import { renderSheet } from './raster.ts';
import { bleedIslandEdges } from './island-bleed.ts';
import { worldSpotImage, type WorldSpotSpec } from './world-spots.ts';
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
  mouth?: MouthHints;
  /** Flattens rigid head spikes into the skin before anything else looks at the mesh. */
  despike?: DespikeSpec;
  /** Grows soft tentacles on the despiked snout, as rigid attachments outside fin classification. */
  bristles?: BristleSpec;
  /** Covers the eye beads fused into the body mesh with smooth, dark, glossy spheres on a material of their own. */
  glossyEyes?: GlossyEyeSpec;
  roughness?: number;
  /** Recolours the source's base colour by luminance, then paints spots on it. */
  recolour?: {
    tint: TintSpec;
    spots?: SpotSpec;
    worldSpots?: WorldSpotSpec;
    islandBleedPx?: number;
  };
  /** For sources far denser than the other fish, whose LOD0 must itself be a decimation. */
  lodPlan?: LodPlan;
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
export function speciesLengthM(
  repoRoot: string,
  species: string,
  directory = 'species',
): number | null {
  const path = join(repoRoot, 'content', directory, `${species}.json`);
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
  mouth?: MouthHints | undefined;
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
  merged.extra[MOUTH_ATTRIBUTE] = bakeMouthMask(merged.positions, fins.id, input.mouth);

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
    part.extra[MOUTH_ATTRIBUTE] = new Float32Array(vertices);
    out.push(part);
  }
  return out;
}

function skinUv(body: Part, materials: MaterialDef[], headFraction: number): [number, number] {
  const image = materials.find((m) => m.name === body.material)?.baseColor?.image;
  if (!image) throw new Error(`${body.material}: tentacles need a base colour texture to match`);
  return pickSkinUv(body, headFraction, (u, v) => {
    const x = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
    const y = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
    const at = (y * image.width + x) * 4;
    return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
  });
}

export async function writeDebugRender(
  repoRoot: string,
  id: string,
  parts: Part[],
  materials: MaterialDef[],
): Promise<string> {
  const part = mergeParts(parts, parts[0]!.material);
  const rel = `debug/${id}.png`;
  const dir = join(repoRoot, 'tools', 'asset-pipeline', 'debug');
  mkdirSync(dir, { recursive: true });
  const views = [
    { view: 'side', pixelsAcross: 520 },
    { view: 'top', pixelsAcross: 520 },
    { view: 'front', pixelsAcross: 260 },
  ] as const;
  const png = await renderSheet(
    {
      positions: part.positions,
      indices: part.indices,
      colors: finDebugColors(part.extra[FIN_MASK_ATTRIBUTE]!, part.extra[FIN_ID_ATTRIBUTE]!),
    },
    [...views],
  );
  writeFileSync(join(dir, `${id}.png`), png);

  const image = materials.find((m) => m.name === part.material)?.baseColor?.image;
  if (image) {
    const textured = await renderSheet(
      {
        positions: part.positions,
        indices: part.indices,
        normals: part.normals,
        uvs: part.uvs,
      },
      [...views],
      { data: image.data, width: image.width, height: image.height, channels: 4 },
    );
    writeFileSync(join(dir, `${id}-textured.png`), textured);
  }
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
    mouthMask: { attribute: MOUTH_ATTRIBUTE },
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
  if (recipe.despike) {
    const moved = parts.reduce((sum, part) => sum + despikeHead(part, recipe.despike!), 0);
    console.log(`${recipe.id}: despiked ${moved} head vertices`);
  }
  if (recipe.glossyEyes) flattenEyeBeads(parts, recipe.glossyEyes);
  const eyeParts = recipe.eyes ? await bakeEyes(recipe, recipe.eyes.meshes, names) : [];
  if (recipe.eyes) {
    const eyes = mergeParts(eyeParts, eyeParts[0]!.material);
    seatEyes(eyes, parts, recipe.eyes.placement);
    eyeParts.splice(0, eyeParts.length, eyes);
  }

  const materials = await Promise.all(
    sourceMaterials.map(async (m) => {
      const def = await materialDefFrom(m, { roughness: recipe.roughness ?? 0.45 });
      if (!recipe.recolour) return def;
      if (!def.baseColor) throw new Error(`${recipe.id}: recolour needs a base colour texture`);
      let image = tintImage(def.baseColor.image, recipe.recolour.tint);
      if (recipe.recolour.islandBleedPx)
        image = bleedIslandEdges(
          image,
          parts.filter((p) => p.material === m.getName()),
          recipe.recolour.islandBleedPx,
          `${recipe.id}/${m.getName()}`,
        );
      if (recipe.recolour.spots) image = spotImage(image, recipe.recolour.spots);
      if (recipe.recolour.worldSpots)
        image = worldSpotImage(
          image,
          parts.filter((p) => p.material === m.getName()),
          recipe.recolour.worldSpots,
        );
      return { ...def, baseColor: { ...def.baseColor, image } };
    }),
  );
  const body = mergeParts(parts, parts[0]!.material);
  const skin = recipe.bristles
    ? skinUv(body, materials, recipe.despike?.headFraction ?? 0.3)
    : null;
  const bristleParts = recipe.bristles
    ? BRISTLE_DETAIL.map((detail, level) => ({
        ...growBristles(body, recipe.bristles!, skin!, detail),
        lods: [level],
      }))
    : [];
  const glossyParts = recipe.glossyEyes ? glossyEyeParts(body, recipe.glossyEyes) : [];
  const materialDefs = recipe.glossyEyes ? [...materials, GLOSSY_EYE_MATERIAL] : materials;

  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM =
    fromSpecies !== null ? fromSpecies * (recipe.lengthFactor ?? 1) : recipe.fallbackLengthM;
  const normalised = normaliseFish({
    parts,
    attachments: [...eyeParts, ...bristleParts, ...glossyParts],
    hints: recipe.hints,
    mouth: recipe.mouth,
    standardLengthM,
    recipeId: recipe.id,
  });

  const debugRender = await writeDebugRender(
    ctx.repoRoot,
    recipe.id,
    normalised.filter((p) => !p.lods || p.lods.includes(0)),
    materials,
  );
  const built = buildDocument(recipe.id, normalised, materialDefs);
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'fish',
    id: recipe.id,
    built,
    plan: recipe.lodPlan ?? FISH_LOD_PLAN,
    meta: {
      species: recipe.species,
      origin: 'model',
      sources: [recipe.sourceId],
      licence: ctx.licenceOf(recipe.sourceId),
      modifications: [
        'merged meshes, dropped skeleton, animation and unused attributes',
        'oriented to +Z forward / +Y up, origin at body centre of mass, scaled to standard length',
        'baked fin mask, fin id and mouth mask vertex attributes',
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
