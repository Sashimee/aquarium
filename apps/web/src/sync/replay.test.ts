import type { CareEvent } from '@aquarium/shared';
import { describe, expect, it, vi } from 'vitest';
import { FISH_1, FISH_2, TANK_A, speciesFixture } from './fixtures';
import { speciesNameMap } from './life';
import {
  describeEvent,
  loadTimeline,
  offsetLabel,
  orderEvents,
  replayFailureText,
  scrubTo,
  startPlayback,
  tickPlayback,
  togglePlayback,
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
    expect(replay).toHaveBeenNthCalledWith(1, TANK_A, { since: SINCE, limit: 500 });
    expect(replay).toHaveBeenNthCalledWith(2, TANK_A, { since: SINCE, limit: 500, cursor: 'c1' });
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

describe('playback', () => {
  it('reveals one event per tick and stops at the end', () => {
    let s = startPlayback(2, false);
    expect(s).toEqual({ shown: 0, playing: true });
    s = tickPlayback(s, 2);
    expect(s).toEqual({ shown: 1, playing: true });
    s = tickPlayback(s, 2);
    expect(s).toEqual({ shown: 2, playing: false });
    expect(tickPlayback(s, 2)).toBe(s);
  });

  it('does not play an empty timeline', () => {
    expect(startPlayback(0, false)).toEqual({ shown: 0, playing: false });
  });

  it('shows everything at once under reduced motion', () => {
    expect(startPlayback(5, true)).toEqual({ shown: 5, playing: false });
  });

  it('scrubbing pauses and clamps', () => {
    expect(scrubTo(4, 99)).toEqual({ shown: 4, playing: false });
    expect(scrubTo(4, -3)).toEqual({ shown: 0, playing: false });
    expect(scrubTo(4, 2.4)).toEqual({ shown: 2, playing: false });
  });

  it('toggle restarts from the top after the end', () => {
    expect(togglePlayback({ shown: 4, playing: false }, 4)).toEqual({ shown: 0, playing: true });
    expect(togglePlayback({ shown: 1, playing: true }, 4)).toEqual({ shown: 1, playing: false });
    expect(togglePlayback({ shown: 1, playing: false }, 4)).toEqual({ shown: 1, playing: true });
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
