import type { CareEvent } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { FISH_1, FISH_2, TANK_A, fishFixture, speciesFixture } from './fixtures';
import { speciesNameMap } from './life';
import {
  describeEvent,
  fishNamesFor,
  loadTimeline,
  offsetLabel,
  orderEvents,
  replayFailureText,
} from './replay';

const names = speciesNameMap([speciesFixture()]);
const SINCE = '2026-10-18T10:00:00.000Z';

function ev(n: number, at: string, rest: object = {}): CareEvent {
  return {
    id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tankId: TANK_A,
    at,
    kind: 'water_change',
    payload: {},
    ...rest,
  } as CareEvent;
}

describe('orderEvents', () => {
  it('sorts by time then id and drops repeated ids', () => {
    const a = ev(2, '2026-10-18T11:00:00.000Z');
    const b = ev(1, '2026-10-18T11:00:00.000Z');
    const c = ev(3, '2026-10-18T10:30:00.000Z');
    expect(orderEvents([a, b, c, a]).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
  });
});

describe('loadTimeline', () => {
  it('follows the cursor until the last page and keeps order', async () => {
    const e1 = ev(1, '2026-10-18T11:00:00.000Z');
    const e2 = ev(2, '2026-10-18T12:00:00.000Z');
    const e3 = ev(3, '2026-10-18T13:00:00.000Z');
    const replay = vi
      .fn()
      .mockResolvedValueOnce({ events: [e2, e1], nextCursor: 'c1' })
      .mockResolvedValueOnce({ events: [e3], nextCursor: null });
    const tl = await loadTimeline({ replay }, TANK_A, SINCE);
    expect(tl.events).toEqual([e1, e2, e3]);
    expect(tl.truncated).toBe(false);
    expect(replay).toHaveBeenNthCalledWith(1, TANK_A, { since: SINCE, limit: 500 }, undefined);
    expect(replay).toHaveBeenNthCalledWith(
      2,
      TANK_A,
      { since: SINCE, limit: 500, cursor: 'c1' },
      undefined,
    );
  });

  it('returns an empty timeline for an empty page', async () => {
    const replay = vi.fn().mockResolvedValue({ events: [], nextCursor: null });
    expect(await loadTimeline({ replay }, TANK_A, SINCE)).toEqual({ events: [], truncated: false });
  });

  it('stops at the page budget and says it is truncated', async () => {
    const replay = vi.fn().mockResolvedValue({ events: [ev(1, SINCE)], nextCursor: 'more' });
    const tl = await loadTimeline({ replay }, TANK_A, SINCE, { maxPages: 3 });
    expect(replay).toHaveBeenCalledTimes(3);
    expect(tl.truncated).toBe(true);
  });

  it('pins until and hands the abort signal to every request', async () => {
    const replay = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev(1, SINCE)], nextCursor: 'c1' })
      .mockResolvedValueOnce({ events: [], nextCursor: null });
    const ctl = new AbortController();
    const until = '2026-10-18T14:00:00.000Z';
    await loadTimeline({ replay }, TANK_A, SINCE, { until, signal: ctl.signal });
    for (const call of replay.mock.calls) {
      expect(call[1]).toMatchObject({ until });
      expect(call[2]).toBe(ctl.signal);
    }
  });

  it('propagates fetch errors', async () => {
    const replay = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(loadTimeline({ replay }, TANK_A, SINCE)).rejects.toThrow('boom');
  });

  it('does not fetch once aborted', async () => {
    const replay = vi.fn();
    const ctl = new AbortController();
    ctl.abort();
    await expect(loadTimeline({ replay }, TANK_A, SINCE, { signal: ctl.signal })).rejects.toThrow();
    expect(replay).not.toHaveBeenCalled();
  });
});

describe('describeEvent', () => {
  const fish = new Map([[FISH_1, 'Bubbles']]);

  it('names fish and causes', () => {
    const death = ev(1, SINCE, { kind: 'death', payload: { fishId: FISH_1, cause: 'starvation' } });
    expect(describeEvent(death, fish, names)).toMatchObject({
      text: 'Bubbles went too long without food.',
      tone: 'loss',
    });
    const born = ev(2, SINCE, {
      kind: 'born',
      payload: { fishId: FISH_2, parentId: FISH_1, species: 'neon-tetra' },
    });
    expect(describeEvent(born, fish, names).tone).toBe('good');
  });

  it('falls back for fish it does not know and covers water alerts', () => {
    const sick = ev(3, SINCE, { kind: 'sick', payload: { fishId: FISH_2 } });
    expect(describeEvent(sick, fish, names).text).toBe('A fish fell ill.');
    const alert = ev(4, SINCE, {
      kind: 'water_alert',
      payload: { metric: 'ammonia', state: 'high' },
    });
    expect(describeEvent(alert, fish, names)).toMatchObject({
      text: 'Ammonia rose too high.',
      tone: 'warn',
    });
  });

  it('describes a fish moved out of and into the tank', () => {
    const out = ev(5, SINCE, {
      kind: 'fish_moved',
      payload: { fishId: FISH_1, direction: 'out', otherTankId: TANK_A },
    });
    expect(describeEvent(out, fish, names)).toMatchObject({
      text: 'Bubbles was moved to another tank.',
      tone: 'calm',
    });
    const into = ev(6, SINCE, {
      kind: 'fish_moved',
      payload: { fishId: FISH_2, direction: 'in', otherTankId: TANK_A },
    });
    expect(describeEvent(into, fish, names).text).toBe('A fish was moved here from another tank.');
  });
});

describe('labels and failures', () => {
  it('labels the offset from the start of the absence', () => {
    expect(offsetLabel(SINCE, '2026-10-18T10:00:20.000Z')).toBe('right away');
    expect(offsetLabel(SINCE, '2026-10-18T13:00:00.000Z')).toBe('3 hours in');
  });

  it('explains offline, network and unknown failures', () => {
    expect(replayFailureText(new Error('x'), false)).toContain('offline');
    expect(replayFailureText({ code: 'network' }, true)).toContain('connection');
    expect(replayFailureText({ code: 'rate_limited' }, true)).toContain('too often');
    expect(replayFailureText(new Error('x'), true)).toContain('could not be loaded');
  });
});

describe('fishNamesFor', () => {
  it('names fish that were netted after dying from the away summary, and prefers the tank', () => {
    const away = {
      elapsedMinutes: 600,
      capped: false,
      deaths: [
        {
          fishId: FISH_2,
          name: 'Gone',
          species: 'neon-tetra',
          cause: 'ammonia' as const,
          diedAt: SINCE,
        },
        {
          fishId: FISH_1,
          name: 'Old',
          species: 'neon-tetra',
          cause: 'ammonia' as const,
          diedAt: SINCE,
        },
      ],
    };
    const names = fishNamesFor([fishFixture(FISH_1, { name: 'Bubbles' })], away);
    expect(names.get(FISH_2)).toBe('Gone');
    expect(names.get(FISH_1)).toBe('Bubbles');
    expect(fishNamesFor([], undefined).size).toBe(0);
  });
});
