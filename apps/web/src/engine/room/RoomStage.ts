import { Group, type Mesh } from 'three/webgpu';
import { roomFileSchema, type RoomId } from '@aquarium/shared';
import roomsJson from '../../../../../content/rooms.json';
import { ASSET_BASE } from '../../scene/assets';
import { RoomProps, type PropSource } from '../../scene/room/RoomProps';
import {
  isRoomId,
  planRoomScene,
  propCatalogFrom,
  ROOM_TIER_POLICY,
  type PropCatalog,
  type RoomScenePlan,
} from '../../scene/room/roomScene';
import { propFilesFrom, type PropFiles } from './gltfPropSource';
import type { RoomLighting } from '../environment';
import { lowerTier, type Tier } from '../quality/tiers';
import type { TankDimensions } from '../tank/dimensions';
import type { LitRoom, LitRoomLayout } from './RoomLight';
import { buildRoomShell, type RoomShell } from './roomShell';

type TankExtent = Pick<TankDimensions, 'length' | 'depth' | 'height'>;

/** Phones hold the room to the mobile GPU budget (8 MB, 15 k triangles, 10 draws) at any tier. */
export const MOBILE_ROOM_TIER: Tier = 'medium';

export function roomTierFor(tier: Tier, mobile: boolean): Tier {
  return mobile ? lowerTier(tier, MOBILE_ROOM_TIER) : tier;
}

export interface RoomStageOptions {
  /** The scene's room PMREM: each room's HDRI is drawn into it, so the glass reflects the room. */
  readonly lighting: Pick<RoomLighting, 'bake'>;
  readonly props: PropSource;
  readonly catalog: PropCatalog;
  /** The URL of a room's 1k HDRI; null lights the room with the default studio. */
  readonly hdriUrl: (roomId: RoomId) => string | null;
  readonly mobile: boolean;
}

/** Each room's HDRI as a URL, or null for none, from `content/rooms.json` and `assets/index.json`. */
export function roomHdriFrom(
  rooms: Iterable<{ id: RoomId; assets: { hdri: string | null } }>,
  entries: Iterable<{ id: string; kind: string; files?: readonly { file: string }[] }>,
): (roomId: RoomId) => string | null {
  const files = new Map<string, string>();
  for (const entry of entries) {
    const file = entry.kind === 'hdri' ? entry.files?.[0]?.file : undefined;
    if (file) files.set(entry.id, file);
  }
  const byRoom = new Map<RoomId, string | null>();
  for (const room of rooms) {
    if (room.assets.hdri === null) {
      byRoom.set(room.id, null);
      continue;
    }
    const file = files.get(room.assets.hdri);
    if (!file) {
      throw new Error(
        `Room ${room.id} names HDRI "${room.assets.hdri}", which assets/index.json lacks`,
      );
    }
    byRoom.set(room.id, `${ASSET_BASE}${file}`);
  }
  return (roomId) => {
    const url = byRoom.get(roomId);
    if (url === undefined) throw new Error(`content/rooms.json does not list ${roomId}`);
    return url;
  };
}

export interface RoomAssets {
  readonly catalog: PropCatalog;
  readonly files: PropFiles;
  readonly hdriUrl: (roomId: RoomId) => string | null;
}

type Vec3 = [number, number, number];

interface RoomAssetEntry {
  id: string;
  kind: string;
  bounds?: { min: Vec3; max: Vec3 };
  lods: { file: string; triangles: number }[];
  files: { file: string }[];
}

function fail(at: string, expected: string): never {
  throw new Error(`assets/index.json: ${at} should be ${expected}; re-run the asset pipeline`);
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(at, 'an object');
  return value as Record<string, unknown>;
}

function vec3(value: unknown, at: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => Number.isFinite(n))) {
    fail(at, 'three finite numbers');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function roomAssetEntry(raw: unknown, i: number): RoomAssetEntry | null {
  const asset = record(raw, `assets[${i}]`);
  if (asset.kind !== 'room-furniture' && asset.kind !== 'hdri') return null;
  if (typeof asset.id !== 'string') fail(`assets[${i}].id`, 'a string');
  const at = `assets[${asset.id}]`;
  const list = (value: unknown, name: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail(`${at}.${name}`, 'an array');
    return value.map((item: unknown, j) => record(item, `${at}.${name}[${j}]`));
  };
  const file = (item: Record<string, unknown>, where: string) => {
    if (typeof item.file !== 'string') fail(`${where}.file`, 'a path');
    return item.file;
  };
  const lods = list(asset.lods, 'lods').map((lod, j) => {
    const triangles = lod.triangles ?? 0;
    if (typeof triangles !== 'number') fail(`${at}.lods[${j}].triangles`, 'a number');
    return { file: file(lod, `${at}.lods[${j}]`), triangles };
  });
  const files = list(asset.files, 'files').map((f, j) => ({ file: file(f, `${at}.files[${j}]`) }));
  const entry: RoomAssetEntry = { id: asset.id, kind: asset.kind, lods, files };
  if (asset.bounds !== undefined) {
    const bounds = record(asset.bounds, `${at}.bounds`);
    entry.bounds = {
      min: vec3(bounds.min, `${at}.bounds.min`),
      max: vec3(bounds.max, `${at}.bounds.max`),
    };
  }
  return entry;
}

/**
 * The room furniture and HDRIs from the parsed `assets/index.json`, joined to each room's HDRI in
 * `content/rooms.json`. Throws when an entry is malformed or a room names an HDRI the index lacks.
 */
export function roomAssetsFrom(json: unknown): RoomAssets {
  const assets = record(json, 'root').assets;
  if (!Array.isArray(assets)) fail('assets', 'an array');
  const entries = assets
    .map((raw: unknown, i) => roomAssetEntry(raw, i))
    .filter((entry): entry is RoomAssetEntry => entry !== null);
  return {
    catalog: propCatalogFrom(entries),
    files: propFilesFrom(entries),
    hdriUrl: roomHdriFrom(roomFileSchema.parse(roomsJson), entries),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The room around the tank, one at a time: its procedural shell at once, then its HDRI drawn into
 * the scene's PMREM and its furniture streamed in. Showing another room frees everything the last
 * one put on the GPU before the next loads, and a show that a newer one overtakes is dropped.
 */
export class RoomStage implements LitRoom {
  readonly group = new Group();
  private readonly props = new RoomProps();
  private shell: RoomShell | null = null;
  private planNow: RoomScenePlan | null = null;
  private layoutNow: LitRoomLayout | null = null;
  private revisionNow = 0;
  private key = 'none';
  private shown: { readonly roomId: string | null; readonly tank: TankExtent } | null = null;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  /** The room whose HDRI the PMREM holds; null for the default studio. */
  private baked: RoomId | null = null;
  private disposed = false;

  constructor(private readonly options: RoomStageOptions) {
    this.group.name = 'room-stage';
    this.group.add(this.props.group);
  }

  get plan(): RoomScenePlan | null {
    return this.planNow;
  }

  get pane(): Mesh | null {
    return this.shell?.pane ?? null;
  }

  get layout(): LitRoomLayout | null {
    return this.layoutNow;
  }

  get revision(): number {
    return this.revisionNow;
  }

  get rig(): RoomScenePlan['light'] | null {
    return this.planNow?.light ?? null;
  }

  /** Draws of the shell and the furniture on show. */
  get drawCalls(): number {
    let calls = 0;
    this.group.traverse((o) => {
      if ((o as Partial<Mesh>).isMesh) calls++;
    });
    return calls;
  }

  /**
   * Shows `roomId`, or the default studio and no room for null, around a tank of `tank`'s size.
   * Settles once the room is complete or a newer show overtook it. Rejects for an unknown room,
   * which keeps the room on show, and for a failed load, which keeps the shell and falls back to
   * the default studio's light. Showing what is already on show or loading changes nothing.
   */
  show(roomId: string | null, tank: TankExtent, tier: Tier): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('RoomStage: show() after dispose()'));
    if (roomId !== null && !isRoomId(roomId)) {
      return Promise.reject(new RangeError(`RoomStage: unknown room "${roomId}"`));
    }
    this.shown = { roomId, tank };
    const roomTier = roomTierFor(tier, this.options.mobile);
    const key =
      roomId === null ? 'none' : [roomId, tank.length, tank.depth, tank.height, roomTier].join('|');
    if (key === this.key) return this.pending ?? Promise.resolve();
    this.key = key;

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.clear();
    const plan =
      roomId === null
        ? null
        : planRoomScene({ roomId, tank, tier: roomTier, catalog: this.options.catalog });
    if (plan) this.build(plan, tank, roomTier);

    const work = this.load(plan, controller);
    this.pending = work;
    const settle = () => {
      if (this.pending === work) this.pending = null;
    };
    work.then(settle, settle);
    return work;
  }

  /** Shows the current room at `tier`; only a change of the room's level of detail reloads it. */
  setTier(tier: Tier): Promise<void> {
    if (!this.shown) return Promise.resolve();
    return this.show(this.shown.roomId, this.shown.tank, tier);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort();
    this.controller = null;
    this.clear();
    this.props.dispose();
    this.group.removeFromParent();
  }

  private build(plan: RoomScenePlan, tank: TankExtent, roomTier: Tier): void {
    const shell = buildRoomShell(plan, ROOM_TIER_POLICY[roomTier], tank);
    this.group.add(shell.group);
    this.shell = shell;
    this.planNow = plan;
    this.layoutNow = {
      shell: plan.shell,
      window: plan.window,
      tank: {
        min: [-tank.length / 2, 0, -tank.depth / 2],
        max: [tank.length / 2, tank.height, tank.depth / 2],
      },
    };
  }

  private async load(plan: RoomScenePlan | null, controller: AbortController): Promise<void> {
    const { signal } = controller;
    const roomId = plan?.roomId ?? null;
    try {
      if (roomId !== this.baked) {
        await this.options.lighting.bake(
          roomId === null ? null : this.options.hdriUrl(roomId),
          plan?.hdriYaw ?? 0,
          signal,
        );
        this.baked = roomId;
      }
      if (plan && plan.props.length > 0) {
        await this.props.show(plan, this.options.props, signal);
        if (controller !== this.controller) return;
        this.revisionNow++;
      }
    } catch (cause) {
      if (controller !== this.controller) return;
      this.key = '';
      if (roomId !== null && this.baked !== roomId && this.baked !== null) this.fallBack();
      if (isAbort(cause)) return;
      throw cause;
    }
  }

  private fallBack(): void {
    this.baked = null;
    this.options.lighting.bake(null, 0).catch((cause: unknown) => {
      if (!isAbort(cause))
        console.debug('The room fell back to the default studio, which failed', cause);
    });
  }

  private clear(): void {
    this.shell?.dispose();
    this.shell = null;
    this.planNow = null;
    this.layoutNow = null;
    this.props.dispose();
    this.group.add(this.props.group);
    this.revisionNow++;
  }
}
