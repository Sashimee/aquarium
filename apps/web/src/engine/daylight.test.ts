import { DEFAULT_EQUIPMENT } from '@aquarium/shared';
import { lampIsOn } from '@aquarium/sim/lifecycle';
import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from './events';
import {
  CLOCK_EASE_MS,
  ClockPin,
  DAYLIGHT_INTERVAL_MS,
  DAYLIGHT_UNSEEN_GAP_MS,
  DaylightAnnouncer,
  DaylightFeed,
  type DaylightChange,
  type PageVisibility,
  DEFAULT_LAMP_HOURS,
  DEFAULT_PHOTOPERIOD,
  daylightAt,
  lampPhotoperiod,
  localMinuteOfDay,
  minuteOfDay,
  parseClock,
} from './daylight';

const at = (h: number, m = 0): number => h * 60 + m;

describe('daylightAt', () => {
  it('is fully on at midday and fully off at midnight', () => {
    expect(daylightAt(at(13))).toBe(1);
    expect(daylightAt(at(0))).toBe(0);
    expect(daylightAt(at(4, 30))).toBe(0);
  });

  it('ramps up from lights-on and down to lights-off, half way at mid-ramp', () => {
    expect(daylightAt(at(8))).toBe(0);
    expect(daylightAt(at(8, 30))).toBeCloseTo(0.5, 6);
    expect(daylightAt(at(9))).toBe(1);
    expect(daylightAt(at(20))).toBe(1);
    expect(daylightAt(at(20, 30))).toBeCloseTo(0.5, 6);
    expect(daylightAt(at(21))).toBe(0);
  });

  it('rises monotonically through dawn', () => {
    let previous = -1;
    for (let m = at(8); m <= at(9); m += 5) {
      const level = daylightAt(m);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it('handles a photoperiod that spans midnight', () => {
    const period = { onAt: at(20), offAt: at(6), rampMinutes: 30 };
    expect(daylightAt(at(23), period)).toBe(1);
    expect(daylightAt(at(2), period)).toBe(1);
    expect(daylightAt(at(12), period)).toBe(0);
  });

  it('wraps minutes outside one day', () => {
    expect(daylightAt(at(13) + 24 * 60)).toBe(1);
    expect(daylightAt(-60)).toBe(0);
  });

  it('rejects broken input', () => {
    expect(() => daylightAt(Number.NaN)).toThrow(/finite/);
    expect(() => daylightAt(0, { ...DEFAULT_PHOTOPERIOD, rampMinutes: 0 })).toThrow(/rampMinutes/);
    expect(() => daylightAt(0, { onAt: 0, offAt: 10, rampMinutes: 30 })).toThrow(/shorter/);
  });
});

describe('parseClock', () => {
  it('reads HH:MM and the day/night shortcuts', () => {
    expect(parseClock('07:45')).toBe(at(7, 45));
    expect(parseClock('7:05')).toBe(at(7, 5));
    expect(parseClock('day')).toBe(at(13));
    expect(parseClock('night')).toBe(0);
    expect(daylightAt(parseClock('day'))).toBe(1);
    expect(daylightAt(parseClock('night'))).toBe(0);
  });

  it('rejects malformed or out-of-range times', () => {
    for (const bad of ['24:00', '12:60', 'noon', '1200', '']) {
      expect(() => parseClock(bad)).toThrow(/HH:MM, day or night/);
    }
  });
});

describe('minuteOfDay', () => {
  it('uses local time with seconds as a fraction', () => {
    expect(minuteOfDay(new Date(2026, 9, 13, 14, 30, 30))).toBeCloseTo(at(14, 30.5), 6);
  });
});

describe('lampPhotoperiod', () => {
  const DAY = Date.UTC(2026, 9, 21);
  const hoodAt = (ms: number, onHour: number, offHour: number) =>
    daylightAt(localMinuteOfDay(ms, 0), lampPhotoperiod({ onHour, offHour }));

  it('lights the hood exactly while the sim counts the lamp as on, for every schedule', () => {
    for (let onHour = 0; onHour < 24; onHour++) {
      for (let offHour = 0; offHour < 24; offHour++) {
        if (onHour === offHour) continue;
        for (let minute = 0; minute < 24 * 60; minute += 5) {
          const ms = DAY + minute * 60_000;
          const lit = hoodAt(ms, onHour, offHour) > 0;
          const on = lampIsOn(ms, 0, onHour, offHour);
          if (minute % 60 === 0) {
            if (lit) expect(on).toBe(true);
          } else {
            expect(lit).toBe(on);
          }
        }
      }
    }
  });

  it('follows a schedule across UTC midnight', () => {
    expect(hoodAt(DAY + 22 * 3_600_000, 14, 2)).toBe(1);
    expect(hoodAt(DAY + 30 * 60_000, 14, 2)).toBeGreaterThan(0);
    expect(hoodAt(DAY + 3 * 3_600_000, 14, 2)).toBe(0);
    expect(hoodAt(DAY + 10 * 3_600_000, 14, 2)).toBe(0);
  });

  it('reaches full light even when the lamp is on for one hour', () => {
    expect(hoodAt(DAY + 7.5 * 3_600_000, 7, 8)).toBeCloseTo(1, 9);
    expect(lampPhotoperiod({ onHour: 7, offHour: 8 }).rampMinutes).toBe(30);
    expect(lampPhotoperiod({ onHour: 8, offHour: 20 }).rampMinutes).toBe(60);
  });

  it('defaults to the default tank lamp', () => {
    expect(DEFAULT_LAMP_HOURS).toEqual({
      onHour: DEFAULT_EQUIPMENT.light.onHour,
      offHour: DEFAULT_EQUIPMENT.light.offHour,
    });
  });

  it('rejects hours the lamp schedule cannot hold', () => {
    for (const [onHour, offHour] of [
      [8, 8],
      [-1, 8],
      [8, 24],
      [7.5, 20],
      [Number.NaN, 2],
    ] as const) {
      expect(() => lampPhotoperiod({ onHour, offHour })).toThrow(RangeError);
    }
  });
});

describe('DaylightAnnouncer', () => {
  it('announces the first level settled and later visible changes unsettled', () => {
    const announcer = new DaylightAnnouncer();
    expect(announcer.next(1)).toEqual({ level: 1, settled: true });
    announcer.frame(16);
    expect(announcer.next(0)).toEqual({ level: 0, settled: false });
  });

  it('skips changes too small to announce, measured from the last announced level', () => {
    const announcer = new DaylightAnnouncer();
    announcer.next(0.5);
    expect(announcer.next(0.503)).toBeNull();
    expect(announcer.next(0.506)).toEqual({ level: 0.506, settled: false });
  });

  it('settles the first change after a frame gap longer than the limit, and only that one', () => {
    const announcer = new DaylightAnnouncer();
    announcer.next(1);
    announcer.frame(DAYLIGHT_UNSEEN_GAP_MS);
    expect(announcer.next(0.8)?.settled).toBe(false);
    announcer.frame(DAYLIGHT_UNSEEN_GAP_MS + 1);
    expect(announcer.next(0.2)).toEqual({ level: 0.2, settled: true });
    announcer.frame(16);
    expect(announcer.next(1)?.settled).toBe(false);
  });

  it('forgets a gap that brought no change worth announcing', () => {
    const announcer = new DaylightAnnouncer();
    announcer.next(1);
    announcer.frame(60_000);
    expect(announcer.next(1)).toBeNull();
    expect(announcer.next(0)?.settled).toBe(false);
  });

  it('settles a change made while hidden, even across a gap shorter than the fallback', () => {
    const announcer = new DaylightAnnouncer();
    announcer.next(1);
    announcer.setHidden(true);
    announcer.frame(200);
    announcer.setHidden(false);
    announcer.frame(16);
    expect(announcer.next(0)).toEqual({ level: 0, settled: true });
    announcer.frame(16);
    expect(announcer.next(1)?.settled).toBe(false);
  });

  it('keeps settling while hidden frames still read the level', () => {
    const announcer = new DaylightAnnouncer();
    announcer.next(1);
    announcer.setHidden(true);
    expect(announcer.next(0.5)?.settled).toBe(true);
    expect(announcer.next(0.2)?.settled).toBe(true);
    announcer.setHidden(false);
    expect(announcer.next(0)?.settled).toBe(true);
    expect(announcer.next(1)?.settled).toBe(false);
  });

  it('does not settle a visible stall shorter than the fallback gap', () => {
    const announcer = new DaylightAnnouncer();
    announcer.next(1);
    announcer.frame(1500);
    expect(announcer.next(0)?.settled).toBe(false);
  });
});

class FakePage implements PageVisibility {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }
  get listening(): number {
    return this.listeners.size;
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

describe('DaylightFeed', () => {
  function feed(levels: { now: number }): { daylight: DaylightFeed; emitted: DaylightChange[] } {
    const emitted: DaylightChange[] = [];
    const bus = new EventBus<EngineEvents>();
    bus.on('engine:daylight', (change) => emitted.push(change));
    return { daylight: new DaylightFeed(() => levels.now, bus), emitted };
  }

  it('reads at most once per interval and emits each change, the first one settled', () => {
    const levels = { now: 1 };
    const { daylight, emitted } = feed(levels);
    daylight.frame(0, 0);
    levels.now = 0;
    daylight.frame(DAYLIGHT_INTERVAL_MS - 1, 16);
    expect(daylight.level).toBe(1);
    daylight.frame(DAYLIGHT_INTERVAL_MS, 16);
    expect(emitted).toEqual([
      { level: 1, settled: true },
      { level: 0, settled: false },
    ]);
    expect(daylight.level).toBe(0);
  });

  it('reads again on the next frame after a recheck', () => {
    const levels = { now: 1 };
    const { daylight, emitted } = feed(levels);
    daylight.frame(0, 0);
    levels.now = 0.4;
    daylight.recheck();
    daylight.frame(16, 16);
    expect(emitted.at(-1)).toEqual({ level: 0.4, settled: false });
  });

  it('settles a change made during a frame gap past the fallback, read on the frame after it', () => {
    const levels = { now: 1 };
    const { daylight, emitted } = feed(levels);
    daylight.frame(0, 0);
    levels.now = 0;
    const back = DAYLIGHT_UNSEEN_GAP_MS + 1;
    daylight.frame(back, back);
    expect(emitted.at(-1)).toEqual({ level: 0, settled: true });
    levels.now = 1;
    daylight.frame(back + DAYLIGHT_INTERVAL_MS, 16);
    expect(emitted.at(-1)).toEqual({ level: 1, settled: false });
  });

  it('settles a change made while the watched page was hidden, until it stops watching', () => {
    const levels = { now: 1 };
    const { daylight, emitted } = feed(levels);
    const page = new FakePage();
    const stop = daylight.watch(page);
    daylight.frame(0, 0);
    page.set(true);
    levels.now = 0;
    page.set(false);
    daylight.frame(DAYLIGHT_INTERVAL_MS, 16);
    expect(emitted.at(-1)).toEqual({ level: 0, settled: true });

    stop();
    expect(page.listening).toBe(0);
    page.set(true);
    levels.now = 1;
    daylight.frame(2 * DAYLIGHT_INTERVAL_MS, 16);
    expect(emitted.at(-1)).toEqual({ level: 1, settled: false });
  });

  it('reads on the first frame after the page shows again, not an interval later', () => {
    const levels = { now: 1 };
    const { daylight, emitted } = feed(levels);
    const page = new FakePage();
    daylight.watch(page);
    daylight.frame(0, 0);
    page.set(true);
    levels.now = 0;
    page.set(false);
    daylight.frame(16, 16);
    expect(emitted.at(-1)).toEqual({ level: 0, settled: true });
    levels.now = 1;
    daylight.frame(32, 16);
    expect(emitted).toHaveLength(2);
  });

  it('settles from the start when the page is already hidden', () => {
    const levels = { now: 1 };
    const { daylight, emitted } = feed(levels);
    daylight.frame(0, 0);
    const page = new FakePage();
    page.hidden = true;
    daylight.watch(page);
    levels.now = 0;
    daylight.frame(DAYLIGHT_INTERVAL_MS, 16);
    expect(emitted.at(-1)).toEqual({ level: 0, settled: true });
  });
});

describe('ClockPin', () => {
  const day = { hood: 1, room: 1 };
  const night = { hood: 0, room: 0 };

  it('shows the target at once on the first read', () => {
    const pin = new ClockPin(null);
    expect(pin.blend(night, 0)).toEqual(night);
    expect(pin.easing).toBe(false);
  });

  it('fades from the shown level to a newly pinned clock instead of cutting', () => {
    const pin = new ClockPin(null);
    pin.blend(day, 0);
    expect(pin.set(0, 1000)).toBe(true);
    expect(pin.clock).toBe(0);
    expect(pin.easing).toBe(true);
    expect(pin.blend(night, 1000)).toEqual(day);
    const mid = pin.blend(night, 1000 + CLOCK_EASE_MS / 2);
    expect(mid.hood).toBeCloseTo(0.5);
    expect(mid.room).toBeCloseTo(0.5);
    expect(pin.easing).toBe(true);
    expect(pin.blend(night, 1000 + CLOCK_EASE_MS)).toEqual(night);
    expect(pin.easing).toBe(false);
  });

  it('fades back up when returning to the live clock', () => {
    const pin = new ClockPin(0);
    pin.blend(night, 0);
    pin.set(null, 500);
    const quarter = pin.blend(day, 500 + CLOCK_EASE_MS / 4);
    expect(quarter.hood).toBeGreaterThan(0);
    expect(quarter.hood).toBeLessThan(0.5);
    expect(pin.blend(day, 500 + CLOCK_EASE_MS)).toEqual(day);
  });

  it('restarts from the partly faded level when switched mid-fade', () => {
    const pin = new ClockPin(null);
    pin.blend(day, 0);
    pin.set(0, 0);
    const partway = pin.blend(night, CLOCK_EASE_MS / 2);
    pin.set(13 * 60, CLOCK_EASE_MS / 2);
    expect(pin.blend(day, CLOCK_EASE_MS / 2)).toEqual(partway);
  });

  it('ignores setting the clock it already has', () => {
    const pin = new ClockPin(0);
    pin.blend(night, 0);
    expect(pin.set(0, 10)).toBe(false);
    expect(pin.easing).toBe(false);
  });
});
