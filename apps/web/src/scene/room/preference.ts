import { DEFAULT_ROOM_CHOICE, isRoomChoice, type RoomChoice } from './layout';

export const ROOM_STORAGE_KEY = 'aquarium.room';

export type RoomStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface StorageEventSource {
  addEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
  removeEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
}

/**
 * The player's room choice, kept in local storage. `subscribe` and `snapshot` have the shape
 * React's `useSyncExternalStore` takes, so the settings screen can bind to them directly.
 */
export class RoomPreference {
  private current: RoomChoice;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: RoomStorage | null,
    private readonly events: StorageEventSource | null = browserStorageEvents(),
  ) {
    this.current = this.read();
    this.events?.addEventListener('storage', this.onStorage);
  }

  /** Stops following other tabs and drops every subscriber. */
  dispose(): void {
    this.events?.removeEventListener('storage', this.onStorage);
    this.listeners.clear();
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

  private readonly onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== this.storage) return;
    // A null key means the whole store was cleared.
    if (event.key !== null && event.key !== ROOM_STORAGE_KEY) return;
    const next = this.read();
    if (next === this.current) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  };

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

export function browserStorageEvents(): StorageEventSource | null {
  return typeof window === 'undefined' ? null : window;
}
