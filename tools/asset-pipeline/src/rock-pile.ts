import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import { loadEnvironment, normaliseToBase, type EnvironmentRecipe } from './environment.ts';
import type { FishContext } from './fish.ts';
import type { OutputAsset } from './index-schema.ts';
import { strictestLicence } from './manifest.ts';
import type { MaterialDef, Part } from './parts.ts';

export interface RockPlacement {
  recipeId: string;
  /** Offset on the ground plane in metres, before the pile is re-centred. */
  x: number;
  z: number;
  /** Height of the rock's base above the ground, negative to sink it. */
  y: number;
  yawDeg: number;
  scale: number;
}

export interface RockPileRecipe {
  id: string;
  placements: RockPlacement[];
  modifications: string[];
}

interface LoadedRock {
  parts: Part[];
  materials: MaterialDef[];
}

export function placeRock(part: Part, placement: RockPlacement): Part {
  const yaw = (placement.yawDeg * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const positions = new Float32Array(part.positions.length);
  const normals = new Float32Array(part.normals.length);
  for (let i = 0; i < part.positions.length; i += 3) {
    const x = (part.positions[i] ?? 0) * placement.scale;
    const z = (part.positions[i + 2] ?? 0) * placement.scale;
    positions[i] = x * cos + z * sin + placement.x;
    positions[i + 1] = (part.positions[i + 1] ?? 0) * placement.scale + placement.y;
    positions[i + 2] = -x * sin + z * cos + placement.z;
    const nx = part.normals[i] ?? 0;
    const nz = part.normals[i + 2] ?? 0;
    normals[i] = nx * cos + nz * sin;
    normals[i + 1] = part.normals[i + 1] ?? 0;
    normals[i + 2] = -nx * sin + nz * cos;
  }
  return { ...part, positions, normals, extra: { ...part.extra } };
}

export function composeRockPile(
  recipe: RockPileRecipe,
  loaded: ReadonlyMap<string, LoadedRock>,
): LoadedRock {
  const parts: Part[] = [];
  const materials = new Map<string, MaterialDef>();
  for (const placement of recipe.placements) {
    const member = loaded.get(placement.recipeId);
    if (!member) throw new Error(`${recipe.id}: no rock loaded for ${placement.recipeId}`);
    for (const part of member.parts) parts.push(placeRock(part, placement));
    for (const material of member.materials) materials.set(material.name, material);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts)
    for (let i = 0; i < part.positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a] ?? 0, part.positions[i + a] ?? 0);
        max[a] = Math.max(max[a] ?? 0, part.positions[i + a] ?? 0);
      }
  normaliseToBase(
    parts,
    Math.max(
      (max[0] ?? 0) - (min[0] ?? 0),
      (max[1] ?? 0) - (min[1] ?? 0),
      (max[2] ?? 0) - (min[2] ?? 0),
    ),
  );
  return { parts, materials: [...materials.values()] };
}

export async function buildRockPile(
  recipe: RockPileRecipe,
  members: ReadonlyMap<string, EnvironmentRecipe>,
  ctx: FishContext,
): Promise<OutputAsset> {
  const loaded = new Map<string, LoadedRock>();
  let budget = 0;
  for (const placement of recipe.placements) {
    const member = members.get(placement.recipeId);
    if (!member) throw new Error(`${recipe.id}: unknown rock recipe ${placement.recipeId}`);
    budget += member.maxTriangles;
    if (!loaded.has(placement.recipeId))
      loaded.set(placement.recipeId, await loadEnvironment(member, ctx));
  }
  const { parts, materials } = composeRockPile(recipe, loaded);
  const triangles = parts.reduce((s, p) => s + p.indices.length / 3, 0);
  const lod0 = Math.min(1, budget / triangles);
  const plan: LodPlan = { ratios: [lod0, lod0 * 0.25, lod0 * 0.075], minTriangles: 200 };
  const sources = [
    ...new Set(recipe.placements.flatMap((p) => members.get(p.recipeId)?.sourceId ?? [])),
  ].sort();
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'rock',
    id: recipe.id,
    built: buildDocument(recipe.id, parts, materials),
    plan,
    meta: {
      origin: 'model',
      sources,
      licence: strictestLicence(sources.map((s) => ctx.licenceOf(s))),
      modifications: [
        'merged meshes, dropped unused attributes',
        `${recipe.placements.length} rocks arranged into one pile, base centred on the origin`,
        `LOD0 capped at ${budget} triangles, LOD1 at a quarter of that`,
        ...recipe.modifications,
      ],
    },
  });
}
