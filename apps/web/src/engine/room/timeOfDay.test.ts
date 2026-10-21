import { lampIsOn } from '@aquarium/sim/lifecycle';
import { describe, expect, it } from 'vitest';
import { localMinuteOfDay } from '../daylight';
import {
  roomDaylightAt,
  roomLightAt,
  sunAt,
  SUNRISE_MINUTE,
  SUNSET_MINUTE,
  type Rgb,
} from './timeOfDay';
import type { Weather } from './weather';

const at = (h: number, m = 0): number => h * 60 + m;
const sum = (c: Rgb): number => c[0] + c[1] + c[2];
const CLOUDY: Weather = { state: 'cloudy', cloud: 0.72, rain: 0 };
const RAIN: Weather = { state: 'rain', cloud: 1, rain: 1 };

describe('sunAt', () => {
  it('rises at sunrise, peaks at solar noon and sets at sunset', () => {
    expect(sunAt(SUNRISE_MINUTE).elevation).toBeCloseTo(0, 9);
    expect(sunAt(SUNSET_MINUTE).elevation).toBeCloseTo(0, 6);
    const noon = (SUNRISE_MINUTE + SUNSET_MINUTE) / 2;
    expect(sunAt(noon).elevation).toBeCloseTo(50, 6);
    expect(sunAt(noon).azimuth).toBeCloseTo(0, 6);
    expect(sunAt(noon - 60).elevation).toBeLessThan(50);
    expect(sunAt(noon + 60).elevation).toBeLessThan(50);
  });

  it('is below the horizon all night, lowest half way through it', () => {
    for (let m = SUNSET_MINUTE + 1; m < SUNRISE_MINUTE + 24 * 60; m += 7) {
      expect(sunAt(m).elevation).toBeLessThan(0);
    }
    const midnightish = (SUNSET_MINUTE + SUNRISE_MINUTE + 24 * 60) / 2;
    expect(sunAt(midnightish).elevation).toBeCloseTo(-35, 6);
  });

  it('wraps any finite minute onto the day', () => {
    expect(sunAt(at(24, 30))).toEqual(sunAt(at(0, 30)));
    expect(sunAt(-1)).toEqual(sunAt(at(23, 59)));
    expect(sunAt(at(24 * 3 + 9))).toEqual(sunAt(at(9)));
  });

  it('moves smoothly across midnight', () => {
    expect(Math.abs(sunAt(at(23, 59)).elevation - sunAt(at(0, 1)).elevation)).toBeLessThan(0.1);
  });

  it('shines in through the back wall, from the left in the morning and the right at evening', () => {
    for (const m of [at(8), at(13), at(18)]) {
      const [x, y, z] = sunAt(m).toSun;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
      expect(z).toBeLessThan(0);
      expect(y).toBeGreaterThan(0);
    }
    expect(sunAt(at(8)).toSun[0]).toBeLessThan(0);
    expect(sunAt(at(18)).toSun[0]).toBeGreaterThan(0);
  });

  it('rejects a time that is not a number', () => {
    expect(() => sunAt(Number.NaN)).toThrow(RangeError);
    expect(() => roomLightAt(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('roomLightAt', () => {
  it('is dark at midnight: no sun, a black sky and a dim room', () => {
    const night = roomLightAt(at(0));
    expect(night.sunRadiance).toEqual([0, 0, 0]);
    expect(Math.max(...night.zenith)).toBeLessThan(0.02);
    expect(Math.max(...night.ambient)).toBeLessThan(0.05);
  });

  it('is bright at midday with a blue zenith and full room light', () => {
    const day = roomLightAt(at(13));
    expect(day.zenith[2]).toBeGreaterThan(day.zenith[0]);
    expect(day.ambient).toEqual([1, 1, 1]);
    expect(sum(day.sunRadiance)).toBeGreaterThan(20);
  });

  it('turns the low sun and the horizon warm in the evening', () => {
    const evening = roomLightAt(SUNSET_MINUTE - 20);
    const noon = roomLightAt(at(13));
    const warmth = (c: Rgb) => c[0] / c[2];
    expect(warmth(evening.sunRadiance)).toBeGreaterThan(2 * warmth(noon.sunRadiance));
    expect(evening.horizon[0]).toBeGreaterThan(evening.horizon[2]);
    expect(sum(evening.ambient)).toBeLessThan(sum(noon.ambient));
    expect(sum(evening.ambient)).toBeGreaterThan(sum(roomLightAt(at(0)).ambient));
  });

  it('brightens monotonically through the morning', () => {
    let previous = -1;
    for (let m = at(4); m <= at(12); m += 10) {
      const level = sum(roomLightAt(m).ambient);
      expect(level).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = level;
    }
  });

  it('dims the sun far more than the room under cloud, and both further in rain', () => {
    const clear = roomLightAt(at(13));
    const cloudy = roomLightAt(at(13), CLOUDY);
    const rain = roomLightAt(at(13), RAIN);
    expect(sum(cloudy.sunRadiance) / sum(clear.sunRadiance)).toBeLessThan(0.25);
    expect(sum(cloudy.ambient) / sum(clear.ambient)).toBeGreaterThan(0.7);
    expect(rain.sunRadiance).toEqual([0, 0, 0]);
    expect(sum(rain.ambient)).toBeLessThan(sum(cloudy.ambient));
    expect(sum(rain.zenith)).toBeLessThan(sum(cloudy.zenith));
    expect(sum(rain.cloudColour)).toBeLessThan(sum(cloudy.cloudColour));
  });

  it('greys the sky under cloud', () => {
    const spread = (c: Rgb) => Math.max(...c) / Math.min(...c);
    expect(spread(roomLightAt(at(13), CLOUDY).zenith)).toBeLessThan(
      spread(roomLightAt(at(13)).zenith),
    );
  });

  it('passes the weather amounts through, clamped to 0..1', () => {
    const state = roomLightAt(at(13), { state: 'rain', cloud: 1.4, rain: -0.2 });
    expect(state.cloud).toBe(1);
    expect(state.rain).toBe(0);
  });
});

describe('localMinuteOfDay', () => {
  const instant = Date.UTC(2026, 9, 19, 22, 45, 30);

  it('reads UTC with no offset and shifts by whole offsets', () => {
    expect(localMinuteOfDay(instant, 0)).toBeCloseTo(at(22, 45.5), 9);
    expect(localMinuteOfDay(instant, 120)).toBeCloseTo(at(0, 45.5), 9);
    expect(localMinuteOfDay(instant, -300)).toBeCloseTo(at(17, 45.5), 9);
  });

  it('wraps past midnight both ways and before the epoch', () => {
    expect(localMinuteOfDay(Date.UTC(2026, 0, 1, 0, 0), -1)).toBeCloseTo(at(23, 59), 9);
    expect(localMinuteOfDay(Date.UTC(2026, 0, 1, 23, 59), 2)).toBeCloseTo(at(0, 1), 9);
    expect(localMinuteOfDay(-60_000, 0)).toBeCloseTo(at(23, 59), 9);
  });

  it('cuts the hours where the lamp schedule cuts them', () => {
    const start = Date.UTC(2026, 2, 28, 20, 0);
    for (let ms = start; ms < start + 2 * 86_400_000; ms += 7 * 60_000 + 13_000) {
      const hour = Math.floor(localMinuteOfDay(ms, 0) / 60);
      for (let on = 0; on < 24; on++) {
        expect(lampIsOn(ms, 0, on, (on + 1) % 24)).toBe(hour === on);
      }
    }
  });

  it('does not jump at a daylight-saving change: only the offset passed moves it', () => {
    const change = Date.UTC(2026, 2, 29, 1, 0);
    const before = localMinuteOfDay(change - 60_000, 60);
    const after = localMinuteOfDay(change + 60_000, 60);
    expect(after - before).toBeCloseTo(2, 9);
    expect(localMinuteOfDay(change + 60_000, 120) - after).toBeCloseTo(60, 9);
  });

  it('rejects a time or offset that is not a number', () => {
    expect(() => localMinuteOfDay(Number.NaN, 0)).toThrow(RangeError);
    expect(() => localMinuteOfDay(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('roomDaylightAt', () => {
  it('is full at midday, near zero at night and rises through the morning', () => {
    expect(roomDaylightAt(at(13))).toBe(1);
    expect(roomDaylightAt(at(0))).toBeLessThan(0.05);
    let last = roomDaylightAt(at(4));
    for (let minute = at(4); minute <= at(13); minute += 10) {
      const level = roomDaylightAt(minute);
      expect(level).toBeGreaterThanOrEqual(last - 1e-12);
      last = level;
    }
  });

  it('tracks the window sky on the same clock as the sun', () => {
    for (let minute = 0; minute < 24 * 60; minute += 30) {
      const { ambient } = roomLightAt(minute);
      const y = 0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2];
      expect(roomDaylightAt(minute)).toBeCloseTo(Math.min(1, y), 12);
    }
  });
});
