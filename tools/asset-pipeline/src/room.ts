import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Document, Material } from '@gltf-transform/core';
import { KHRMaterialsTransmission, type Transmission } from '@gltf-transform/extensions';
import { roomFileSchema, type RoomEntry } from '@aquarium/shared';
import type { AudioRecipe } from './audio.ts';
import { buildDocument, emitAsset, type LodPlan } from './emit.ts';
import type { HdriRecipe } from './environment.ts';
import type { FishContext } from './fish.ts';
import type { OutputAsset } from './index-schema.ts';
import { extractParts, materialDefFrom, mergeParts, weldPart } from './parts.ts';
import type { MaterialDef, Part } from './parts.ts';
import { RAW_ROOT, bakeToWorldSpace, readGltf } from './source.ts';
import { decodeImage, resizeImage } from './textures.ts';

/** Per-room share of the mobile triangle budget the props may use; the rest is left to the procedural shell. */
export const MOBILE_PROP_TRIANGLES = 14_000;
export const LOD0_MAX_TRIANGLES = 7_000;
export const ROOM_TEXTURE_PX = 512;

/** room-shop is within 0.1 MB of its 1.8 MB budget; its props take a coarser metallic-roughness map, since roughness varies slowly over a surface. */
export interface RoomPropTuning {
  roughnessPx?: number;
}

export const ROOM_PROP_TUNING: Readonly<Record<string, RoomPropTuning>> = {
  'polyhaven-steel-frame-shelves-03': { roughnessPx: 256 },
  'polyhaven-cashregister-01': { roughnessPx: 256 },
  'polyhaven-plastic-crate-02': { roughnessPx: 256 },
};
const TRANSMISSION_ALPHA = 0.35;

export function loadRooms(repoRoot: string): RoomEntry[] {
  return roomFileSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, 'content', 'rooms.json'), 'utf8')),
  );
}

export function roomPropIds(rooms: readonly RoomEntry[]): string[] {
  return [...new Set(rooms.flatMap((r) => r.assets.furniture))].sort();
}

export function roomHdriIds(rooms: readonly RoomEntry[]): string[] {
  return [...new Set(rooms.flatMap((r) => (r.assets.hdri === null ? [] : [r.assets.hdri])))].sort();
}

export function roomAmbienceIds(rooms: readonly RoomEntry[]): string[] {
  return [
    ...new Set(rooms.flatMap((r) => (r.ambience.asset === null ? [] : [r.ambience.asset]))),
  ].sort();
}

function onlyFile(sourceId: string, extension: string): string {
  const dir = join(RAW_ROOT, sourceId);
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(extension));
  const [file] = files;
  if (files.length !== 1 || file === undefined)
    throw new Error(
      `${sourceId}: expected exactly one ${extension} in ${dir}, found ${files.length}`,
    );
  return file;
}

// Underscores only: staticCacheControl treats `name-<8 chars>.ext` under assets/ as a content-hashed bundle and marks it immutable.
export function roomHdriOutput(id: string): string {
  return `${id.replaceAll('-', '_')}_1k.ktx2`;
}

export function roomHdriRecipe(id: string): HdriRecipe {
  return { id, sourceId: id, file: onlyFile(id, '.hdr'), output: roomHdriOutput(id) };
}

/**
 * Loops are cut from the part of the recording that is free of voices: `searchS` limits the
 * stationary-window search, and the cut loops are transcribed again with faster-whisper before they ship.
 */
export interface RoomAmbienceTuning {
  searchS?: [number, number];
  limit?: boolean;
}

export const AMBIENCE_TUNING: Readonly<Record<string, RoomAmbienceTuning>> = {
  'freesound-393689': { searchS: [10, 55] },
  'freesound-620683': { searchS: [100, 540] },
  'freesound-346321': { limit: true },
};

export function roomAmbienceRecipe(id: string): AudioRecipe {
  const tuning = AMBIENCE_TUNING[id];
  return {
    id,
    source: id,
    role: 'room-ambience',
    targetLufs: -26,
    highpassHz: 60,
    loop: { loopS: 14, crossfadeS: 1, ...(tuning?.searchS ? { searchS: tuning.searchS } : {}) },
    ...(tuning?.limit ? { limit: true } : {}),
  };
}

/**
 * Mobile triangle target per prop. Every room using a prop must fit, so a prop takes the smallest
 * scale of the rooms it stands in; a prop that already fits everywhere keeps its LOD0 count.
 */
export function mobileTriangleTargets(
  rooms: readonly Pick<RoomEntry, 'id' | 'assets'>[],
  triangles: ReadonlyMap<string, number>,
  budget = MOBILE_PROP_TRIANGLES,
): Map<string, number> {
  const scale = new Map<string, number>();
  for (const room of rooms) {
    const total = room.assets.furniture.reduce(
      (sum, id) => sum + triangleCountOf(triangles, id),
      0,
    );
    const roomScale = total === 0 ? 1 : Math.min(1, budget / total);
    for (const id of room.assets.furniture) scale.set(id, Math.min(scale.get(id) ?? 1, roomScale));
  }
  return new Map(
    [...scale].map(([id, s]) => [id, Math.floor(triangleCountOf(triangles, id) * s)] as const),
  );
}

function triangleCountOf(triangles: ReadonlyMap<string, number>, id: string): number {
  const count = triangles.get(id);
  if (count === undefined) throw new Error(`${id}: no triangle count; is it in the room plan?`);
  return count;
}

export function lodRatios(triangles: number, mobileTriangles: number): [number, number, number] {
  const lod0 = Math.min(1, LOD0_MAX_TRIANGLES / triangles);
  const lod2 = Math.max(0.02, Math.min(lod0 * 0.35, mobileTriangles / triangles));
  const lod1 = Math.max(lod2 * 1.25, lod0 * 0.6);
  return [lod0, Math.min(lod1, lod0 * 0.85), lod2];
}

function sourceGltf(sourceId: string): string {
  return onlyFile(sourceId, '.gltf');
}

async function loadParts(
  sourceId: string,
  ctx: Pick<FishContext, 'verifySource'>,
): Promise<{ doc: Document; parts: Part[] }> {
  ctx.verifySource(sourceId);
  const doc = await readGltf(sourceId, sourceGltf(sourceId));
  bakeToWorldSpace(doc, () => false);
  const welded = extractParts(doc).map(weldPart);
  if (welded.length === 0) throw new Error(`${sourceId}: no geometry`);
  const byMaterial = new Map<string, Part[]>();
  for (const part of welded)
    byMaterial.set(part.material, [...(byMaterial.get(part.material) ?? []), part]);
  const parts = [...byMaterial].map(([material, group]) => mergeParts(group, material));
  return { doc, parts };
}

export async function roomPropTriangles(
  sourceId: string,
  ctx: Pick<FishContext, 'verifySource'>,
): Promise<number> {
  const { parts } = await loadParts(sourceId, ctx);
  return parts.reduce((sum, p) => sum + p.indices.length / 3, 0);
}

function recentreOnBase(parts: Part[]): void {
  const range = (axis: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const part of parts)
      for (const [i, v] of part.positions.entries())
        if (i % 3 === axis) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
    return { lo, mid: (lo + hi) / 2 };
  };
  const x = range(0).mid;
  const y = range(1).lo;
  const z = range(2).mid;
  for (const part of parts)
    for (const [i, v] of part.positions.entries())
      part.positions[i] = v - (i % 3 === 0 ? x : i % 3 === 1 ? y : z);
}

async function roomMaterial(source: Material, roughnessPx: number): Promise<MaterialDef> {
  const def = await materialDefFrom(source, {
    roughness: source.getRoughnessFactor(),
    metallic: source.getMetallicFactor(),
  });
  const transmission = source.getExtension<Transmission>(KHRMaterialsTransmission.EXTENSION_NAME);
  const cap = async <T extends { image: Parameters<typeof resizeImage>[0] }>(
    texture: T | undefined,
    px = ROOM_TEXTURE_PX,
  ): Promise<T | undefined> =>
    texture ? { ...texture, image: await resizeImage(texture.image, px) } : undefined;
  const baseColor = await cap(def.baseColor);
  const normal = await cap(def.normal);
  const roughnessBytes = source.getMetallicRoughnessTexture()?.getImage();
  const metallicRoughness = roughnessBytes
    ? await cap(
        {
          role: 'metallicRoughness' as const,
          codec: 'etc1s' as const,
          image: dropOcclusion(await decodeImage(roughnessBytes)),
        },
        roughnessPx,
      )
    : undefined;
  const glass = transmission !== null && transmission.getTransmissionFactor() > 0;
  return {
    ...def,
    ...(baseColor ? { baseColor } : {}),
    ...(normal ? { normal } : {}),
    ...(metallicRoughness ? { metallicRoughness } : {}),
    ...(glass
      ? {
          alphaMode: 'BLEND' as const,
          baseColorFactor: [
            def.baseColorFactor[0],
            def.baseColorFactor[1],
            def.baseColorFactor[2],
            TRANSMISSION_ALPHA,
          ] as MaterialDef['baseColorFactor'],
        }
      : {}),
  };
}

/** The red channel of a Poly Haven ARM map is occlusion, which the material does not read; a constant channel compresses better. */
function dropOcclusion(image: Awaited<ReturnType<typeof decodeImage>>) {
  const data = new Uint8Array(image.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 3] = 255;
  }
  return { ...image, data };
}

export async function buildRoomProp(
  id: string,
  mobileTriangles: number,
  ctx: FishContext,
): Promise<OutputAsset> {
  const tuning = ROOM_PROP_TUNING[id];
  const { doc, parts } = await loadParts(id, ctx);
  recentreOnBase(parts);
  const used = new Set(parts.map((p) => p.material));
  const materials: MaterialDef[] = [];
  for (const source of doc.getRoot().listMaterials())
    if (used.has(source.getName()))
      materials.push(await roomMaterial(source, tuning?.roughnessPx ?? ROOM_TEXTURE_PX));

  const triangles = parts.reduce((sum, p) => sum + p.indices.length / 3, 0);
  const plan: LodPlan = {
    ratios: lodRatios(triangles, mobileTriangles),
    minTriangles: 24,
    sloppyFallback: true,
  };
  const built = buildDocument(id, parts, materials);
  const slots = materials.reduce(
    (sum, m) => sum + [m.baseColor, m.normal, m.metallicRoughness].filter(Boolean).length,
    0,
  );
  return emitAsset({
    outRoot: ctx.outRoot,
    kind: 'room-furniture',
    id,
    built,
    plan,
    meta: {
      origin: 'model',
      sources: [id],
      licence: ctx.licenceOf(id),
      modifications: [
        'node transforms baked, meshes merged into one primitive per material, origin at the base centre, true scale in metres kept',
        `LOD0 capped at ${LOD0_MAX_TRIANGLES} triangles; LOD2 is the mobile level, sized so the props of every room using it stay within ${MOBILE_PROP_TRIANGLES} triangles together`,
        `${
          tuning?.roughnessPx
            ? `colour and normal maps capped at ${ROOM_TEXTURE_PX} px, metallic-roughness maps at ${tuning.roughnessPx} px`
            : `colour, normal and metallic-roughness maps capped at ${ROOM_TEXTURE_PX} px`
        } and re-encoded to KTX2 (ETC1S), one file for every quality tier${
          built.textures.length < slots
            ? '; identical maps of different materials are written once'
            : ''
        }`,
        ...(materials.some(
          (m) => m.alphaMode === 'BLEND' && m.baseColorFactor[3] === TRANSMISSION_ALPHA,
        )
          ? ['transmissive glass replaced by alpha blending']
          : []),
      ],
    },
  });
}
