import type { EventBus } from '../engine/events';
import { roomAmbienceAsset } from '../sync/roomCatalog';
import type { InteractionEvents } from './events';

export interface AmbienceSink {
  setAmbience(assetId: string | null): void;
}

/** Plays the shown room's loop, crossfades on a room change and stops for no room. */
export function bindRoomAmbience(
  interaction: EventBus<InteractionEvents>,
  sink: AmbienceSink,
): () => void {
  const play = (state: InteractionEvents['room:state'] | undefined): void => {
    if (state) sink.setAmbience(roomAmbienceAsset(state.roomId));
  };
  play(interaction.peek('room:state'));
  return interaction.on('room:state', play);
}
