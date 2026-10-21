import { describe, expect, it } from 'vitest';
import {
  checkLamp,
  clockText,
  hourOptions,
  lampSummary,
  lightHours,
  localHourToUtc,
  localOffsetMinutes,
  utcHourToLocalMinutes,
  utcHourText,
} from './lamp';

const LUXEMBOURG_SUMMER = 120;
const LUXEMBOURG_WINTER = 60;
const NEW_YORK = -300;
const INDIA = 330;

describe('local and UTC hours', () => {
  it('reads the offset east of UTC from the Date', () => {
    const at = new Date('2026-07-01T12:00:00Z');
    expect(localOffsetMinutes(at)).toBe(-at.getTimezoneOffset());
  });

  it('converts local hours to UTC in whole-hour zones', () => {
    expect(localHourToUtc(8, LUXEMBOURG_SUMMER)).toBe(6);
    expect(localHourToUtc(20, LUXEMBOURG_SUMMER)).toBe(18);
    expect(localHourToUtc(8, LUXEMBOURG_WINTER)).toBe(7);
    expect(localHourToUtc(8, 0)).toBe(8);
  });

  it('wraps across midnight in both directions', () => {
    expect(localHourToUtc(1, LUXEMBOURG_SUMMER)).toBe(23);
    expect(localHourToUtc(22, NEW_YORK)).toBe(3);
    expect(utcHourToLocalMinutes(23, LUXEMBOURG_SUMMER)).toBe(60);
    expect(utcHourToLocalMinutes(3, NEW_YORK)).toBe(22 * 60);
  });

  it('round-trips every hour in whole-hour zones', () => {
    for (const offset of [LUXEMBOURG_SUMMER, NEW_YORK, 0, 540, -720]) {
      for (let local = 0; local < 24; local++) {
        const utc = localHourToUtc(local, offset);
        expect(utcHourToLocalMinutes(utc, offset)).toBe(local * 60);
      }
    }
  });

  it('rounds to the nearest UTC hour in a half-hour zone and shows the result', () => {
    expect(localHourToUtc(8, INDIA)).toBe(3);
    expect(utcHourText(3, INDIA)).toBe('08:30');
    const labels = hourOptions(INDIA).map((o) => o.label);
    expect(new Set(labels).size).toBe(24);
  });

  it('formats clock times with two digits', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(9 * 60 + 5)).toBe('09:05');
  });
});

describe('hourOptions', () => {
  it('lists local hours in clock order, each with the UTC hour that is sent', () => {
    const options = hourOptions(LUXEMBOURG_SUMMER);
    expect(options).toHaveLength(24);
    expect(options[0]).toEqual({ utcHour: 22, label: '00:00' });
    expect(options[8]).toEqual({ utcHour: 6, label: '08:00' });
    expect(new Set(options.map((o) => o.utcHour)).size).toBe(24);
  });
});

describe('schedule', () => {
  it('counts the lit hours of a day schedule and of one that wraps midnight', () => {
    expect(lightHours(8, 20)).toBe(12);
    expect(lightHours(22, 6)).toBe(8);
    expect(lightHours(23, 0)).toBe(1);
  });

  it('describes a schedule that wraps midnight in local time', () => {
    const text = lampSummary({ intensity: 0.8, onHour: 20, offHour: 4 }, LUXEMBOURG_SUMMER);
    expect(text).toBe('On at 22:00, off at 06:00 your time: 8 hours of light.');
  });

  it('refuses equal on and off times and passes everything else', () => {
    expect(checkLamp({ intensity: 0.5, onHour: 7, offHour: 7 })).toMatchObject({ ok: false });
    const wrapped = { intensity: 0.5, onHour: 22, offHour: 6 };
    expect(checkLamp(wrapped)).toEqual({ ok: true, schedule: wrapped });
  });
});
