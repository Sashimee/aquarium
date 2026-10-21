import type { RoomLight, LitRoom } from '../engine/room';
import type { Tier } from '../engine/quality/tiers';
import type { RoomChoice } from '../scene/room/layout';

export interface RoomLightBinding {
  readonly preference: {
    snapshot(): RoomChoice;
    subscribe(listener: () => void): () => void;
  };
  readonly backdrop: LitRoom;
  create(): RoomLight;
  tier(): Tier;
  hood(): number;
  /** Pinned `?clock=` in minutes after midnight, or null for the wall clock. */
  clock: number | null;
  now(): number;
  onFrame(callback: () => void): () => void;
}

export interface RoomLightHandle {
  readonly light: RoomLight | null;
  setTier(tier: Tier): void;
  dispose(): void;
}

export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * Keeps a `RoomLight` for as long as a room is chosen: made when one is shown, disposed when the
 * choice goes back to none, and fed the clock and the weather every frame.
 */
export function bindRoomLight(binding: RoomLightBinding): RoomLightHandle {
  let light: RoomLight | null = null;

  const sync = (): void => {
    const shown = binding.preference.snapshot() !== 'none';
    if (shown && !light) {
      light = binding.create();
      light.setTier(binding.tier());
      light.attach(binding.backdrop);
    } else if (!shown && light) {
      light.dispose();
      light = null;
    }
  };
  sync();

  const stopPreference = binding.preference.subscribe(sync);
  const stopFrames = binding.onFrame(() => {
    if (!light) return;
    const nowMs = binding.now();
    light.update({
      nowMs,
      minute: binding.clock ?? minutesOfDay(nowMs),
      hood: binding.hood(),
    });
  });

  return {
    get light() {
      return light;
    },
    setTier(tier) {
      light?.setTier(tier);
    },
    dispose() {
      stopPreference();
      stopFrames();
      light?.dispose();
      light = null;
    },
  };
}
