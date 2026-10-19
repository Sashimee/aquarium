import type { Weather } from './weather';

export type Rgb = readonly [number, number, number];
export type Direction = readonly [number, number, number];

const MINUTES_PER_DAY = 24 * 60;
/** A fixed equinox-like day: no location and no season (PLAN §9.1, window weather). */
export const SUNRISE_MINUTE = 6.5 * 60;
export const SUNSET_MINUTE = 19.5 * 60;
const NOON_ELEVATION_DEG = 50;
const MIDNIGHT_ELEVATION_DEG = -35;
/** The sun rises left of the window and sets right of it, seen from inside the room. */
const AZIMUTH_SWING_DEG = 140;

/** Direct sun on a surface square to it, in the hood's units (the hood is 4). */
const SUN_PEAK_IRRADIANCE = 9;

interface Key {
  readonly elevation: number;
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  readonly ambient: Rgb;
}

/**
 * Sky radiance at the top and bottom of the window and the room's ambient gain against its
 * daytime level, by solar elevation in degrees. Night keeps a faint city glow low in the sky.
 */
const SKY_KEYS: readonly Key[] = [
  {
    elevation: -18,
    zenith: [0.003, 0.004, 0.011],
    horizon: [0.02, 0.019, 0.026],
    ambient: [0.02, 0.022, 0.03],
  },
  {
    elevation: -8,
    zenith: [0.02, 0.03, 0.09],
    horizon: [0.14, 0.09, 0.11],
    ambient: [0.05, 0.05, 0.08],
  },
  {
    elevation: -2,
    zenith: [0.12, 0.16, 0.38],
    horizon: [0.95, 0.42, 0.2],
    ambient: [0.26, 0.2, 0.18],
  },
  {
    elevation: 4,
    zenith: [0.3, 0.42, 0.85],
    horizon: [1.55, 0.85, 0.45],
    ambient: [0.55, 0.45, 0.36],
  },
  {
    elevation: 18,
    zenith: [0.38, 0.62, 1.3],
    horizon: [1.3, 1.45, 1.6],
    ambient: [0.88, 0.88, 0.86],
  },
  {
    elevation: 45,
    zenith: [0.34, 0.6, 1.4],
    horizon: [1.4, 1.6, 1.85],
    ambient: [1, 1, 1],
  },
];

/** Sun colour by elevation: red through the long low path, near white above 25 degrees. */
const SUN_LOW: Rgb = [1, 0.5, 0.24];
const SUN_HIGH: Rgb = [1, 0.96, 0.9];

export interface Sun {
  /** Degrees above the horizon; negative at night. */
  readonly elevation: number;
  /** Degrees from straight out of the window, positive to the right. */
  readonly azimuth: number;
  /**
   * Unit vector from the room towards the sun in tank space: the window is in the back wall, so
   * its z is negative while the sun is up.
   */
  readonly toSun: Direction;
}

export interface RoomLightState {
  readonly sun: Sun;
  /** Linear radiance colour of direct sun on a surface square to it, weather included. */
  readonly sunRadiance: Rgb;
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  /** Colour of the cloud deck in the window, lit by the same sky. */
  readonly cloudColour: Rgb;
  /** Gain on the room's environment light. */
  readonly ambient: Rgb;
  readonly cloud: number;
  readonly rain: number;
}

function wrapMinutes(minutes: number): number {
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scaleRgb(a: Rgb, s: number): Rgb {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function luminance(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function minuteOrThrow(minute: number): number {
  if (!Number.isFinite(minute)) {
    throw new RangeError(`room light: minute of day must be finite, got ${minute}`);
  }
  return wrapMinutes(minute);
}

/** Where the sun is at `minute` after local midnight; any finite minute wraps onto the day. */
export function sunAt(minute: number): Sun {
  const sinceSunrise = wrapMinutes(minuteOrThrow(minute) - SUNRISE_MINUTE);
  const dayLength = SUNSET_MINUTE - SUNRISE_MINUTE;
  const deg = Math.PI / 180;
  let elevation: number;
  let progress: number;
  if (sinceSunrise <= dayLength) {
    progress = sinceSunrise / dayLength;
    elevation = NOON_ELEVATION_DEG * Math.sin(Math.PI * progress);
  } else {
    const night = (sinceSunrise - dayLength) / (MINUTES_PER_DAY - dayLength);
    progress = night < 0.5 ? 1 : 0;
    elevation = MIDNIGHT_ELEVATION_DEG * Math.sin(Math.PI * night);
  }
  const azimuth = (progress - 0.5) * AZIMUTH_SWING_DEG;
  const e = elevation * deg;
  const a = azimuth * deg;
  return {
    elevation,
    azimuth,
    toSun: [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)],
  };
}

function skyKeysAt(elevation: number): Omit<Key, 'elevation'> {
  const first = SKY_KEYS[0];
  const last = SKY_KEYS[SKY_KEYS.length - 1];
  if (!first || !last) throw new Error('room light: no sky keys');
  if (elevation <= first.elevation) return first;
  for (let i = 1; i < SKY_KEYS.length; i++) {
    const hi = SKY_KEYS[i];
    const lo = SKY_KEYS[i - 1];
    if (!hi || !lo || elevation > hi.elevation) continue;
    const t = smoothstep(lo.elevation, hi.elevation, elevation);
    return {
      zenith: mixRgb(lo.zenith, hi.zenith, t),
      horizon: mixRgb(lo.horizon, hi.horizon, t),
      ambient: mixRgb(lo.ambient, hi.ambient, t),
    };
  }
  return last;
}

const CLEAR: Weather = { state: 'clear', cloud: 0, rain: 0 };

/**
 * Sky, sun and room ambient at `minute` after local midnight under `weather`. Cloud dims the sun
 * far more than the sky; rain darkens both and greys the sky.
 */
export function roomLightAt(minute: number, weather: Weather = CLEAR): RoomLightState {
  const sun = sunAt(minute);
  const cloud = clamp01(weather.cloud);
  const rain = clamp01(weather.rain);
  const keys = skyKeysAt(sun.elevation);

  const warmth = smoothstep(25, 2, sun.elevation);
  const above = smoothstep(-0.5, 6, sun.elevation);
  const throughCloud = (1 - cloud) ** 1.5 * (1 - rain);
  const sunRadiance = scaleRgb(
    mixRgb(SUN_HIGH, SUN_LOW, warmth),
    SUN_PEAK_IRRADIANCE * above * throughCloud,
  );

  const grey = (c: Rgb): Rgb => {
    const y = luminance(c);
    return mixRgb(c, [y * 0.92, y * 0.97, y * 1.05], 0.8 * cloud);
  };
  const dimSky = 1 - 0.35 * cloud - 0.25 * rain;
  const zenith = scaleRgb(grey(keys.zenith), dimSky);
  const horizon = scaleRgb(grey(keys.horizon), dimSky);
  const deck = luminance(mixRgb(keys.horizon, keys.zenith, 0.35));
  const cloudColour = scaleRgb([deck * 0.95, deck * 0.97, deck], 1.05 - 0.45 * cloud - 0.3 * rain);
  const ambient = scaleRgb(keys.ambient, 1 - 0.3 * cloud - 0.15 * rain);

  return { sun, sunRadiance, zenith, horizon, cloudColour, ambient, cloud, rain };
}
