import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import type { FishContext } from './fish.ts';
import type { OutputAsset } from './index-schema.ts';
import type { MaterialDef, Part } from './parts.ts';
import { RAW_ROOT } from './source.ts';
import { decodeImage, type Rgba } from './textures.ts';

export interface LeafCardRecipe {
  id: string;
  sourceId: string;
  colour: string;
  opacity: string;
  /** Edge of the square card in metres. */
  sizeM: number;
}

export function withOpacity(colour: Rgba, opacity: Rgba): Rgba {
  if (colour.width !== opacity.width || colour.height !== opacity.height)
    throw new Error(
      `colour map is ${colour.width}x${colour.height} but opacity is ${opacity.width}x${opacity.height}`,
    );
  const data = new Uint8Array(colour.data);
  for (let i = 0; i < colour.width * colour.height; i++) data[i * 4 + 3] = opacity.data[i * 4] ?? 0;
  return { width: colour.width, height: colour.height, data };
}

const GRID = 4;

/** A square card lying flat on y = 0, facing up, with the whole leaf atlas on it; a grid so coarser levels of detail can be lighter. */
export function flatCard(sizeM: number, material: string): Part {
  const side = GRID + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  const indices: number[] = [];
  for (let z = 0; z < side; z++)
    for (let x = 0; x < side; x++) {
      const v = z * side + x;
      positions.set([(x / GRID - 0.5) * sizeM, 0, (z / GRID - 0.5) * sizeM], v * 3);
      normals.set([0, 1, 0], v * 3);
      uvs.set([x / GRID, z / GRID], v * 2);
      if (x < GRID && z < GRID) indices.push(v, v + side + 1, v + 1, v, v + side, v + side + 1);
    }
  return { positions, normals, uvs, indices: Uint32Array.from(indices), material, extra: {} };
}

export async function buildLeafCard(
  recipe: LeafCardRecipe,
  ctx: FishContext,
): Promise<OutputAsset> {
  ctx.verifySource(recipe.sourceId);
  const dir = join(RAW_ROOT, recipe.sourceId);
  const image = withOpacity(
    await decodeImage(readFileSync(join(dir, recipe.colour))),
    await decodeImage(readFileSync(join(dir, recipe.opacity))),
  );
  const material: MaterialDef = {
    name: recipe.id,
    baseColorFactor: [1, 1, 1, 1],
    baseColor: { role: 'baseColor', codec: 'etc1s', image },
    roughness: 0.85,
    metallic: 0,
    alphaMode: 'MASK',
    doubleSided: true,
    normalScale: 1,
  };
  const plan: LodPlan = { ratios: [1, 0.25, 0.06], minTriangles: 2 };
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'decor',
    id: recipe.id,
    built: buildDocument(recipe.id, [flatCard(recipe.sizeM, recipe.id)], [material]),
    plan,
    meta: {
      origin: 'procedural',
      sources: [recipe.sourceId],
      licence: ctx.licenceOf(recipe.sourceId),
      modifications: [
        `flat ${recipe.sizeM} m card carrying the leaf set, colour map and opacity map merged into one alpha-cutout texture`,
        'colour map re-encoded to KTX2 at 1k and 2k',
      ],
    },
  });
}

export const LEAF_CARD_RECIPES: LeafCardRecipe[] = [
  {
    id: 'oak-leaf-card',
    sourceId: 'ambientcg-LeafSet030',
    colour: 'LeafSet030_2K-JPG_Color.jpg',
    opacity: 'LeafSet030_2K-JPG_Opacity.jpg',
    sizeM: 0.3,
  },
];
