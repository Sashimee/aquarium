import { DEFAULT_ROOM_ID, isFreeRoom, type RoomId, type Tank } from '@aquarium/shared';

export const DEVICE_ROOM_KEY = 'aquarium.room';

const FROM_DEVICE: Readonly<Record<string, RoomId | null>> = {
  'living-room': 'room-living',
  office: 'room-office',
  none: null,
};

export interface RoomMove {
  tankId: string;
  roomId: RoomId | null;
}

export interface RoomMigration {
  moves: RoomMove[];
  /** True when nothing is left to apply once the moves are made, so the device key can go. */
  done: boolean;
}

/**
 * T57 kept the room per device. Only an explicitly stored value counts, and it lands only on tanks
 * the player never set that still stand in the default living room, and only in a room the owner
 * may use. A value that is not one of T57's three is junk and is dropped.
 */
export function planRoomMigration(
  stored: string | null,
  tanks: readonly Pick<Tank, 'id' | 'roomId' | 'roomSetAt'>[],
  ownedRooms: readonly RoomId[],
): RoomMigration {
  if (stored === null) return { moves: [], done: false };
  if (!Object.hasOwn(FROM_DEVICE, stored)) return { moves: [], done: true };
  const target = FROM_DEVICE[stored] ?? null;
  const usable = target === null || isFreeRoom(target) || ownedRooms.includes(target);
  if (!usable || target === DEFAULT_ROOM_ID) return { moves: [], done: true };
  const moves = tanks
    .filter((t) => t.roomSetAt === null && t.roomId === DEFAULT_ROOM_ID)
    .map((t) => ({ tankId: t.id, roomId: target }));
  return { moves, done: true };
}
