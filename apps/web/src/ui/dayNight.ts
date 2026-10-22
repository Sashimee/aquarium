import {
  DEFAULT_LAMP_SCHEDULE,
  daylightAt,
  lampPhotoperiod,
  parseClock,
  type ClockSetting,
  type LampSchedule,
} from '../engine/daylight';
import { parseEngineOptions, type EngineOptions } from '../engine/options';

export type DayNightMode = 'auto' | 'day' | 'night';

export const DAY_NIGHT_KEY = 'aquarium.clock';

const ORDER: readonly DayNightMode[] = ['auto', 'day', 'night'];

export function nextMode(mode: DayNightMode): DayNightMode {
  return ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? 'auto';
}

/** What `Engine.setClock` takes: null follows local time, and day and night follow the lamp. */
export function clockFor(mode: DayNightMode): ClockSetting {
  return mode === 'auto' ? null : mode;
}

function isMode(value: unknown): value is DayNightMode {
  return value === 'auto' || value === 'day' || value === 'night';
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readMode(store: () => Storage | null = browserStorage): DayNightMode {
  try {
    const value = store()?.getItem(DAY_NIGHT_KEY);
    return isMode(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Returns false when the choice could not be kept, so it lasts only for this page. */
export function writeMode(
  mode: DayNightMode,
  store: () => Storage | null = browserStorage,
): boolean {
  try {
    const target = store();
    if (!target) return false;
    target.setItem(DAY_NIGHT_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

/** A valid `?clock=` pins the page and beats the saved choice; an invalid one is ignored. */
function urlClock(search: string): number | null {
  const param = new URLSearchParams(search).get('clock');
  if (param === null) return null;
  try {
    return parseClock(param);
  } catch {
    return null;
  }
}

/** A pinned clock is labelled by the lamp, since that is the light the tank shows, not the sky behind it. */
export function initialMode(
  search: string,
  store: () => Storage | null = browserStorage,
  lamp: LampSchedule = DEFAULT_LAMP_SCHEDULE,
): DayNightMode {
  const pinned = urlClock(search);
  if (pinned === null) return readMode(store);
  return daylightAt(pinned, lampPhotoperiod(lamp)) >= 0.5 ? 'day' : 'night';
}

/** The engine options for this URL: its own `?clock=` if it has one, else the saved mode. Throws on a bad param. */
export function engineOptionsFor(
  search: string,
  store: () => Storage | null = browserStorage,
): EngineOptions {
  const options = parseEngineOptions(search);
  return { ...options, clock: options.clock ?? clockFor(readMode(store)) };
}
