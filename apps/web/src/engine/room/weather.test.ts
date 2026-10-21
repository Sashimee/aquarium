import { describe, expect, it } from 'vitest';
import {
  WEATHER_BLEND_MS,
  WEATHER_SLOT_MS,
  WEATHER_STATES,
  weatherAt,
  type WeatherState,
} from './weather';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 19);

function census(seed: number, days: number): Record<WeatherState, number> {
  const counts: Record<WeatherState, number> = { clear: 0, cloudy: 0, rain: 0 };
  for (let t = START; t < START + days * DAY; t += WEATHER_SLOT_MS) {
    counts[weatherAt(t + 60_000, seed).state]++;
  }
  return counts;
}

describe('weatherAt', () => {
  it('gives the same weather for the same time and seed', () => {
    for (let t = START; t < START + 3 * DAY; t += 17 * 60_000) {
      expect(weatherAt(t, 42)).toEqual(weatherAt(t, 42));
    }
  });

  it('gives different tanks different weather', () => {
    const sky = (seed: number) =>
      Array.from({ length: 56 }, (_, i) => weatherAt(START + i * WEATHER_SLOT_MS, seed).state);
    expect(sky(1)).not.toEqual(sky(2));
  });

  it('shows every state over a season, clear most often and rain least', () => {
    const counts = census(7, 120);
    const slots = (120 * DAY) / WEATHER_SLOT_MS;
    for (const state of WEATHER_STATES) expect(counts[state]).toBeGreaterThan(0);
    expect(counts.clear / slots).toBeGreaterThan(0.4);
    expect(counts.clear / slots).toBeLessThan(0.6);
    expect(counts.rain / slots).toBeGreaterThan(0.1);
    expect(counts.rain / slots).toBeLessThan(0.26);
  });

  it('holds still through a slot until the blend into the next', () => {
    const slot = START + 5 * WEATHER_SLOT_MS;
    const held = weatherAt(slot, 3);
    for (let t = slot; t <= slot + WEATHER_SLOT_MS - WEATHER_BLEND_MS; t += 9 * 60_000) {
      expect(weatherAt(t, 3)).toEqual(held);
    }
  });

  it('moves continuously across a slot boundary', () => {
    for (let k = 0; k < 40; k++) {
      const boundary = START + k * WEATHER_SLOT_MS;
      const before = weatherAt(boundary - 1, 11);
      const after = weatherAt(boundary, 11);
      expect(Math.abs(before.cloud - after.cloud)).toBeLessThan(1e-6);
      expect(Math.abs(before.rain - after.rain)).toBeLessThan(1e-6);
    }
  });

  it('flips the state half way through the blend', () => {
    let checked = 0;
    for (let k = 0; k < 80 && checked < 3; k++) {
      const end = START + (k + 1) * WEATHER_SLOT_MS;
      const from = weatherAt(end - WEATHER_BLEND_MS, 5).state;
      const to = weatherAt(end, 5).state;
      if (from === to) continue;
      checked++;
      expect(weatherAt(end - WEATHER_BLEND_MS / 2 - 1000, 5).state).toBe(from);
      expect(weatherAt(end - WEATHER_BLEND_MS / 2 + 1000, 5).state).toBe(to);
    }
    expect(checked).toBe(3);
  });

  it('keeps each state to its look: rain is overcast and wet, clear is dry and open', () => {
    for (let t = START; t < START + 20 * DAY; t += WEATHER_SLOT_MS) {
      const w = weatherAt(t + 60_000, 9);
      if (w.state === 'rain') expect(w).toMatchObject({ cloud: 1, rain: 1 });
      if (w.state === 'clear') expect(w.cloud).toBeLessThan(0.2);
      if (w.state !== 'rain') expect(w.rain).toBe(0);
    }
  });

  it('cuts slots on UTC time, so a time zone never changes the sky', () => {
    expect(WEATHER_SLOT_MS * 8).toBe(DAY);
    expect(weatherAt(Date.UTC(2026, 2, 29, 0, 30), 4)).toEqual(
      weatherAt(Date.parse('2026-03-29T01:30:00+01:00'), 4),
    );
  });

  it('rejects a time that is not a number and a seed that is not an integer', () => {
    expect(() => weatherAt(Number.NaN, 1)).toThrow(RangeError);
    expect(() => weatherAt(0, 1.5)).toThrow(/safe integer/);
  });
});
