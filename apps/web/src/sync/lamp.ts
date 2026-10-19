import type { LightSchedule } from '@aquarium/shared';

const MINUTES_PER_DAY = 1440;

const wrap = (minutes: number): number =>
  ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

/** Minutes east of UTC right now, which `Date#getTimezoneOffset` reports with the opposite sign. */
export function localOffsetMinutes(at: Date): number {
  return -at.getTimezoneOffset();
}

/**
 * The server keeps whole UTC hours. A zone on a half hour (India, +5:30) cannot name every local
 * hour exactly, so a local hour rounds to the nearest UTC hour and the control shows the result.
 */
export function localHourToUtc(localHour: number, offsetMinutes: number): number {
  return Math.round(wrap(localHour * 60 - offsetMinutes) / 60) % 24;
}

export function utcHourToLocalMinutes(utcHour: number, offsetMinutes: number): number {
  return wrap(utcHour * 60 + offsetMinutes);
}

export function clockText(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function utcHourText(utcHour: number, offsetMinutes: number): string {
  return clockText(utcHourToLocalMinutes(utcHour, offsetMinutes));
}

export interface HourOption {
  utcHour: number;
  label: string;
}

/** Twenty-four choices in local clock order; each carries the UTC hour that is sent. */
export function hourOptions(offsetMinutes: number): HourOption[] {
  return Array.from({ length: 24 }, (_, localHour) => {
    const utcHour = localHourToUtc(localHour, offsetMinutes);
    return { utcHour, label: utcHourText(utcHour, offsetMinutes) };
  });
}

/** A lamp that switches on at 22 and off at 06 runs through midnight and lights 8 hours. */
export function lightHours(onHour: number, offHour: number): number {
  return (offHour - onHour + 24) % 24;
}

export type LampCheck = { ok: true; schedule: LightSchedule } | { ok: false; reason: string };

export function checkLamp(schedule: LightSchedule): LampCheck {
  if (schedule.onHour === schedule.offHour) {
    return { ok: false, reason: 'Choose different on and off times, or the lamp has no day.' };
  }
  return { ok: true, schedule };
}

export function lampSummary(schedule: LightSchedule, offsetMinutes: number): string {
  const hours = lightHours(schedule.onHour, schedule.offHour);
  return `On at ${utcHourText(schedule.onHour, offsetMinutes)}, off at ${utcHourText(schedule.offHour, offsetMinutes)} your time: ${hours} hours of light.`;
}
