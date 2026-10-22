import type { RoomLight, LitRoom } from '../engine/room';
import type { Tier } from '../engine/quality/tiers';
import { minuteOfDay } from '../engine/daylight';
import type { RoomChoice } from '../scene/room/layout';

export interface RoomLightBinding {
  readonly preference: {
    snapshot(): RoomChoice;
    subscribe(listener: () => void): () => void;
  };
  readonly backdrop: LitRoom;
  /** Makes a light for the tank whose seed `seed` is. */
  create(seed: number): RoomLight;
  readonly seed: {
    current(): number;
    subscribe(listener: () => void): () => void;
  };
  tier(): Tier;
  hood(): number;
  /** Pinned `?clock=` in minutes after midnight, or null for the wall clock. */
  clock(): number | null;
  now(): number;
  onFrame(callback: () => void): () => void;
}

export interface RoomLightHandle {
  readonly light: RoomLight | null;
  setTier(tier: Tier): void;
  dispose(): void;
}

/**
 * Keeps a `RoomLight` for as long as a room is chosen: made when one is shown, disposed when the
 * choice goes back to none, and fed the clock and the weather every frame.
 */
export function bindRoomLight(binding: RoomLightBinding): RoomLightHandle {
  let light: RoomLight | null = null;

  const mount = (): void => {
    light = binding.create(binding.seed.current());
    light.setTier(binding.tier());
    light.attach(binding.backdrop);
  };

  const sync = (): void => {
    const shown = binding.preference.snapshot() !== 'none';
    if (shown && !light) {
      mount();
    } else if (!shown && light) {
      light.dispose();
      light = null;
    }
  };
  sync();

  const rebuild = (): void => {
    if (!light) return;
    light.dispose();
    mount();
  };

  const stopPreference = binding.preference.subscribe(sync);
  const stopSeed = binding.seed.subscribe(rebuild);
  const stopFrames = binding.onFrame(() => {
    if (!light) return;
    const nowMs = binding.now();
    light.update({
      nowMs,
      minute: binding.clock() ?? minuteOfDay(new Date(nowMs)),
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
      stopSeed();
      stopFrames();
      light?.dispose();
      light = null;
    },
  };
}
