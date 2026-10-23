import { DEFAULT_ROOM_ID, type RoomId } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';

/**
 * Keeps which room stands around the tank on show: the loaded tank's, the community hall, or the
 * default living room for the demo tank. The server's changes come back as `tank:room`.
 */
export class ShownRoom {
  private tankId: string | null = null;
  private roomId: RoomId | null = DEFAULT_ROOM_ID;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId, roomId }) => {
        if (roomId !== undefined) this.show(tankId, roomId);
        else this.show(tankId, tankId === this.tankId ? this.roomId : DEFAULT_ROOM_ID);
      }),
      interaction.on('tank:room', ({ tankId, roomId }) => {
        if (tankId === this.tankId) this.show(tankId, roomId);
      }),
      interaction.on('tank:unloaded', ({ tankId, reason }) => {
        if (reason === 'reset' && tankId === this.tankId) this.show(null, DEFAULT_ROOM_ID);
      }),
      interaction.on('tank:none', () => this.show(null, DEFAULT_ROOM_ID)),
    ];
    this.emit();
  }

  readonly snapshot = (): RoomId | null => this.roomId;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.listeners.clear();
  }

  private show(tankId: string | null, roomId: RoomId | null): void {
    const changed = tankId !== this.tankId || roomId !== this.roomId;
    this.tankId = tankId;
    this.roomId = roomId;
    if (changed) this.emit();
  }

  private emit(): void {
    this.interaction.emit('room:state', { tankId: this.tankId, roomId: this.roomId });
    for (const listener of [...this.listeners]) listener();
  }
}
