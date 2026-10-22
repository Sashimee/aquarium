import { daylightAt, parseClock } from '../engine/daylight';

export type DayNightMode = 'auto' | 'day' | 'night';

export const DAY_NIGHT_KEY = 'aquarium.clock';

const ORDER: readonly DayNightMode[] = ['auto', 'day', 'night'];

export function nextMode(mode: DayNightMode): DayNightMode {
  return ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? 'auto';
}

/** The pinned clock `Engine.setClock` takes: null follows local time. */
export function clockFor(mode: DayNightMode): number | null {
  if (mode === 'auto') return null;
  return parseClock(mode);
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

export function initialMode(
  search: string,
  store: () => Storage | null = browserStorage,
): DayNightMode {
  const pinned = urlClock(search);
  if (pinned === null) return readMode(store);
  return daylightAt(pinned) >= 0.5 ? 'day' : 'night';
}

/** The clock to start the engine on when the URL has no usable `?clock=`. */
export function savedClock(
  search: string,
  store: () => Storage | null = browserStorage,
): number | null {
  return urlClock(search) === null ? clockFor(readMode(store)) : null;
}
