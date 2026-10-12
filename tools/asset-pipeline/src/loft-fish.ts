import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocument, emitAsset } from './emit.ts';
import {
  FISH_LOD_PLAN,
  fishInfo,
  speciesLengthM,
  writeDebugRender,
  type FishContext,
} from './fish.ts';
import { loftFish, sideProjection, type LoftSpec, type Projection } from './loft.ts';
import type { MaterialDef, Part } from './parts.ts';
import { RAW_ROOT } from './source.ts';
import { cropImage, decodeImage, type Rgba } from './textures.ts';
import type { OutputAsset } from './index-schema.ts';

interface PhotoSource {
  kind: 'photo';
  sourceId: string;
  file: string;
  crop: { left: number; top: number; width: number; height: number };
  snoutPixel: [number, number];
  tailPixel: [number, number];
}

interface SyntheticSource {
  kind: 'synthetic';
  width: number;
  height: number;
  /** Pixel of the snout and of the end of the peduncle; the standard length spans the distance between them. */
  snoutPixel: [number, number];
  tailPixel: [number, number];
  paint(tn: number, yn: number): [number, number, number];
}

export interface LoftFishRecipe {
  id: string;
  species: string;
  fallbackLengthM: number;
  spec: Omit<LoftSpec, 'standardLengthM'>;
  texture: PhotoSource | SyntheticSource;
  roughness: number;
  note: string;
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export async function loadTexture(
  recipe: LoftFishRecipe,
): Promise<{ image: Rgba; project: Projection; sources: string[] }> {
  const length = 1;
  const { spec } = recipe;
  const first = spec.sections[0]!;
  const last = spec.sections[spec.sections.length - 1]!;
  const snoutY = ((first.top + first.bottom) / 2) * length;
  const tailY = ((last.top + last.bottom) / 2) * length;
  const source = recipe.texture;

  if (source.kind === 'photo') {
    const full = await decodeImage(readFileSync(join(RAW_ROOT, source.sourceId, source.file)));
    const image = await cropImage(full, source.crop);
    const project = sideProjection({
      standardLengthM: length,
      snoutY,
      tailY,
      snoutPixel: source.snoutPixel,
      tailPixel: source.tailPixel,
      crop: source.crop,
    });
    return { image, project, sources: [source.sourceId] };
  }

  const pixelsPerLength = Math.hypot(
    source.tailPixel[0] - source.snoutPixel[0],
    source.tailPixel[1] - source.snoutPixel[1],
  );
  const data = new Uint8Array(source.width * source.height * 4);
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const tn = (x - source.snoutPixel[0]) / pixelsPerLength;
      const yn = snoutY + (source.snoutPixel[1] - y) / pixelsPerLength;
      const [r, g, b] = source.paint(tn, yn);
      const o = (y * source.width + x) * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
      data[o + 3] = 255;
    }
  const crop = { left: 0, top: 0, width: source.width, height: source.height };
  const project = sideProjection({
    standardLengthM: length,
    snoutY,
    tailY,
    snoutPixel: source.snoutPixel,
    tailPixel: source.tailPixel,
    crop,
  });
  return { image: { width: source.width, height: source.height, data }, project, sources: [] };
}

/** Royal gramma colours painted from the species' known pattern; no photo pixels are reused. */
function paintGramma(tn: number, yn: number): [number, number, number] {
  const violet: [number, number, number] = [0.27, 0.1, 0.78];
  const deepViolet: [number, number, number] = [0.16, 0.06, 0.5];
  const yellow: [number, number, number] = [1, 0.74, 0.05];
  const orange: [number, number, number] = [1, 0.5, 0.05];
  const boundary = 0.5 + 0.18 * (yn - 0.15);
  let colour = mix(violet, yellow, smooth(boundary - 0.07, boundary + 0.07, tn));
  colour = mix(
    colour,
    deepViolet,
    smooth(0.28, 0.4, yn) * (1 - smooth(boundary - 0.05, boundary + 0.02, tn)),
  );
  colour = mix(
    colour,
    orange,
    0.35 *
      smooth(boundary - 0.12, boundary - 0.02, tn) *
      (1 - smooth(boundary - 0.02, boundary + 0.05, tn)),
  );
  const eye = Math.hypot(tn - 0.075, yn - 0.2);
  if (eye < 0.045) colour = mix([0.02, 0.02, 0.05], [0.7, 0.8, 1], smooth(0.025, 0.045, eye));
  const gill = Math.abs(tn - 0.2 - 0.25 * (0.2 - yn)) < 0.006 && yn < 0.3 && yn > 0.02;
  if (gill) colour = mix(colour, deepViolet, 0.6);
  return colour;
}

export const LOFT_FISH_RECIPES: LoftFishRecipe[] = [
  {
    id: 'bronze-corydoras',
    species: 'bronze-corydoras',
    fallbackLengthM: 0.065,
    roughness: 0.5,
    note: 'Female Bronze Corydoras by Andrew Keller (CC0), side view projected onto the loft',
    texture: {
      kind: 'photo',
      sourceId: 'wm-cory-aeneus-ack210',
      file: 'Female_Bronze_Corydoras__Corydoras_aeneus_.jpg',
      crop: { left: 185, top: 247, width: 826, height: 345 },
      snoutPixel: [915, 485],
      tailPixel: [419, 438],
    },
    spec: {
      roundness: 2.5,
      sections: [
        { t: 0, top: 0.1, bottom: 0.04, halfWidth: 0.02 },
        { t: 0.05, top: 0.13, bottom: 0.03, halfWidth: 0.07 },
        { t: 0.15, top: 0.18, bottom: 0.01, halfWidth: 0.11 },
        { t: 0.3, top: 0.23, bottom: 0.01, halfWidth: 0.125 },
        { t: 0.5, top: 0.23, bottom: 0.02, halfWidth: 0.1 },
        { t: 0.7, top: 0.19, bottom: 0.04, halfWidth: 0.065 },
        { t: 0.85, top: 0.17, bottom: 0.06, halfWidth: 0.05 },
        { t: 1, top: 0.15, bottom: 0.07, halfWidth: 0.04 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.36,
          to: 0.56,
          anchor: 'top',
          shape: [0.1, 0.15, 0.13, 0.08, 0.04],
          sweep: 0.5,
        },
        {
          fin: 'anal',
          from: 0.78,
          to: 0.92,
          anchor: 'bottom',
          shape: [0.1, 0.12, 0.09],
          sweep: 0.5,
        },
        {
          fin: 'pelvic',
          from: 0.47,
          to: 0.62,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.4, -0.9],
          shape: [0.1, 0.15, 0.12],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.22,
          to: 0.3,
          anchor: 'side',
          flankHeight: 0.3,
          direction: [0.9, -0.4],
          shape: [0.12, 0.17, 0.13],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.2, 0.25, 0.16, 0.25, 0.2], spread: 0.08 },
    },
  },
  {
    id: 'royal-gramma',
    species: 'royal-gramma',
    fallbackLengthM: 0.06,
    roughness: 0.35,
    note: 'colour map painted procedurally; the only side-view photograph is CC-BY-SA and is not reused',
    texture: {
      kind: 'synthetic',
      width: 1280,
      height: 768,
      snoutPixel: [60, 440],
      tailPixel: [960, 440],
      paint: paintGramma,
    },
    spec: {
      roundness: 2.2,
      sections: [
        { t: 0, top: 0.14, bottom: 0.1, halfWidth: 0.02 },
        { t: 0.05, top: 0.22, bottom: 0.06, halfWidth: 0.05 },
        { t: 0.2, top: 0.34, bottom: 0.01, halfWidth: 0.1 },
        { t: 0.4, top: 0.36, bottom: 0, halfWidth: 0.105 },
        { t: 0.6, top: 0.32, bottom: 0.04, halfWidth: 0.09 },
        { t: 0.8, top: 0.26, bottom: 0.06, halfWidth: 0.07 },
        { t: 1, top: 0.19, bottom: 0.07, halfWidth: 0.05 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.16,
          to: 0.8,
          anchor: 'top',
          shape: [0.12, 0.15, 0.15, 0.15, 0.17, 0.19, 0.22, 0.12],
          sweep: 0.35,
        },
        {
          fin: 'anal',
          from: 0.58,
          to: 0.8,
          anchor: 'bottom',
          shape: [0.1, 0.13, 0.14, 0.15, 0.1],
          sweep: 0.5,
        },
        {
          fin: 'pelvic',
          from: 0.28,
          to: 0.36,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.35, -0.9],
          shape: [0.12, 0.2, 0.16],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.25,
          to: 0.32,
          anchor: 'side',
          flankHeight: 0.45,
          direction: [0.8, -0.2],
          shape: [0.1, 0.14, 0.1],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.14, 0.2, 0.22, 0.2, 0.14], spread: 0.04 },
    },
  },
  {
    id: 'banggai-cardinalfish',
    species: 'banggai-cardinalfish',
    fallbackLengthM: 0.07,
    roughness: 0.4,
    note: 'Pterapogon kauderni by Holger Krisp (CC-BY-3.0), side view projected onto the loft',
    texture: {
      kind: 'photo',
      sourceId: 'wm-banggai-holleday',
      file: 'Banggai-Kardinalbarsch_Pterapogon_kauderni.jpg',
      crop: { left: 833, top: 167, width: 1800, height: 1600 },
      snoutPixel: [943, 1293],
      tailPixel: [1983, 1107],
    },
    spec: {
      roundness: 2.2,
      sections: [
        { t: 0, top: 0.22, bottom: 0.14, halfWidth: 0.02 },
        { t: 0.06, top: 0.32, bottom: 0.08, halfWidth: 0.06 },
        { t: 0.2, top: 0.46, bottom: 0, halfWidth: 0.12 },
        { t: 0.4, top: 0.46, bottom: 0, halfWidth: 0.13 },
        { t: 0.6, top: 0.4, bottom: 0.03, halfWidth: 0.1 },
        { t: 0.8, top: 0.31, bottom: 0.08, halfWidth: 0.07 },
        { t: 1, top: 0.23, bottom: 0.1, halfWidth: 0.05 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.3,
          to: 0.48,
          anchor: 'top',
          shape: [0.12, 0.34, 0.3, 0.2, 0.1],
          sweep: 0.7,
        },
        {
          fin: 'dorsal',
          from: 0.52,
          to: 0.7,
          anchor: 'top',
          shape: [0.26, 0.32, 0.28, 0.22, 0.12],
          sweep: 0.8,
        },
        {
          fin: 'anal',
          from: 0.56,
          to: 0.74,
          anchor: 'bottom',
          shape: [0.2, 0.23, 0.2, 0.14, 0.08],
          sweep: 0.7,
        },
        {
          fin: 'pelvic',
          from: 0.3,
          to: 0.4,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.3, -0.95],
          shape: [0.16, 0.25, 0.2],
          sweep: 0.35,
        },
        {
          fin: 'pectoral',
          from: 0.27,
          to: 0.34,
          anchor: 'side',
          flankHeight: 0.4,
          direction: [0.9, -0.3],
          shape: [0.1, 0.16, 0.1],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.34, 0.28, 0.14, 0.28, 0.34], spread: 0.1 },
    },
  },
];

export function loftFishPart(
  recipe: LoftFishRecipe,
  standardLengthM: number,
  project: Projection,
): Part {
  const scaled: Projection = (behind, y) => project(behind / standardLengthM, y / standardLengthM);
  return loftFish({ ...recipe.spec, standardLengthM }, scaled, recipe.id);
}

export async function buildLoftFish(
  recipe: LoftFishRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM = fromSpecies ?? recipe.fallbackLengthM;
  const { image, project, sources } = await loadTexture(recipe);
  const part = loftFishPart(recipe, standardLengthM, project);

  const material: MaterialDef = {
    name: recipe.id,
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image },
    roughness: recipe.roughness,
    metallic: 0,
    alphaMode: 'OPAQUE',
    doubleSided: true,
    normalScale: 1,
  };
  const debugRender = await writeDebugRender(ctx.repoRoot, recipe.id, [part]);
  const built = buildDocument(recipe.id, [part], [material]);
  const licence = sources.length > 0 ? ctx.licenceOf(sources[0]!) : 'CC0-1.0';
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'fish',
    id: recipe.id,
    built,
    plan: FISH_LOD_PLAN,
    meta: {
      species: recipe.species,
      origin: 'procedural-loft',
      sources,
      licence,
      modifications: [
        'procedural loft: elliptical cross-sections along the spine from species proportions, fins as ruled membranes',
        'fin mask and fin id vertex attributes generated analytically',
        'oriented to +Z forward / +Y up, origin at body centre of mass, scaled to standard length',
        recipe.note,
        'colour map re-encoded to KTX2 at 1k and 2k',
      ],
      fish: fishInfo(
        standardLengthM,
        fromSpecies !== null ? 'species-json' : 'recipe',
        debugRender,
      ),
    },
  });
}
