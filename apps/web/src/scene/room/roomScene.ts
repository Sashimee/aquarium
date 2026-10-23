import {
  ROOM_IDS,
  roomPresetSchema,
  type RoomId,
  type RoomPreset as RoomPresetData,
} from '@aquarium/shared';
import { DEFAULT_TANK, STAND_HEIGHT, type TankDimensions } from '../../engine/tank/dimensions';
import type { Tier } from '../../engine/quality/tiers';
import beach from '../../../../../content/presets/rooms/room-beach.json';
import bedroom from '../../../../../content/presets/rooms/room-bedroom.json';
import cabin from '../../../../../content/presets/rooms/room-cabin.json';
import library from '../../../../../content/presets/rooms/room-library.json';
import living from '../../../../../content/presets/rooms/room-living.json';
import loft from '../../../../../content/presets/rooms/room-loft.json';
import office from '../../../../../content/presets/rooms/room-office.json';
import publicAquarium from '../../../../../content/presets/rooms/room-public-aquarium.json';
import shop from '../../../../../content/presets/rooms/room-shop.json';
import submarine from '../../../../../content/presets/rooms/room-submarine.json';
import sushi from '../../../../../content/presets/rooms/room-sushi.json';
import zen from '../../../../../content/presets/rooms/room-zen.json';
import {
  ROOM_HEIGHT,
  roomHalfWidth,
  roomShell,
  windowSlotFor,
  type Bounds,
  type Vec3,
  type WindowSlot,
} from './layout';

type TankExtent = Pick<TankDimensions, 'length' | 'depth' | 'height'>;

const RAW: Readonly<Record<RoomId, unknown>> = {
  'room-living': living,
  'room-bedroom': bedroom,
  'room-shop': shop,
  'room-office': office,
  'room-loft': loft,
  'room-zen': zen,
  'room-beach': beach,
  'room-cabin': cabin,
  'room-sushi': sushi,
  'room-library': library,
  'room-public-aquarium': publicAquarium,
  'room-submarine': submarine,
};

export const ROOM_PRESET_DATA: Readonly<Record<RoomId, RoomPresetData>> = Object.fromEntries(
  ROOM_IDS.map((id) => {
    const parsed = roomPresetSchema.parse(RAW[id]);
    if (parsed.roomId !== id) {
      throw new Error(`content/presets/rooms/${id}.json names room "${parsed.roomId}"`);
    }
    return [id, parsed];
  }),
) as Record<RoomId, RoomPresetData>;

/** The community tank (T64) always stands here, whatever its owner chose. */
export const COMMUNITY_ROOM_ID: RoomId = 'room-public-aquarium';

/**
 * The uShaka HDRI has a lit "Snorkel Lagoon" sign at 262 degrees of longitude (u = 0.727). The
 * default view looks at u = 0.25 (-z), so turning the environment by this yaw, radians about y,
 * puts the sign straight behind the camera, where the idle orbit's limits keep it out of the
 * glass and the reflections. The environment loader applies it as `environmentRotation.y`.
 */
export const ROOM_HDRI_YAW: Readonly<Partial<Record<RoomId, number>>> = {
  'room-public-aquarium': 0.145,
};

export interface PropEntry {
  readonly bounds: Bounds;
  readonly lods: readonly { readonly triangles: number }[];
}

/** Looks a prop up in the asset index, or returns undefined when the index has no such prop. */
export type PropCatalog = (assetId: string) => PropEntry | undefined;

export type PropLod = 0 | 2;

export interface RoomTierPolicy {
  /** Which LOD the props use; null leaves the room as the procedural shell and the HDRI. */
  readonly lod: PropLod | null;
  /** Triangle budget for the props, leaving the shell's few hundred under PLAN 9.2's limits. */
  readonly maxTriangles: number;
  /** Real lights for lamps and flames, which T74 dropped the emissive maps for. */
  readonly practicalLights: boolean;
}

export const ROOM_TIER_POLICY: Readonly<Record<Tier, RoomTierPolicy>> = {
  low: { lod: null, maxTriangles: 0, practicalLights: false },
  medium: { lod: 2, maxTriangles: 14_000, practicalLights: false },
  high: { lod: 0, maxTriangles: 58_000, practicalLights: true },
  ultra: { lod: 0, maxTriangles: 58_000, practicalLights: true },
};

export interface PlacedProp {
  readonly asset: string;
  /** Tank space, base centre of the prop. */
  readonly position: Vec3;
  readonly rotationY: number;
  readonly scale: number;
  readonly lod: PropLod;
  readonly triangles: number;
  /** World-aligned box of the rotated prop. */
  readonly bounds: Bounds;
}

export interface PracticalLight {
  readonly asset: string;
  readonly position: Vec3;
  readonly color: string;
  /** Candela. */
  readonly intensity: number;
  /** Reach in metres: three's light cut-off, so a lamp never lights the tank's fish. */
  readonly distance: number;
}

export interface RoomLightPlan {
  readonly key: { readonly color: string; readonly intensity: number; readonly position: Vec3 };
  readonly ambient: { readonly color: string; readonly intensity: number };
  readonly practical: readonly PracticalLight[];
}

export interface RoomScenePlan {
  readonly roomId: RoomId;
  readonly shell: Bounds;
  readonly window: WindowSlot | null;
  readonly props: readonly PlacedProp[];
  /** Props the tier's triangle budget left out, in layout order. */
  readonly dropped: readonly string[];
  readonly triangles: number;
  readonly light: RoomLightPlan;
  readonly hdriYaw: number;
}

interface LampSpec {
  /** From the prop's base centre, turned with the prop. */
  readonly offset: Vec3;
  readonly color: string;
  readonly intensity: number;
  readonly distance: number;
}

const LAMPS: Readonly<Record<string, LampSpec>> = {
  'polyhaven-vintage-oil-lamp': {
    offset: [0, 0.45, 0],
    color: '#ffb361',
    intensity: 4,
    distance: 2.2,
  },
  'polyhaven-hanging-industrial-lamp': {
    offset: [0, 0.3, 0],
    color: '#ffd9a0',
    intensity: 8,
    distance: 3,
  },
  'polyhaven-scandinavian-masonry-heater': {
    offset: [0, 0.4, 0.45],
    color: '#ff7a2a',
    intensity: 6,
    distance: 2.4,
  },
};

const REFERENCE: TankExtent = DEFAULT_TANK;
const FLOOR_Y = -STAND_HEIGHT;
const REFERENCE_WALL = roomShell(REFERENCE).min[2];

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && (ROOM_IDS as readonly string[]).includes(value);
}

export function roomPresetData(roomId: string): RoomPresetData {
  if (!isRoomId(roomId)) {
    throw new RangeError(`Unknown room "${roomId}"; expected one of ${ROOM_IDS.join(', ')}`);
  }
  return ROOM_PRESET_DATA[roomId];
}

export function propCatalogFrom(
  entries: Iterable<{
    id: string;
    kind: string;
    bounds?: { min: readonly number[]; max: readonly number[] };
    lods: readonly { triangles?: number }[];
  }>,
): PropCatalog {
  const byId = new Map<string, PropEntry>();
  for (const entry of entries) {
    if (entry.kind !== 'room-furniture' || !entry.bounds) continue;
    const { min, max } = entry.bounds;
    byId.set(entry.id, {
      bounds: {
        min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
        max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
      },
      lods: entry.lods.map((l) => ({ triangles: l.triangles ?? 0 })),
    });
  }
  return (id) => byId.get(id);
}

export function rotatedBounds(
  bounds: Bounds,
  position: Vec3,
  rotationY: number,
  scale: number,
): Bounds {
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const min: [number, number, number] = [Infinity, position[1] + bounds.min[1] * scale, Infinity];
  const max: [number, number, number] = [-Infinity, position[1] + bounds.max[1] * scale, -Infinity];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const z of [bounds.min[2], bounds.max[2]]) {
      const lx = x * scale;
      const lz = z * scale;
      const wx = position[0] + lx * cos + lz * sin;
      const wz = position[2] - lx * sin + lz * cos;
      min[0] = Math.min(min[0], wx);
      max[0] = Math.max(max[0], wx);
      min[2] = Math.min(min[2], wz);
      max[2] = Math.max(max[2], wz);
    }
  }
  return { min, max };
}

/**
 * Layouts are authored around the 120 x 50 cm reference tank. Props that flank the tank keep
 * their distance to the side wall, which stands off the tank by a fixed gap, and every prop
 * moves with the back wall, so no size of tank leaves a prop inside the stand or through a wall.
 */
export function fitToTank(position: Vec3, tank: TankExtent): Vec3 {
  const [x, y, z] = position;
  const sideShift = roomHalfWidth(tank) - roomHalfWidth(REFERENCE);
  const fitted = x + (Math.abs(x) > REFERENCE.length / 2 ? Math.sign(x) * sideShift : 0);
  return [fitted, y, z + roomShell(tank).min[2] - REFERENCE_WALL];
}

function rotateOffset(offset: Vec3, rotationY: number): Vec3 {
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  return [offset[0] * cos + offset[2] * sin, offset[1], -offset[0] * sin + offset[2] * cos];
}

export interface RoomSceneInput {
  readonly roomId: RoomId;
  readonly tank: TankExtent;
  readonly tier: Tier;
  readonly catalog: PropCatalog;
  readonly preset?: RoomPresetData;
}

/**
 * Plans one room around a tank: the window that follows the tank, the props the tier can afford at
 * its LOD, and the light rig. The layout's order is its priority, so a tier over its triangle
 * budget keeps the first props and drops the rest; hosts come before what stands on them.
 */
export function planRoomScene(input: RoomSceneInput): RoomScenePlan {
  const { roomId, tank, tier, catalog } = input;
  for (const key of ['length', 'depth', 'height'] as const) {
    if (!(tank[key] > 0)) {
      throw new RangeError(`planRoomScene: tank ${key} must be > 0, got ${tank[key]}`);
    }
  }
  const preset = input.preset ?? roomPresetData(roomId);
  const policy = ROOM_TIER_POLICY[tier];
  const rig = preset.light;
  const window = rig.windowPosition === null ? null : windowSlotFor(tank, rig.windowPosition[1]);

  const props: PlacedProp[] = [];
  const dropped: string[] = [];
  let triangles = 0;
  let full = false;
  if (policy.lod !== null) {
    for (const prop of preset.layout) {
      const entry = catalog(prop.asset);
      if (!entry) {
        throw new Error(
          `Room ${roomId} uses "${prop.asset}", which assets/index.json has no room-furniture entry for; run pnpm build:assets`,
        );
      }
      const level = entry.lods[policy.lod];
      if (!level) {
        throw new Error(`"${prop.asset}" has no LOD${policy.lod} in assets/index.json`);
      }
      if (full || triangles + level.triangles > policy.maxTriangles) {
        full = true;
        dropped.push(prop.asset);
        continue;
      }
      const position = fitToTank(prop.position, tank);
      triangles += level.triangles;
      props.push({
        asset: prop.asset,
        position,
        rotationY: prop.rotationY,
        scale: prop.scale,
        lod: policy.lod,
        triangles: level.triangles,
        bounds: rotatedBounds(entry.bounds, position, prop.rotationY, prop.scale),
      });
    }
  }

  const practical: PracticalLight[] = [];
  if (policy.practicalLights) {
    for (const prop of props) {
      const lamp = LAMPS[prop.asset];
      if (!lamp) continue;
      const turned = rotateOffset(lamp.offset, prop.rotationY);
      practical.push({
        asset: prop.asset,
        position: [
          prop.position[0] + turned[0] * prop.scale,
          prop.position[1] + turned[1] * prop.scale,
          prop.position[2] + turned[2] * prop.scale,
        ],
        color: lamp.color,
        intensity: lamp.intensity,
        distance: lamp.distance,
      });
    }
  }

  const keyAt: Vec3 = window
    ? [window.centre[0], window.centre[1], window.centre[2] + 0.3]
    : [0, FLOOR_Y + ROOM_HEIGHT - 0.2, 0.6];

  return {
    roomId,
    shell: roomShell(tank),
    window,
    props,
    dropped,
    triangles,
    light: {
      key: { color: rig.keyColor, intensity: rig.keyIntensity, position: keyAt },
      ambient: { color: rig.ambientColor, intensity: rig.ambientIntensity },
      practical,
    },
    hdriYaw: ROOM_HDRI_YAW[roomId] ?? 0,
  };
}

/** `null` is the "no room" setting and plans nothing; an id the content doesn't know throws. */
export function planRoomChoice(
  roomId: string | null,
  input: Omit<RoomSceneInput, 'roomId'>,
): RoomScenePlan | null {
  if (roomId === null) return null;
  if (!isRoomId(roomId)) {
    throw new RangeError(`Unknown room "${roomId}"; expected one of ${ROOM_IDS.join(', ')}`);
  }
  return planRoomScene({ ...input, roomId });
}
