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
import { appendFinAtlas, type FinPaint, type FinPalette } from './fin-paint.ts';
import {
  loftFish,
  sectionEdges,
  sideProjection,
  type FinTexture,
  type LoftSpec,
  type Projection,
  type SectionKey,
} from './loft.ts';
import { retouchPhoto, type Retouch } from './retouch.ts';
import type { MaterialDef, Part } from './parts.ts';
import { strictestLicence } from './manifest.ts';
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
  /** Crop-space rectangle of body colour inside the fish; its mean colours every fin membrane. */
  finSwatch?: { left: number; top: number; width: number; height: number };
  /** Painted, translucent, ray-textured fins instead of the flat swatch; needs `spec.membrane`. */
  finPalette?: FinPalette;
  retouch?: Retouch[];
  /**
   * Section keys traced from the photo when the loft's own proportions differ from the pictured
   * individual; the photo is stretched section by section onto the loft.
   */
  photoSections?: SectionKey[];
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

const SWATCH_ROWS = 32;

/** Adds a flat strip of the swatch's mean colour under the photo; body coordinates stay above it via `bodyVMax`. */
export function appendSwatch(
  photo: Rgba,
  swatch: NonNullable<PhotoSource['finSwatch']>,
): { image: Rgba; finUv: [number, number]; bodyVMax: number } {
  if (
    swatch.left < 0 ||
    swatch.top < 0 ||
    swatch.left + swatch.width > photo.width ||
    swatch.top + swatch.height > photo.height ||
    swatch.width < 1 ||
    swatch.height < 1
  )
    throw new Error(
      `fin swatch ${JSON.stringify(swatch)} lies outside the ${photo.width}x${photo.height} crop`,
    );
  const sum = [0, 0, 0];
  for (let y = swatch.top; y < swatch.top + swatch.height; y++)
    for (let x = swatch.left; x < swatch.left + swatch.width; x++)
      sum.forEach((total, c) => {
        sum[c] = total + (photo.data[(y * photo.width + x) * 4 + c] ?? 0);
      });
  const area = swatch.width * swatch.height;
  const mean = sum.map((total) => Math.round(total / area));
  const height = photo.height + SWATCH_ROWS;
  const data = new Uint8Array(photo.width * height * 4);
  data.set(photo.data);
  for (let y = photo.height; y < height; y++)
    for (let x = 0; x < photo.width; x++) {
      const o = (y * photo.width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = mean[c] ?? 0;
      data[o + 3] = 255;
    }
  return {
    image: { width: photo.width, height, data },
    finUv: [0.5, (photo.height + SWATCH_ROWS / 2) / height],
    bodyVMax: (photo.height - 1) / height,
  };
}

const ROOT_SAMPLE_RADIUS = 14;

/** Mean colour of the photo around the end of the peduncle, in crop space. */
export function peduncleColour(photo: Rgba, tail: [number, number]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (
    let y = Math.round(tail[1]) - ROOT_SAMPLE_RADIUS;
    y <= Math.round(tail[1]) + ROOT_SAMPLE_RADIUS;
    y++
  )
    for (
      let x = Math.round(tail[0]) - ROOT_SAMPLE_RADIUS;
      x <= Math.round(tail[0]) + ROOT_SAMPLE_RADIUS;
      x++
    ) {
      if (x < 0 || y < 0 || x >= photo.width || y >= photo.height) continue;
      const o = (y * photo.width + x) * 4;
      r += photo.data[o] ?? 0;
      g += photo.data[o + 1] ?? 0;
      b += photo.data[o + 2] ?? 0;
      count++;
    }
  if (count === 0) throw new Error(`peduncle pixel ${tail.join(',')} lies outside the photo`);
  return [r / count, g / count, b / count];
}

function withPhotoRoots(photo: Rgba, source: PhotoSource): FinPalette {
  const palette = source.finPalette;
  if (!palette) throw new Error('recipe has no fin palette');
  const tail: [number, number] = [
    source.tailPixel[0] - source.crop.left,
    source.tailPixel[1] - source.crop.top,
  ];
  const colour = peduncleColour(photo, tail);
  const rooted = (paint: FinPaint): FinPaint =>
    paint.rootFromPhoto ? { ...paint, root: colour } : paint;
  return {
    caudal: rooted(palette.caudal),
    dorsal: rooted(palette.dorsal),
    anal: rooted(palette.anal),
    pectoral: rooted(palette.pectoral),
    pelvic: rooted(palette.pelvic),
    ...(palette.spine ? { spine: rooted(palette.spine) } : {}),
  };
}

export function fitPhotoToLoft(
  project: Projection,
  loft: SectionKey[],
  photo: SectionKey[],
): Projection {
  return (behind, y) => {
    const t = Math.min(1, Math.max(0, behind));
    const target = sectionEdges(loft, t);
    const traced = sectionEdges(photo, t);
    const h = (y - target.bottom) / Math.max(1e-6, target.top - target.bottom);
    return project(behind, traced.bottom + h * (traced.top - traced.bottom));
  };
}

export async function loadTexture(recipe: LoftFishRecipe): Promise<{
  image: Rgba;
  project: Projection;
  finUv?: [number, number];
  finTexture?: FinTexture;
  sources: string[];
}> {
  const length = 1;
  const { spec } = recipe;
  const photoKeys = recipe.texture.kind === 'photo' ? recipe.texture.photoSections : undefined;
  const first = (photoKeys ?? spec.sections).at(0);
  const last = (photoKeys ?? spec.sections).at(-1);
  if (!first || !last) throw new Error(`${recipe.id}: loft needs at least one section`);
  const snoutY = ((first.top + first.bottom) / 2) * length;
  const tailY = ((last.top + last.bottom) / 2) * length;
  const source = recipe.texture;

  if (source.kind === 'photo') {
    const full = await decodeImage(readFileSync(join(RAW_ROOT, source.sourceId, source.file)));
    const cropped = await cropImage(full, source.crop);
    if (source.retouch) retouchPhoto(cropped, source.crop, source.retouch);
    let strip: { image: Rgba; finUv?: [number, number]; finTexture?: FinTexture; bodyVMax: number };
    if (source.finPalette) {
      if (!spec.membrane) throw new Error(`${recipe.id}: a fin palette needs spec.membrane`);
      strip = appendFinAtlas(cropped, withPhotoRoots(cropped, source));
    } else {
      if (!source.finSwatch) throw new Error(`${recipe.id}: needs a finSwatch or a finPalette`);
      strip = appendSwatch(cropped, source.finSwatch);
    }
    const { image, finUv, finTexture, bodyVMax } = strip;
    const projectPhoto = sideProjection({
      standardLengthM: length,
      snoutY,
      tailY,
      snoutPixel: source.snoutPixel,
      tailPixel: source.tailPixel,
      crop: source.crop,
    });
    const projectBody = photoKeys
      ? fitPhotoToLoft(projectPhoto, spec.sections, photoKeys)
      : projectPhoto;
    const project: Projection = (behind, y) => {
      const [u, v] = projectBody(behind, y);
      return [u, Math.min(1, Math.max(0, v)) * bodyVMax];
    };
    return {
      image,
      project,
      sources: [source.sourceId],
      ...(finUv ? { finUv } : {}),
      ...(finTexture ? { finTexture } : {}),
    };
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
      finSwatch: { left: 300, top: 238, width: 160, height: 22 },
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
      tailPixel: [1983, 1142],
      finSwatch: { left: 380, top: 860, width: 180, height: 400 },
    },
    spec: {
      roundness: 2.2,
      sections: [
        { t: 0, top: 0.195, bottom: 0.165, halfWidth: 0.02 },
        { t: 0.06, top: 0.284, bottom: 0.08, halfWidth: 0.06 },
        { t: 0.2, top: 0.358, bottom: -0.028, halfWidth: 0.12 },
        { t: 0.4, top: 0.408, bottom: -0.072, halfWidth: 0.13 },
        { t: 0.6, top: 0.398, bottom: -0.053, halfWidth: 0.1 },
        { t: 0.8, top: 0.27, bottom: 0.07, halfWidth: 0.07 },
        { t: 1, top: 0.248, bottom: 0.086, halfWidth: 0.05 },
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
  {
    id: 'harlequin-rasbora',
    species: 'harlequin-rasbora',
    fallbackLengthM: 0.04,
    roughness: 0.4,
    note: 'Trigonostigma heteromorpha by Mariusz Dabrowski (CC-BY-SA-3.0), side view projected onto the loft with the photographed body fitted to the species proportions; fins painted as translucent reddish membranes',
    texture: {
      kind: 'photo',
      sourceId: 'wm-rasbora-dabrowski',
      file: 'Harlequin_Rasbora_(cropped).jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original',
      crop: { left: 380, top: 270, width: 1420, height: 580 },
      snoutPixel: [1737, 405],
      tailPixel: [458, 595],
      photoSections: [
        { t: 0, top: 0, bottom: 0, halfWidth: 0.02 },
        { t: 0.03, top: 0.023, bottom: -0.027, halfWidth: 0.04 },
        { t: 0.08, top: 0.054, bottom: -0.063, halfWidth: 0.055 },
        { t: 0.15, top: 0.083, bottom: -0.103, halfWidth: 0.065 },
        { t: 0.25, top: 0.11, bottom: -0.14, halfWidth: 0.074 },
        { t: 0.35, top: 0.127, bottom: -0.161, halfWidth: 0.077 },
        { t: 0.45, top: 0.138, bottom: -0.178, halfWidth: 0.075 },
        { t: 0.55, top: 0.141, bottom: -0.168, halfWidth: 0.068 },
        { t: 0.65, top: 0.104, bottom: -0.145, halfWidth: 0.06 },
        { t: 0.75, top: 0.045, bottom: -0.109, halfWidth: 0.05 },
        { t: 0.85, top: 0.032, bottom: -0.078, halfWidth: 0.04 },
        { t: 1, top: 0.03, bottom: -0.03, halfWidth: 0.03 },
      ],
      finPalette: {
        caudal: {
          rootFromPhoto: true,
          root: [150, 60, 40],
          tip: [208, 78, 58],
          rim: [186, 34, 42],
          rimStart: 0.7,
          rays: 16,
          rayDepth: 0.35,
          opacity: { root: 1, tip: 0.5 },
          seed: 1,
        },
        dorsal: {
          root: [150, 60, 40],
          tip: [216, 96, 66],
          rim: [150, 30, 36],
          rimStart: 0.72,
          rays: 10,
          rayDepth: 0.3,
          opacity: { root: 0.9, tip: 0.45 },
          seed: 2,
        },
        anal: {
          root: [170, 80, 55],
          tip: [226, 122, 88],
          rim: [190, 50, 46],
          rimStart: 0.75,
          rays: 8,
          rayDepth: 0.3,
          opacity: { root: 0.8, tip: 0.4 },
          seed: 3,
        },
        pectoral: {
          root: [200, 130, 100],
          tip: [232, 188, 168],
          rays: 7,
          rayDepth: 0.2,
          opacity: { root: 0.5, tip: 0.2 },
          seed: 4,
        },
        pelvic: {
          root: [205, 110, 85],
          tip: [235, 165, 140],
          rays: 5,
          rayDepth: 0.25,
          opacity: { root: 0.6, tip: 0.3 },
          seed: 5,
        },
      },
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: [
        { t: 0, top: 0, bottom: 0, halfWidth: 0.02 },
        { t: 0.04, top: 0.02, bottom: -0.06, halfWidth: 0.044 },
        { t: 0.1, top: 0.04, bottom: -0.125, halfWidth: 0.057 },
        { t: 0.2, top: 0.092, bottom: -0.185, halfWidth: 0.072 },
        { t: 0.3, top: 0.15, bottom: -0.215, halfWidth: 0.075 },
        { t: 0.4, top: 0.172, bottom: -0.228, halfWidth: 0.078 },
        { t: 0.5, top: 0.175, bottom: -0.218, halfWidth: 0.072 },
        { t: 0.6, top: 0.152, bottom: -0.172, halfWidth: 0.065 },
        { t: 0.7, top: 0.118, bottom: -0.12, halfWidth: 0.054 },
        { t: 0.8, top: 0.088, bottom: -0.082, halfWidth: 0.042 },
        { t: 0.9, top: 0.062, bottom: -0.07, halfWidth: 0.036 },
        { t: 0.97, top: 0.047, bottom: -0.072, halfWidth: 0.03 },
        { t: 1, top: 0.03, bottom: -0.048, halfWidth: 0.014 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.47,
          to: 0.78,
          anchor: 'top',
          shape: [0.05, 0.1, 0.13, 0.13, 0.1, 0.06, 0.03],
          sweep: 0.85,
        },
        {
          fin: 'anal',
          from: 0.64,
          to: 0.87,
          anchor: 'bottom',
          shape: [0.06, 0.12, 0.13, 0.1, 0.05],
          sweep: 0.6,
        },
        {
          fin: 'pelvic',
          from: 0.52,
          to: 0.61,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.3, -0.95],
          shape: [0.04, 0.12, 0.14, 0.08],
          sweep: 0.5,
        },
        {
          fin: 'pectoral',
          from: 0.2,
          to: 0.27,
          anchor: 'side',
          flankHeight: 0.35,
          direction: [0.9, -0.3],
          shape: [0.03, 0.1, 0.13, 0.08],
          sweep: 0.6,
        },
      ],
      caudal: {
        shape: [0.1, 0.24, 0.32, 0.3, 0.2, 0.15, 0.2, 0.3, 0.32, 0.24, 0.1],
        spread: 0.14,
      },
    },
  },
  {
    id: 'six-line-wrasse',
    species: 'six-line-wrasse',
    fallbackLengthM: 0.07,
    roughness: 0.35,
    note: 'Pseudocheilinus hexataenia by Diego Delso (CC-BY-SA-4.0), tilted side view rectified and projected onto the loft with the photographed body fitted to the species proportions; fins painted as translucent membranes',
    texture: {
      kind: 'photo',
      sourceId: 'wm-sixline-delso-63',
      file: 'Lábrido_de_seis_rayas_(Pseudocheilinus_hexataenia),_Zanzíbar,_Tanzania,_2024-05-29,_DD_63.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original',
      crop: { left: 1150, top: 650, width: 1950, height: 1400 },
      snoutPixel: [1235, 775],
      tailPixel: [2960, 1846],
      photoSections: [
        { t: 0, top: 0, bottom: 0, halfWidth: 0.02 },
        { t: 0.03, top: 0.018, bottom: -0.02, halfWidth: 0.04 },
        { t: 0.08, top: 0.042, bottom: -0.03, halfWidth: 0.057 },
        { t: 0.15, top: 0.066, bottom: -0.044, halfWidth: 0.07 },
        { t: 0.25, top: 0.084, bottom: -0.07, halfWidth: 0.08 },
        { t: 0.35, top: 0.106, bottom: -0.094, halfWidth: 0.085 },
        { t: 0.45, top: 0.108, bottom: -0.122, halfWidth: 0.087 },
        { t: 0.55, top: 0.11, bottom: -0.132, halfWidth: 0.085 },
        { t: 0.65, top: 0.106, bottom: -0.124, halfWidth: 0.075 },
        { t: 0.75, top: 0.09, bottom: -0.114, halfWidth: 0.065 },
        { t: 0.85, top: 0.074, bottom: -0.096, halfWidth: 0.053 },
        { t: 1, top: 0.03, bottom: -0.03, halfWidth: 0.035 },
      ],
      finPalette: {
        caudal: {
          root: [62, 132, 52],
          rootFromPhoto: true,
          tip: [96, 170, 72],
          rim: [118, 184, 88],
          rimStart: 0.8,
          rays: 18,
          rayDepth: 0.4,
          opacity: { root: 1, tip: 0.55 },
          seed: 11,
        },
        dorsal: {
          root: [214, 98, 52],
          tip: [196, 110, 80],
          rim: [60, 130, 210],
          rimStart: 0.78,
          rays: 22,
          rayDepth: 0.35,
          opacity: { root: 0.9, tip: 0.5 },
          seed: 12,
        },
        anal: {
          root: [200, 96, 62],
          tip: [190, 112, 100],
          rim: [70, 140, 220],
          rimStart: 0.78,
          rays: 12,
          rayDepth: 0.35,
          opacity: { root: 0.85, tip: 0.45 },
          seed: 13,
        },
        pectoral: {
          root: [150, 172, 192],
          tip: [200, 212, 222],
          rays: 10,
          rayDepth: 0.2,
          opacity: { root: 0.45, tip: 0.15 },
          seed: 14,
        },
        pelvic: {
          root: [40, 140, 230],
          tip: [150, 205, 255],
          rays: 5,
          rayDepth: 0.25,
          opacity: { root: 0.9, tip: 0.6 },
          seed: 15,
        },
      },
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: [
        { t: 0, top: 0, bottom: 0, halfWidth: 0.02 },
        { t: 0.04, top: 0.03, bottom: -0.03, halfWidth: 0.033 },
        { t: 0.1, top: 0.07, bottom: -0.07, halfWidth: 0.05 },
        { t: 0.2, top: 0.125, bottom: -0.115, halfWidth: 0.062 },
        { t: 0.3, top: 0.155, bottom: -0.14, halfWidth: 0.07 },
        { t: 0.4, top: 0.168, bottom: -0.15, halfWidth: 0.072 },
        { t: 0.5, top: 0.166, bottom: -0.148, halfWidth: 0.07 },
        { t: 0.6, top: 0.157, bottom: -0.14, halfWidth: 0.065 },
        { t: 0.7, top: 0.13, bottom: -0.112, halfWidth: 0.056 },
        { t: 0.8, top: 0.1, bottom: -0.085, halfWidth: 0.046 },
        { t: 0.9, top: 0.078, bottom: -0.066, halfWidth: 0.036 },
        { t: 0.96, top: 0.066, bottom: -0.056, halfWidth: 0.03 },
        { t: 1, top: 0.03, bottom: -0.026, halfWidth: 0.014 },
      ],
      fins: [
        {
          fin: 'dorsal',
          from: 0.22,
          to: 0.95,
          anchor: 'top',
          shape: [0.03, 0.045, 0.055, 0.062, 0.065, 0.065, 0.065, 0.062, 0.058, 0.05, 0.035],
          sweep: 0.25,
        },
        {
          fin: 'anal',
          from: 0.62,
          to: 0.92,
          anchor: 'bottom',
          shape: [0.04, 0.08, 0.1, 0.1, 0.085, 0.05],
          sweep: 0.45,
        },
        {
          fin: 'pelvic',
          from: 0.36,
          to: 0.45,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.3, -0.95],
          shape: [0.03, 0.09, 0.115, 0.07],
          sweep: 0.6,
        },
        {
          fin: 'pectoral',
          from: 0.3,
          to: 0.37,
          anchor: 'side',
          flankHeight: 0.45,
          direction: [0.9, -0.2],
          shape: [0.04, 0.12, 0.15, 0.1],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.1, 0.17, 0.21, 0.23, 0.235, 0.23, 0.21, 0.17, 0.1], spread: 0.04 },
    },
  },
  {
    id: 'firefish',
    species: 'firefish',
    fallbackLengthM: 0.07,
    roughness: 0.35,
    note: 'Nemateleotris magnifica by Nick Hobgood (CC-BY-SA-3.0), oblique photograph projected onto the loft with the photographed body fitted to the species proportions; the first dorsal spine is modelled from the species description',
    texture: {
      kind: 'photo',
      sourceId: 'wm-firefish-hobgood',
      file: 'Nemateleotris_magnifica_Fire_Dartfish_by_Nick_Hobgood.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original',
      crop: { left: 920, top: 800, width: 1020, height: 420 },
      snoutPixel: [1908, 950],
      tailPixel: [1125, 1062],
      retouch: [
        { kind: 'wash', centre: [1330, 1070], radius: 230, colour: [232, 92, 28], strength: 0.4 },
      ],
      photoSections: [
        { t: 0, top: 0, bottom: 0, halfWidth: 0.015 },
        { t: 0.03, top: 0.066, bottom: -0.038, halfWidth: 0.03 },
        { t: 0.08, top: 0.11, bottom: -0.047, halfWidth: 0.045 },
        { t: 0.15, top: 0.153, bottom: -0.042, halfWidth: 0.057 },
        { t: 0.25, top: 0.19, bottom: -0.046, halfWidth: 0.066 },
        { t: 0.35, top: 0.2, bottom: -0.042, halfWidth: 0.069 },
        { t: 0.45, top: 0.2, bottom: -0.03, halfWidth: 0.068 },
        { t: 0.55, top: 0.222, bottom: -0.066, halfWidth: 0.064 },
        { t: 0.65, top: 0.222, bottom: -0.08, halfWidth: 0.058 },
        { t: 0.75, top: 0.205, bottom: -0.082, halfWidth: 0.049 },
        { t: 0.85, top: 0.165, bottom: -0.075, halfWidth: 0.041 },
        { t: 1, top: 0.08, bottom: -0.08, halfWidth: 0.03 },
      ],
      finPalette: {
        caudal: {
          rootFromPhoto: true,
          root: [226, 82, 36],
          tip: [196, 40, 28],
          rim: [96, 14, 16],
          rimStart: 0.66,
          rays: 14,
          rayDepth: 0.5,
          opacity: { root: 1, tip: 0.8 },
          seed: 21,
        },
        dorsal: {
          root: [246, 192, 72],
          tip: [216, 70, 38],
          rim: [180, 24, 26],
          rimStart: 0.7,
          rays: 14,
          rayDepth: 0.35,
          opacity: { root: 0.85, tip: 0.5 },
          seed: 22,
        },
        spine: {
          root: [248, 242, 226],
          tip: [238, 170, 120],
          rim: [196, 56, 40],
          rimStart: 0.8,
          rays: 3,
          rayDepth: 0.3,
          leadingRay: 0.25,
          opacity: { root: 0.85, tip: 0.6 },
          seed: 23,
        },
        anal: {
          root: [250, 216, 92],
          tip: [240, 142, 52],
          rim: [214, 70, 36],
          rimStart: 0.75,
          rays: 10,
          rayDepth: 0.3,
          opacity: { root: 0.8, tip: 0.45 },
          seed: 24,
        },
        pectoral: {
          root: [232, 232, 244],
          tip: [246, 246, 252],
          rays: 8,
          rayDepth: 0.15,
          opacity: { root: 0.35, tip: 0.1 },
          seed: 25,
        },
        pelvic: {
          root: [236, 240, 250],
          tip: [250, 252, 255],
          rays: 4,
          rayDepth: 0.2,
          leadingRay: 0.3,
          opacity: { root: 0.8, tip: 0.5 },
          seed: 26,
        },
      },
    },
    spec: {
      membrane: true,
      roundness: 2.2,
      sections: [
        { t: 0, top: 0, bottom: 0, halfWidth: 0.012 },
        { t: 0.03, top: 0.04, bottom: -0.03, halfWidth: 0.026 },
        { t: 0.08, top: 0.075, bottom: -0.06, halfWidth: 0.04 },
        { t: 0.15, top: 0.098, bottom: -0.085, halfWidth: 0.05 },
        { t: 0.25, top: 0.105, bottom: -0.095, halfWidth: 0.052 },
        { t: 0.35, top: 0.102, bottom: -0.093, halfWidth: 0.05 },
        { t: 0.5, top: 0.084, bottom: -0.077, halfWidth: 0.046 },
        { t: 0.65, top: 0.068, bottom: -0.062, halfWidth: 0.039 },
        { t: 0.8, top: 0.052, bottom: -0.047, halfWidth: 0.03 },
        { t: 0.9, top: 0.042, bottom: -0.037, halfWidth: 0.024 },
        { t: 1, top: 0.036, bottom: -0.03, halfWidth: 0.019 },
      ],
      fins: [
        {
          fin: 'dorsal',
          variant: 1,
          from: 0.2,
          to: 0.235,
          anchor: 'top',
          shape: [0.4, 0.24, 0.11, 0.04],
          sweep: 0.55,
        },
        {
          fin: 'dorsal',
          from: 0.32,
          to: 0.95,
          anchor: 'top',
          shape: [0.04, 0.065, 0.085, 0.095, 0.1, 0.1, 0.095, 0.08, 0.05],
          sweep: 0.4,
        },
        {
          fin: 'anal',
          from: 0.5,
          to: 0.92,
          anchor: 'bottom',
          shape: [0.03, 0.06, 0.08, 0.09, 0.09, 0.075, 0.04],
          sweep: 0.5,
        },
        {
          fin: 'pelvic',
          from: 0.22,
          to: 0.27,
          anchor: 'side',
          flankHeight: 0.05,
          direction: [0.2, -1],
          shape: [0.03, 0.07, 0.07, 0.03],
          sweep: 0.9,
        },
        {
          fin: 'pectoral',
          from: 0.19,
          to: 0.25,
          anchor: 'side',
          flankHeight: 0.4,
          direction: [0.9, -0.3],
          shape: [0.02, 0.06, 0.07, 0.04],
          sweep: 0.6,
        },
      ],
      caudal: { shape: [0.1, 0.18, 0.215, 0.225, 0.215, 0.18, 0.1], spread: 0.05 },
    },
  },
];

export function loftFishPart(
  recipe: LoftFishRecipe,
  standardLengthM: number,
  project: Projection,
  finUv?: [number, number],
  finTexture?: FinTexture,
): Part {
  const scaled: Projection = (behind, y) => project(behind / standardLengthM, y / standardLengthM);
  return loftFish({ ...recipe.spec, standardLengthM }, scaled, recipe.id, finUv, finTexture);
}

export async function buildLoftFish(
  recipe: LoftFishRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  const fromSpecies = speciesLengthM(ctx.repoRoot, recipe.species);
  const standardLengthM = fromSpecies ?? recipe.fallbackLengthM;
  if (recipe.texture.kind === 'photo') ctx.verifySource(recipe.texture.sourceId);
  const { image, project, finUv, finTexture, sources } = await loadTexture(recipe);
  const part = loftFishPart(recipe, standardLengthM, project, finUv, finTexture);
  const translucentFins = finTexture !== undefined;

  const material: MaterialDef = {
    name: recipe.id,
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image },
    roughness: recipe.roughness,
    metallic: 0,
    alphaMode: translucentFins ? 'BLEND' : 'OPAQUE',
    doubleSided: true,
    normalScale: 1,
  };
  const debugRender = await writeDebugRender(ctx.repoRoot, recipe.id, [part], [material]);
  const built = buildDocument(recipe.id, [part], [material]);
  const licence = strictestLicence(sources.map((id) => ctx.licenceOf(id)));
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
