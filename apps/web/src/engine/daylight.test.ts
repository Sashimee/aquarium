import { describe, expect, it } from 'vitest';
import { DEFAULT_PHOTOPERIOD, daylightAt, minuteOfDay, parseClock } from './daylight';

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
