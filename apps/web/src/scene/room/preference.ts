import { DEFAULT_ROOM_CHOICE, isRoomChoice, type RoomChoice } from './layout';

export const ROOM_STORAGE_KEY = 'aquarium.room';

export type RoomStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The player's room choice, kept in local storage. `subscribe` and `snapshot` have the shape
 * React's `useSyncExternalStore` takes, so the settings screen can bind to them directly.
 */
export class RoomPreference {
  private current: RoomChoice;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: RoomStorage | null) {
    this.current = this.read();
  }

  readonly snapshot = (): RoomChoice => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(choice: RoomChoice): void {
    if (!isRoomChoice(choice)) throw new RangeError(`Unknown room choice "${String(choice)}"`);
    if (choice === this.current) return;
    this.current = choice;
    try {
      this.storage?.setItem(ROOM_STORAGE_KEY, choice);
    } catch {
      // Storage can be full or blocked; the choice then lasts for this session only.
    }
    for (const listener of [...this.listeners]) listener();
  }

  private read(): RoomChoice {
    try {
      const stored = this.storage?.getItem(ROOM_STORAGE_KEY);
      return isRoomChoice(stored) ? stored : DEFAULT_ROOM_CHOICE;
    } catch {
      return DEFAULT_ROOM_CHOICE;
    }
  }
}

export function browserRoomStorage(): RoomStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
