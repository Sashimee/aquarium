const MINUTES_PER_DAY = 24 * 60;

/** When the hood lights are on, in minutes after local midnight. */
export interface Photoperiod {
  readonly onAt: number;
  readonly offAt: number;
  /** Length of the dawn and dusk ramps. */
  readonly rampMinutes: number;
}

/** A 13 h planted-tank photoperiod with hour-long LED ramps either side. */
export const DEFAULT_PHOTOPERIOD: Photoperiod = { onAt: 8 * 60, offAt: 21 * 60, rampMinutes: 60 };

function wrapMinutes(minutes: number): number {
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** 0 = lights off (night) .. 1 = full day, with smooth dawn and dusk ramps. */
export function daylightAt(minuteOfDay: number, period: Photoperiod = DEFAULT_PHOTOPERIOD): number {
  if (!Number.isFinite(minuteOfDay)) {
    throw new RangeError(`daylightAt: minute of day must be finite, got ${minuteOfDay}`);
  }
  if (!(period.rampMinutes > 0)) throw new RangeError('daylightAt: rampMinutes must be > 0');
  const length = wrapMinutes(period.offAt - period.onAt);
  if (length < period.rampMinutes) {
    throw new RangeError('daylightAt: the photoperiod is shorter than one ramp');
  }
  const sinceOn = wrapMinutes(minuteOfDay - period.onAt);
  if (sinceOn > length) return 0;
  const ramp = period.rampMinutes;
  return smoothstep(sinceOn / ramp) * smoothstep((length - sinceOn) / ramp);
}

/**
 * Reads `?clock=HH:MM`, `?clock=day` or `?clock=night` into minutes after midnight, so a page can
 * be pinned to a time of day.
 */
export function parseClock(value: string): number {
  if (value === 'day') return 13 * 60;
  if (value === 'night') return 0;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!(hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60)) {
    throw new Error(`Unknown ?clock=${value}; use HH:MM, day or night`);
  }
  return hours * 60 + minutes;
}

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}
