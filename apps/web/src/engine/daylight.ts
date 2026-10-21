import { DEFAULT_EQUIPMENT, type LightSchedule } from '@aquarium/shared';

const MINUTES_PER_DAY = 24 * 60;

/** When the hood lights are on, in minutes after midnight on the tank's clock. */
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

/**
 * Minutes after midnight on the wall clock `utcOffsetMinutes` ahead of UTC, from epoch time alone.
 * The day is cut at UTC midnight shifted by the offset, as the lamp schedule cuts its UTC hours,
 * so a daylight-saving change reaches the result only through the offset the caller passes.
 */
export function localMinuteOfDay(nowMs: number, utcOffsetMinutes: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(utcOffsetMinutes)) {
    throw new RangeError(
      `localMinuteOfDay: time and offset must be finite, got ${nowMs} and ${utcOffsetMinutes}`,
    );
  }
  return wrapMinutes(nowMs / 60_000 + utcOffsetMinutes);
}

/** The lamp's on and off hours; the sim reads them as UTC hours (`lampIsOn`). */
export type LampHours = Pick<LightSchedule, 'onHour' | 'offHour'>;

export const DEFAULT_LAMP_HOURS: LampHours = {
  onHour: DEFAULT_EQUIPMENT.light.onHour,
  offHour: DEFAULT_EQUIPMENT.light.offHour,
};

const LAMP_RAMP_MINUTES = 60;

/**
 * The visible hood's photoperiod for a lamp schedule. The ramps sit inside the lamp's on hours, so
 * the hood shows light exactly while the sim counts the lamp as on.
 */
export function lampPhotoperiod(hours: LampHours): Photoperiod {
  const { onHour, offHour } = hours;
  const valid = (h: number) => Number.isInteger(h) && h >= 0 && h <= 23;
  if (!valid(onHour) || !valid(offHour) || onHour === offHour) {
    throw new RangeError(
      `lampPhotoperiod: need two different whole hours 0..23, got ${onHour} and ${offHour}`,
    );
  }
  const length = wrapMinutes((offHour - onHour) * 60);
  return {
    onAt: onHour * 60,
    offAt: offHour * 60,
    rampMinutes: Math.min(LAMP_RAMP_MINUTES, length / 2),
  };
}

/** Smallest daylight change worth announcing: about 20 s into a one-hour ramp. */
const DAYLIGHT_EPSILON = 0.005;
/**
 * Frames stop while the tab is hidden; a gap longer than this means the light may have moved
 * while nobody, fish included, was watching it change.
 */
export const DAYLIGHT_UNSEEN_GAP_MS = 1000;

/**
 * A new hood level. `settled` marks one that changed unseen (first level, or the first after a
 * hidden tab or a long stall), which the fish should take as already adapted to, not as a switch.
 */
export interface DaylightChange {
  readonly level: number;
  readonly settled: boolean;
}

/** Decides which daylight levels are worth announcing, and which of them arrive settled. */
export class DaylightAnnouncer {
  private announced: number | null = null;
  private unseen = false;

  /** Every frame, with the time since the previous one. */
  frame(gapMs: number): void {
    if (gapMs > DAYLIGHT_UNSEEN_GAP_MS) this.unseen = true;
  }

  next(level: number): DaylightChange | null {
    const unseen = this.unseen;
    this.unseen = false;
    if (this.announced !== null && Math.abs(level - this.announced) < DAYLIGHT_EPSILON) return null;
    const settled = unseen || this.announced === null;
    this.announced = level;
    return { level, settled };
  }
}
