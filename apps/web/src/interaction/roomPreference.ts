import { RoomPreference, browserRoomStorage } from '../scene/room/preference';

/** One choice for the whole page: the settings screen writes it, the scene reads it. */
export const roomPreference = new RoomPreference(browserRoomStorage());
