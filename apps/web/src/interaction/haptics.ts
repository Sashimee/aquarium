import type { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';

export const HAPTICS_STORAGE_KEY = 'aquarium.haptics';

const MIN_GAP_MS = 60;
const TAP_MIN_MS = 8;
const TAP_MAX_MS = 22;

export interface Vibrator {
  vibrate(pattern: number | number[]): boolean;
}

export interface HapticsDeps {
  /** `navigator`, or null where the Vibration API does not exist (iOS Safari). */
  vibrator: Vibrator | null;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  now(): number;
  /** Chrome ignores vibrate() before the first tap and logs an intervention. */
  userHasActivated(): boolean;
}

/** Feature detection only: no user-agent sniffing, so iOS simply has nothing to call. */
export function vibratorOf(nav: object | undefined): Vibrator | null {
  return nav && 'vibrate' in nav && typeof nav.vibrate === 'function' ? (nav as Vibrator) : null;
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserHapticsDeps(): HapticsDeps {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const activation = (
    nav as (Navigator & { userActivation?: { hasBeenActive: boolean } }) | undefined
  )?.userActivation;
  return {
    vibrator: vibratorOf(nav),
    storage: localStorageOrNull(),
    now: () => performance.now(),
    userHasActivated: () => activation?.hasBeenActive ?? true,
  };
}

export class Haptics {
  private on: boolean;
  private reduced = false;
  private lastMs = -Infinity;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: HapticsDeps) {
    this.on = this.read();
  }

  get supported(): boolean {
    return this.deps.vibrator !== null;
  }

  get enabled(): boolean {
    return this.on;
  }

  get reducedMotion(): boolean {
    return this.reduced;
  }

  /** What the settings screen shows: does the player's choice currently produce any buzz? */
  get active(): boolean {
    return this.supported && this.on && !this.reduced;
  }

  setEnabled(enabled: boolean): void {
    this.on = enabled;
    try {
      this.deps.storage?.setItem(HAPTICS_STORAGE_KEY, enabled ? 'on' : 'off');
    } catch {
      // Storage can be full or blocked; the choice then lasts for this session only.
    }
    this.changed();
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reduced) return;
    this.reduced = reduced;
    this.changed();
  }

  tap(intensity: number): void {
    const clamped = Math.min(1, Math.max(0, intensity));
    this.buzz(Math.round(TAP_MIN_MS + (TAP_MAX_MS - TAP_MIN_MS) * clamped));
  }

  feed(): void {
    this.buzz([10, 40, 10]);
  }

  catchFish(): void {
    this.buzz([30, 50, 60]);
  }

  attach(bus: EventBus<InteractionEvents>): () => void {
    const offs = [
      bus.on('glass:tapped', ({ intensity }) => this.tap(intensity)),
      bus.on('feed:dropped', () => this.feed()),
      bus.on('tank:fish-removed', ({ reason }) => {
        if (reason === 'netted') this.catchFish();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private buzz(pattern: number | number[]): void {
    if (!this.active || !this.deps.userHasActivated()) return;
    const now = this.deps.now();
    if (now - this.lastMs < MIN_GAP_MS) return;
    this.lastMs = now;
    this.deps.vibrator?.vibrate(pattern);
  }

  private read(): boolean {
    try {
      return this.deps.storage?.getItem(HAPTICS_STORAGE_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const haptics = new Haptics(browserHapticsDeps());
