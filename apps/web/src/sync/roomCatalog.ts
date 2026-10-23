import { roomFileSchema, type RoomEntry, type RoomId } from '@aquarium/shared';
import roomsJson from '../../../../content/rooms.json';

export const ROOM_ENTRIES: readonly RoomEntry[] = roomFileSchema.parse(roomsJson);

const byId = new Map<string, RoomEntry>(ROOM_ENTRIES.map((e) => [e.id, e]));

export const NO_ROOM_TITLE = 'No room';

export function roomEntry(roomId: string): RoomEntry | undefined {
  return byId.get(roomId);
}

export function roomTitle(roomId: RoomId | null): string {
  if (roomId === null) return NO_ROOM_TITLE;
  return byId.get(roomId)?.name ?? roomId;
}

/** The looping sound asset of a room, or null for no room and for a room without one. */
export function roomAmbienceAsset(roomId: RoomId | null): string | null {
  if (roomId === null) return null;
  return byId.get(roomId)?.ambience.asset ?? null;
}
