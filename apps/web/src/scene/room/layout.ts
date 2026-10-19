import { STAND_HEIGHT, type TankDimensions } from '../../engine/tank/dimensions';
import type { Tier } from '../../engine/quality/tiers';
import { mulberry32 } from '../placement';

export const ROOM_PRESETS = ['living-room', 'office'] as const;
export type RoomPreset = (typeof ROOM_PRESETS)[number];

export const ROOM_CHOICES = ['none', ...ROOM_PRESETS] as const;
export type RoomChoice = (typeof ROOM_CHOICES)[number];

export const DEFAULT_ROOM_CHOICE: RoomChoice = 'none';

export function isRoomChoice(value: unknown): value is RoomChoice {
  return typeof value === 'string' && (ROOM_CHOICES as readonly string[]).includes(value);
}

/**
 * `shell` is walls, floor and window, `reduced` adds the furniture, `full` adds the ceiling and
 * the books.
 */
export type RoomDetail = 'shell' | 'reduced' | 'full';

const DETAIL: Readonly<Record<Tier, RoomDetail>> = {
  low: 'shell',
  medium: 'reduced',
  high: 'full',
  ultra: 'full',
};

export function roomDetailFor(tier: Tier): RoomDetail {
  return DETAIL[tier];
}

export type Vec3 = readonly [number, number, number];

export type RoomMaterial =
  | 'wall'
  | 'floor'
  | 'ceiling'
  | 'wood'
  | 'darkWood'
  | 'fabric'
  | 'rug'
  | 'metal'
  | 'frame'
  | 'screen';

export interface RoomBox {
  readonly id: string;
  readonly shape: 'box' | 'cylinder';
  /** Centre, in tank space. */
  readonly centre: Vec3;
  /** Extent along x, y, z; a cylinder stands on y and uses `size[0]` as its diameter. */
  readonly size: Vec3;
  readonly material: RoomMaterial;
  /** Lies on the floor or hangs on a wall, so it may pass under the stand or touch others. */
  readonly flat?: boolean;
}

export interface RoomBook {
  readonly centre: Vec3;
  readonly size: Vec3;
  readonly hue: number;
  readonly lightness: number;
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * The window on the back wall. `centre` and `size` are the glazed opening in the wall's plane,
 * where x and y are tank space and z is the wall. A weather pass draws into the pane at `paneZ`
 * and reads the clock itself, so the slot is all it needs.
 */
export interface WindowSlot {
  readonly id: 'window-main';
  readonly centre: Vec3;
  readonly size: readonly [number, number];
  /** Where the sky plane sits, just outside the wall. */
  readonly paneZ: number;
}

export interface RoomLayout {
  readonly preset: RoomPreset;
  readonly shell: Bounds;
  readonly tank: Bounds;
  readonly stand: Bounds;
  readonly boxes: readonly RoomBox[];
  readonly books: readonly RoomBook[];
  readonly window: WindowSlot;
}

export const ROOM_HEIGHT = 2.5;
const WALL_GAP = 0.12;
const STAND_MARGIN = 0.02;
const MIN_HALF_WIDTH = 2.8;
const FRONT_Z = 4.8;
const WINDOW_SIZE = [0.9, 1.1] as const;
const WINDOW_SILL = 0.95;
const WINDOW_CLEARANCE = 0.15;
const FRAME = 0.05;
const TANK_CLEARANCE = 0.35;

type TankExtent = Pick<TankDimensions, 'length' | 'depth' | 'height'>;

interface Frame {
  readonly floorY: number;
  readonly backZ: number;
  readonly halfWidth: number;
  /** Where the free wall space left of the tank starts, a negative x. */
  readonly leftFree: number;
}

function boxAt(
  id: string,
  x: number,
  y: number,
  z: number,
  size: Vec3,
  material: RoomMaterial,
  flat = false,
): RoomBox {
  return {
    id,
    shape: 'box',
    centre: [x, y + size[1] / 2, z],
    size,
    material,
    ...(flat ? { flat } : {}),
  };
}

function bookshelf(frame: Frame, z: number, seed: number): { box: RoomBox; books: RoomBook[] } {
  const size: Vec3 = [0.35, 1.9, 1.2];
  const x = -frame.halfWidth + size[0] / 2;
  const box = boxAt('bookshelf', x, frame.floorY, z, size, 'darkWood');
  const rng = mulberry32(seed);
  const face = x + size[0] / 2;
  const books: RoomBook[] = [];
  for (let row = 0; row < 5; row++) {
    const rowY = frame.floorY + 0.08 + row * 0.36;
    let zCursor = z - size[2] / 2 + 0.06;
    while (zCursor < z + size[2] / 2 - 0.1) {
      const width = 0.03 + rng() * 0.035;
      const height = 0.18 + rng() * 0.12;
      books.push({
        centre: [face + 0.015, rowY + height / 2, zCursor + width / 2],
        size: [0.03, height, width],
        hue: rng(),
        lightness: 0.25 + rng() * 0.25,
      });
      zCursor += width + 0.004;
    }
  }
  return { box, books };
}

function windowFor(tank: TankExtent, frame: Frame): WindowSlot {
  const x = tank.length / 2 + WINDOW_CLEARANCE + WINDOW_SIZE[0] / 2;
  return {
    id: 'window-main',
    centre: [x, frame.floorY + WINDOW_SILL + WINDOW_SIZE[1] / 2, frame.backZ],
    size: WINDOW_SIZE,
    paneZ: frame.backZ - 0.02,
  };
}

function windowFrame(slot: WindowSlot): RoomBox[] {
  const [cx, cy, z] = slot.centre;
  const [w, h] = slot.size;
  const depth = 0.06;
  const bar = (id: string, x: number, y: number, sx: number, sy: number): RoomBox => ({
    id,
    shape: 'box',
    centre: [x, y, z + depth / 2],
    size: [sx, sy, depth],
    material: 'frame',
    flat: true,
  });
  return [
    bar('window-top', cx, cy + h / 2 + FRAME / 2, w + 2 * FRAME, FRAME),
    bar('window-bottom', cx, cy - h / 2 - FRAME / 2, w + 2 * FRAME, FRAME),
    bar('window-left', cx - w / 2 - FRAME / 2, cy, FRAME, h),
    bar('window-right', cx + w / 2 + FRAME / 2, cy, FRAME, h),
    bar('window-mullion', cx, cy, 0.03, h),
  ];
}

function livingRoom(tank: TankExtent, frame: Frame, seed: number) {
  const { floorY, backZ, leftFree } = frame;
  const shelf = bookshelf(frame, backZ + 1.4, seed);
  const sofaX = leftFree - 0.9;
  const boxes: RoomBox[] = [
    boxAt('rug', 0, floorY, backZ + 1.9, [tank.length + 1.6, 0.01, 2.0], 'rug', true),
    boxAt('sofa-seat', sofaX, floorY, backZ + 0.45, [1.8, 0.45, 0.9], 'fabric'),
    boxAt('sofa-back', sofaX, floorY + 0.45, backZ + 0.11, [1.8, 0.5, 0.22], 'fabric'),
    boxAt('coffee-table', sofaX, floorY, backZ + 1.9, [1.0, 0.4, 0.6], 'wood'),
    boxAt('picture', sofaX, floorY + 1.5, backZ + 0.015, [1.0, 0.6, 0.03], 'frame', true),
    shelf.box,
  ];
  return { boxes, books: shelf.books };
}

function office(tank: TankExtent, frame: Frame, seed: number) {
  const { floorY, backZ, leftFree } = frame;
  const deskX = leftFree - 0.8;
  const chairZ = backZ + 1.15;
  const shelf = bookshelf(frame, backZ + 1.4, seed);
  const boxes: RoomBox[] = [
    boxAt('rug', 0, floorY, backZ + 1.9, [tank.length + 1.2, 0.01, 2.0], 'rug', true),
    boxAt('desk-top', deskX, floorY + 0.7, backZ + 0.375, [1.6, 0.04, 0.75], 'wood'),
    boxAt('desk-leg-left', deskX - 0.76, floorY, backZ + 0.375, [0.04, 0.7, 0.7], 'wood'),
    boxAt('desk-leg-right', deskX + 0.76, floorY, backZ + 0.375, [0.04, 0.7, 0.7], 'wood'),
    boxAt('monitor-stand', deskX, floorY + 0.74, backZ + 0.25, [0.06, 0.14, 0.06], 'metal'),
    boxAt('monitor', deskX, floorY + 0.88, backZ + 0.25, [0.6, 0.36, 0.04], 'screen'),
    {
      id: 'chair-pole',
      shape: 'cylinder',
      centre: [deskX, floorY + 0.215, chairZ],
      size: [0.06, 0.43, 0.06],
      material: 'metal',
    },
    boxAt('chair-seat', deskX, floorY + 0.43, chairZ, [0.5, 0.06, 0.5], 'fabric'),
    boxAt('chair-back', deskX, floorY + 0.49, chairZ + 0.28, [0.5, 0.5, 0.06], 'fabric'),
    boxAt('whiteboard', deskX, floorY + 1.3, backZ + 0.015, [1.4, 0.9, 0.03], 'frame', true),
    shelf.box,
  ];
  return { boxes, books: shelf.books };
}

export function roomHalfWidth(tank: TankExtent): number {
  return Math.max(MIN_HALF_WIDTH, tank.length / 2 + 2.6);
}

/**
 * Places a room around a tank of the given size. The tank and its stand stay put; the back wall
 * stands off them by a fixed gap and the furniture is set out from the tank's length, so it
 * clears every size. `seed` only varies the books.
 */
export function planRoom(preset: RoomPreset, tank: TankExtent, seed = 1): RoomLayout {
  if (!ROOM_PRESETS.includes(preset)) throw new RangeError(`Unknown room preset "${preset}"`);
  for (const key of ['length', 'depth', 'height'] as const) {
    if (!(tank[key] > 0)) {
      throw new RangeError(`planRoom: tank ${key} must be > 0, got ${tank[key]}`);
    }
  }
  const floorY = -STAND_HEIGHT;
  const halfWidth = roomHalfWidth(tank);
  const backZ = -(tank.depth / 2 + WALL_GAP);
  const frame: Frame = { floorY, backZ, halfWidth, leftFree: -(tank.length / 2 + TANK_CLEARANCE) };
  const slot = windowFor(tank, frame);
  const built = preset === 'office' ? office(tank, frame, seed) : livingRoom(tank, frame, seed);
  return {
    preset,
    shell: {
      min: [-halfWidth, floorY, backZ],
      max: [halfWidth, floorY + ROOM_HEIGHT, FRONT_Z],
    },
    tank: {
      min: [-tank.length / 2, 0, -tank.depth / 2],
      max: [tank.length / 2, tank.height, tank.depth / 2],
    },
    stand: {
      min: [-tank.length / 2 - STAND_MARGIN, floorY, -tank.depth / 2 - STAND_MARGIN],
      max: [tank.length / 2 + STAND_MARGIN, 0, tank.depth / 2 + STAND_MARGIN],
    },
    boxes: [...built.boxes, ...windowFrame(slot)],
    books: built.books,
    window: slot,
  };
}

export function boxBounds(box: Pick<RoomBox, 'centre' | 'size'>): Bounds {
  const [cx, cy, cz] = box.centre;
  const [sx, sy, sz] = box.size;
  return {
    min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
    max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
  };
}

export function visibleParts(
  layout: RoomLayout,
  detail: RoomDetail,
): { boxes: readonly RoomBox[]; books: readonly RoomBook[]; ceiling: boolean } {
  if (detail === 'shell') return { boxes: [], books: [], ceiling: false };
  const full = detail === 'full';
  return {
    boxes: layout.boxes,
    books: full ? layout.books : [],
    ceiling: full,
  };
}
