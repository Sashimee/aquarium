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
 * How long a switch between a pinned and the live clock takes to fade the lights. Any faster and
 * the fish's eye cannot adapt (`NIGHT.lightAdaptTauS`), so every press would startle them.
 */
export const CLOCK_EASE_MS = 20_000;

/**
 * What the tank's clock is pinned to: minutes after midnight, the middle of the lamp's on period
 * (`'day'`) or of its off period (`'night'`), or `null` to follow local time.
 */
export type ClockSetting = number | 'day' | 'night' | null;

export function assertClockSetting(setting: ClockSetting): void {
  if (setting === null || setting === 'day' || setting === 'night') return;
  if (!(Number.isFinite(setting) && setting >= 0 && setting < MINUTES_PER_DAY)) {
    throw new RangeError(
      `clock must be null, 'day', 'night' or a minute in [0, ${MINUTES_PER_DAY}), got ${String(setting)}`,
    );
  }
}

/** The minute the hood is scored at, or null for the live clock. */
export function hoodMinute(setting: ClockSetting, period: Photoperiod): number | null {
  if (setting === 'day' || setting === 'night') {
    const length = wrapMinutes(period.offAt - period.onAt);
    const start = setting === 'day' ? period.onAt : period.offAt;
    const span = setting === 'day' ? length : MINUTES_PER_DAY - length;
    return wrapMinutes(start + span / 2);
  }
  return setting;
}

/** The minute the room's sun is read at, which ignores the lamp: noon-ish or midnight. */
export function roomMinute(setting: ClockSetting): number | null {
  if (setting === 'day') return 13 * 60;
  if (setting === 'night') return 0;
  return setting;
}

/** The hood and room light levels, 0 = night .. 1 = midday. */
export interface LightLevels {
  readonly hood: number;
  readonly room: number;
}

/**
 * The clock the tank is pinned to, `null` following local time. Changing it fades the light from
 * what was last shown to what the new clock gives, rather than cutting.
 */
export class ClockPin {
  private from: LightLevels | null = null;
  private startedAt = 0;
  private shown: LightLevels = { hood: 1, room: 1 };
  private minuteFrom: number | null = null;
  private shownMinute: number | null = null;
  private lastArc: number | null = null;

  constructor(private pinned: ClockSetting) {}

  get clock(): ClockSetting {
    return this.pinned;
  }

  /** Whether a fade is still running, so the level wants reading every frame. */
  get easing(): boolean {
    return this.from !== null;
  }

  /** Returns whether the clock changed. */
  set(clock: ClockSetting, nowMs: number): boolean {
    if (clock === this.pinned) return false;
    this.pinned = clock;
    this.from = this.shown;
    this.startedAt = nowMs;
    this.minuteFrom = this.shownMinute;
    this.lastArc = null;
    return true;
  }

  /**
   * The minute the room's sky is read at: the sun runs the shorter way round from the minute last
   * shown to `target` over the same smoothstep as `blend`, so the sky and the tank light stay in
   * step and a small correction never spins the sky through a whole day.
   */
  blendMinute(target: number, nowMs: number): number {
    const from = this.minuteFrom;
    const t = (nowMs - this.startedAt) / CLOCK_EASE_MS;
    if (from === null || !(t < 1)) {
      this.minuteFrom = null;
      this.lastArc = null;
      this.shownMinute = target;
    } else {
      const forward = wrapMinutes(target - from);
      // A live target drifts while the fade runs; staying on the side nearest the last arc keeps the
      // sun from flipping across 12 h away or from spinning a whole day when the target passes `from`.
      const other = forward - MINUTES_PER_DAY;
      const arc =
        this.lastArc === null
          ? forward <= MINUTES_PER_DAY / 2
            ? forward
            : other
          : Math.abs(forward - this.lastArc) <= Math.abs(other - this.lastArc)
            ? forward
            : other;
      this.lastArc = arc;
      this.shownMinute = wrapMinutes(from + arc * smoothstep(t));
    }
    return this.shownMinute;
  }

  blend(target: LightLevels, nowMs: number): LightLevels {
    const from = this.from;
    const t = (nowMs - this.startedAt) / CLOCK_EASE_MS;
    if (from === null || !(t < 1)) {
      this.from = null;
      this.shown = target;
    } else {
      const k = smoothstep(t);
      this.shown = {
        hood: from.hood + (target.hood - from.hood) * k,
        room: from.room + (target.room - from.room) * k,
      };
    }
    return this.shown;
  }
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

/** The lamp's hours and its strength setting, 0..1, as the Shop sets them. */
export type LampSchedule = Pick<LightSchedule, 'intensity' | 'onHour' | 'offHour'>;

export const DEFAULT_LAMP_SCHEDULE: LampSchedule = {
  ...DEFAULT_LAMP_HOURS,
  intensity: DEFAULT_EQUIPMENT.light.intensity,
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
/** How often the hood level is read; a ramp moves less than one announce step in this time. */
export const DAYLIGHT_INTERVAL_MS = 1000;
/**
 * The fallback for a page that stopped drawing without reporting itself hidden, as a sleeping
 * laptop may: a frame gap this long means the light may have moved while nobody, fish included,
 * was watching it change. Long enough that a visible stall, such as a pipeline rebuild, never
 * counts.
 */
export const DAYLIGHT_UNSEEN_GAP_MS = 5000;

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
  private hidden = false;

  /** Every frame, with the time since the previous one. */
  frame(gapMs: number): void {
    if (gapMs > DAYLIGHT_UNSEEN_GAP_MS) this.unseen = true;
  }

  /**
   * Whether the page is hidden. Every change from hiding until the first read once shown again
   * is settled, even when a hidden page still draws the odd frame.
   */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.unseen = true;
  }

  next(level: number): DaylightChange | null {
    const unseen = this.unseen;
    if (!this.hidden) this.unseen = false;
    if (this.announced !== null && Math.abs(level - this.announced) < DAYLIGHT_EPSILON) return null;
    const settled = unseen || this.announced === null;
    this.announced = level;
    return { level, settled };
  }
}

/** The page visibility `document` reports. */
export interface PageVisibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** The engine's event bus, as far as the hood light needs it. */
export interface DaylightEvents {
  emit(type: 'engine:daylight', change: DaylightChange): void;
}

/**
 * The frame loop's side of the hood light: reads the level at most once per interval and emits
 * `engine:daylight` for each change worth announcing, settled when nobody could have watched it.
 */
export class DaylightFeed {
  private readonly announcer = new DaylightAnnouncer();
  private checkedAt = -Infinity;
  private current = 1;

  constructor(
    private readonly read: () => number,
    private readonly events: DaylightEvents,
  ) {}

  /** The last announced level, full day before the first. */
  get level(): number {
    return this.current;
  }

  /** Reads the level again on the next frame, as after a lamp schedule change. */
  recheck(): void {
    this.checkedAt = -Infinity;
  }

  /** Every frame, with its time and the time since the previous one. */
  frame(nowMs: number, gapMs: number): void {
    this.announcer.frame(gapMs);
    if (nowMs - this.checkedAt < DAYLIGHT_INTERVAL_MS) return;
    this.checkedAt = nowMs;
    const change = this.announcer.next(this.read());
    if (change === null) return;
    this.current = change.level;
    this.events.emit('engine:daylight', change);
  }

  /** Follows whether `page` is hidden until the returned stop is called. */
  watch(page: PageVisibility): () => void {
    // Reading on the first frame back keeps a change made just after showing from passing as unseen.
    const update = (): void => {
      this.announcer.setHidden(page.hidden);
      if (!page.hidden) this.recheck();
    };
    update();
    page.addEventListener('visibilitychange', update);
    return () => page.removeEventListener('visibilitychange', update);
  }
}
