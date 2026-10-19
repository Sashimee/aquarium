import { mulberry32 } from '../../scene/placement';

export const WEATHER_STATES = ['clear', 'cloudy', 'rain'] as const;
export type WeatherState = (typeof WEATHER_STATES)[number];

export interface Weather {
  /** The state on show; during a change it flips half way through the blend. */
  readonly state: WeatherState;
  /** Cloud cover, 0 = clear sky .. 1 = overcast. */
  readonly cloud: number;
  /** 0 = dry .. 1 = steady rain. */
  readonly rain: number;
}

/** Weather holds for a slot of UTC time, so the schedule ignores time zones and daylight saving. */
export const WEATHER_SLOT_MS = 3 * 60 * 60 * 1000;
/** The end of each slot blends into the next slot's weather. */
export const WEATHER_BLEND_MS = 40 * 60 * 1000;

const LOOK: Readonly<Record<WeatherState, { cloud: number; rain: number }>> = {
  clear: { cloud: 0.12, rain: 0 },
  cloudy: { cloud: 0.72, rain: 0 },
  rain: { cloud: 1, rain: 1 },
};

/** Share of slots in each state, roughly a temperate climate's. */
const ODDS: readonly (readonly [WeatherState, number])[] = [
  ['clear', 0.5],
  ['cloudy', 0.32],
  ['rain', 0.18],
];

function slotState(seed: number, slot: number): WeatherState {
  const roll = mulberry32((seed ^ Math.imul(slot | 0, 0x9e3779b1)) >>> 0)();
  let below = 0;
  for (const [state, share] of ODDS) {
    below += share;
    if (roll < below) return state;
  }
  return 'clear';
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** The window's weather at epoch time `nowMs` for a tank's `seed`; the same inputs give the same sky. */
export function weatherAt(nowMs: number, seed: number): Weather {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`weatherAt: time must be finite, got ${nowMs}`);
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`weatherAt: seed must be a safe integer, got ${seed}`);
  }
  const slot = Math.floor(nowMs / WEATHER_SLOT_MS);
  const into = nowMs - slot * WEATHER_SLOT_MS;
  const from = slotState(seed, slot);
  const to = slotState(seed, slot + 1);
  const t = smoothstep((into - (WEATHER_SLOT_MS - WEATHER_BLEND_MS)) / WEATHER_BLEND_MS);
  const a = LOOK[from];
  const b = LOOK[to];
  return {
    state: t < 0.5 ? from : to,
    cloud: a.cloud + (b.cloud - a.cloud) * t,
    rain: a.rain + (b.rain - a.rain) * t,
  };
}
