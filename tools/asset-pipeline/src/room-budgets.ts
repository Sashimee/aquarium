import type { RoomEntry } from '@aquarium/shared';
import type { AssetIndex, OutputAsset } from './index-schema.ts';

/** PLAN section 9.2, Rooms. Shared props count toward every room that uses them. */
export const ROOM_MAX_BYTES = 1_800_000;
export const ALL_ROOMS_MAX_BYTES = 22_000_000;
export const AMBIENCE_MAX_SPREAD_LU = 2;

export const ROOM_GPU_BUDGETS = {
  mobile: { lod: 2, triangles: 15_000, drawCalls: 10 },
  high: { lod: 0, triangles: 60_000, drawCalls: 30 },
} as const;
export type RoomGpuTier = keyof typeof ROOM_GPU_BUDGETS;

export interface RoomTierStats {
  triangles: number;
  drawCalls: number;
}

export interface RoomStats {
  id: string;
  bytes: number;
  tiers: Record<RoomGpuTier, RoomTierStats>;
}

export interface RoomRefs {
  manifestIds: ReadonlySet<string>;
  index: AssetIndex;
  /** Primitive count of a built GLB, which is its draw-call count: one material per primitive. */
  drawCallsOf(file: string): number;
}

function builtAsset(index: AssetIndex, kind: OutputAsset['kind'], id: string) {
  return index.assets.find((a) => a.kind === kind && a.id === id);
}

function roomAssets(room: RoomEntry, index: AssetIndex) {
  const shell =
    room.assets.shell === null ? undefined : builtAsset(index, 'room-furniture', room.assets.shell);
  const furniture = room.assets.furniture.map((id) => builtAsset(index, 'room-furniture', id));
  const hdri = room.assets.hdri === null ? undefined : builtAsset(index, 'hdri', room.assets.hdri);
  const audio =
    room.ambience.asset === null ? undefined : builtAsset(index, 'audio', room.ambience.asset);
  return { shell, furniture, hdri, audio };
}

export function roomStats(room: RoomEntry, refs: RoomRefs): RoomStats {
  const { shell, furniture, hdri, audio } = roomAssets(room, refs.index);
  const files = new Map<string, number>();
  for (const asset of [shell, ...furniture, hdri, audio])
    for (const file of asset?.files ?? []) files.set(file.file, file.bytes);
  const tiers = {} as Record<RoomGpuTier, RoomTierStats>;
  for (const tier of Object.keys(ROOM_GPU_BUDGETS) as RoomGpuTier[]) {
    const lod = ROOM_GPU_BUDGETS[tier].lod;
    let triangles = 0;
    let drawCalls = 0;
    for (const asset of [shell, ...furniture]) {
      const level = asset?.lods[lod];
      if (!level) continue;
      triangles += level.triangles;
      drawCalls += refs.drawCallsOf(level.file);
    }
    tiers[tier] = { triangles, drawCalls };
  }
  return { id: room.id, bytes: [...files.values()].reduce((s, b) => s + b, 0), tiers };
}

export function ambienceLoudnessProblems(
  rooms: readonly RoomEntry[],
  index: AssetIndex,
  maxSpreadLu = AMBIENCE_MAX_SPREAD_LU,
): string[] {
  const loudness = new Map<string, number>();
  for (const room of rooms) {
    const id = room.ambience.asset;
    const lufs = id === null ? undefined : builtAsset(index, 'audio', id)?.audio?.loudnessLufs;
    if (id !== null && lufs !== undefined) loudness.set(id, lufs);
  }
  if (loudness.size < 2) return [];
  const entries = [...loudness].sort((a, b) => a[1] - b[1]);
  const quietest = entries[0];
  const loudest = entries[entries.length - 1];
  if (!quietest || !loudest) return [];
  const spread = loudest[1] - quietest[1];
  if (spread <= maxSpreadLu) return [];
  return [
    `room ambience loudness spans ${spread.toFixed(1)} LU (${quietest[0]} at ${quietest[1]} LUFS, ${loudest[0]} at ${loudest[1]} LUFS), over the ${maxSpreadLu} LU bound; rebuild the quiet one with a limiter or re-cut its section`,
  ];
}

export function roomProblems(rooms: readonly RoomEntry[], refs: RoomRefs): string[] {
  const problems: string[] = [];
  const unique = new Map<string, number>();
  for (const room of rooms) {
    const at = `room ${room.id}`;
    const wanted: [string, string | null][] = [
      ['shell', room.assets.shell],
      ['hdri', room.assets.hdri],
      ['ambience asset', room.ambience.asset],
      ...room.assets.furniture.map((id): [string, string] => ['furniture', id]),
    ];
    for (const [label, id] of wanted)
      if (id !== null && !refs.manifestIds.has(id))
        problems.push(`${at}: ${label} "${id}" is not in assets/manifest.json`);

    const { shell, furniture, hdri, audio } = roomAssets(room, refs.index);
    if (room.assets.shell !== null && !shell)
      problems.push(
        `${at}: shell "${room.assets.shell}" is not in the built index (run pnpm build:assets)`,
      );
    room.assets.furniture.forEach((id, i) => {
      if (!furniture[i])
        problems.push(`${at}: furniture "${id}" is not in the built index (run pnpm build:assets)`);
    });
    if (room.assets.hdri !== null && !hdri)
      problems.push(
        `${at}: hdri "${room.assets.hdri}" is not in the built index (run pnpm build:assets)`,
      );
    if (room.ambience.sound !== null) {
      if (!audio || !audio.files.some((f) => f.file === room.ambience.sound))
        problems.push(
          `${at}: ambience.sound ${room.ambience.sound} is not in the built index (run pnpm build:assets)`,
        );
    }

    const stats = roomStats(room, refs);
    if (stats.bytes > ROOM_MAX_BYTES)
      problems.push(
        `${at}: ships ${(stats.bytes / 1e6).toFixed(2)} MB with its audio, over the ${ROOM_MAX_BYTES / 1e6} MB room budget`,
      );
    for (const tier of Object.keys(ROOM_GPU_BUDGETS) as RoomGpuTier[]) {
      const budget = ROOM_GPU_BUDGETS[tier];
      const used = stats.tiers[tier];
      if (used.triangles > budget.triangles)
        problems.push(
          `${at}: ${tier} tier (LOD${budget.lod}) draws ${used.triangles} triangles, over the ${budget.triangles} budget`,
        );
      if (used.drawCalls > budget.drawCalls)
        problems.push(
          `${at}: ${tier} tier (LOD${budget.lod}) needs ${used.drawCalls} draw calls, over the ${budget.drawCalls} budget`,
        );
    }
    for (const asset of [shell, ...furniture, hdri, audio])
      for (const file of asset?.files ?? []) unique.set(file.file, file.bytes);
  }
  problems.push(...ambienceLoudnessProblems(rooms, refs.index));
  const total = [...unique.values()].reduce((s, b) => s + b, 0);
  if (total > ALL_ROOMS_MAX_BYTES)
    problems.push(
      `all rooms ship ${(total / 1e6).toFixed(2)} MB, over the ${ALL_ROOMS_MAX_BYTES / 1e6} MB budget for every room together`,
    );
  return problems;
}
