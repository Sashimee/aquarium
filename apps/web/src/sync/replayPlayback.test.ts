import { describe, expect, it } from 'vitest';
import {
  FAST_FORWARD_SCALE,
  initialPlayback,
  replayModeFor,
  stepPlayback,
  tickIntervalMs,
  type PlaybackAction,
  type PlaybackCommand,
  type PlaybackState,
  type ReplayMode,
} from './replayPlayback';

function run(
  mode: ReplayMode,
  total: number,
  actions: PlaybackAction[],
): { state: PlaybackState; commands: PlaybackCommand[] } {
  let state = initialPlayback(mode, total);
  const commands: PlaybackCommand[] = [];
  for (const action of actions) {
    const step = stepPlayback(state, action);
    state = step.state;
    commands.push(...step.commands);
  }
  return { state, commands };
}

const start: PlaybackAction = { type: 'start', reducedMotion: false };
const tick: PlaybackAction = { type: 'tick' };

describe('replayModeFor', () => {
  it('simulates on mid and high desktops and crossfades on low and on touch devices', () => {
    expect(replayModeFor('medium', false)).toBe('simulate');
    expect(replayModeFor('high', false)).toBe('simulate');
    expect(replayModeFor('ultra', false)).toBe('simulate');
    expect(replayModeFor('low', false)).toBe('crossfade');
    expect(replayModeFor('high', true)).toBe('crossfade');
  });
});

describe('simulate playback', () => {
  it('rewinds the roster, runs 20x, then applies one event per tick in order', () => {
    const { state, commands } = run('simulate', 3, [start, tick, tick]);
    expect(commands).toEqual([
      { type: 'reset-roster', shown: 0 },
      { type: 'time-scale', scale: FAST_FORWARD_SCALE },
      { type: 'apply', index: 0 },
      { type: 'apply', index: 1 },
    ]);
    expect(state).toMatchObject({ shown: 2, playing: true, dirty: true });
  });

  it('returns to real time and restores the live tank when it reaches the end', () => {
    const { state, commands } = run('simulate', 2, [start, tick, tick]);
    expect(commands.slice(-3)).toEqual([
      { type: 'apply', index: 1 },
      { type: 'time-scale', scale: 1 },
      { type: 'restore' },
    ]);
    expect(state).toMatchObject({ shown: 2, playing: false, dirty: false });
    expect(stepPlayback(state, tick).commands).toEqual([]);
  });

  it('pausing returns to real time and resuming fast-forwards again', () => {
    const { commands } = run('simulate', 3, [start, tick, { type: 'toggle' }, { type: 'toggle' }]);
    expect(commands.slice(-2)).toEqual([
      { type: 'time-scale', scale: 1 },
      { type: 'time-scale', scale: FAST_FORWARD_SCALE },
    ]);
  });

  it('plays again from the top after the end', () => {
    const { state, commands } = run('simulate', 1, [start, tick, { type: 'toggle' }]);
    expect(commands.slice(-2)).toEqual([
      { type: 'reset-roster', shown: 0 },
      { type: 'time-scale', scale: FAST_FORWARD_SCALE },
    ]);
    expect(state).toMatchObject({ shown: 0, playing: true });
  });
});

describe('crossfade playback', () => {
  it('never changes the sim speed and swaps a snapshot on every second tick', () => {
    const { state, commands } = run('crossfade', 3, [start, tick]);
    expect(state).toMatchObject({ shown: 0, veiled: true });
    expect(commands.filter((c) => c.type === 'time-scale' && c.scale !== 1)).toEqual([]);
    const next = stepPlayback(state, tick);
    expect(next.commands).toEqual([{ type: 'apply', index: 0 }]);
    expect(next.state).toMatchObject({ shown: 1, veiled: false });
  });

  it('lifts the veil when paused mid-fade', () => {
    const { state } = run('crossfade', 3, [start, tick, { type: 'toggle' }]);
    expect(state).toMatchObject({ veiled: false, playing: false, shown: 0 });
  });

  it('ticks twice as often as simulate for the same speed', () => {
    expect(tickIntervalMs('crossfade', 2)).toBe(tickIntervalMs('simulate', 2) / 2);
    expect(tickIntervalMs('simulate', 4)).toBe(tickIntervalMs('simulate', 1) / 4);
  });
});

describe('reduced motion and empty timelines', () => {
  it('shows everything at once without autoplay or touching the tank', () => {
    const { state, commands } = run('simulate', 5, [{ type: 'start', reducedMotion: true }]);
    expect(state).toMatchObject({ shown: 5, playing: false, dirty: false });
    expect(commands).toEqual([]);
  });

  it('does nothing for an empty timeline', () => {
    const { state, commands } = run('simulate', 0, [start, { type: 'toggle' }, tick]);
    expect(state).toMatchObject({ shown: 0, playing: false });
    expect(commands).toEqual([]);
  });
});

describe('scrub and end', () => {
  it('scrubbing pauses, clamps and rebuilds the roster at that point', () => {
    const { state, commands } = run('simulate', 4, [start, { type: 'scrub', shown: 99 }]);
    expect(state).toMatchObject({ shown: 4, playing: false });
    expect(commands.slice(-2)).toEqual([
      { type: 'time-scale', scale: 1 },
      { type: 'reset-roster', shown: 4 },
    ]);
    expect(run('simulate', 4, [start, { type: 'scrub', shown: -2 }]).state.shown).toBe(0);
  });

  it('previewing moves the position and pauses without touching the roster', () => {
    const { state, commands } = run('simulate', 4, [start, { type: 'preview', shown: 3 }]);
    expect(state).toMatchObject({ shown: 3, playing: false, dirty: true });
    expect(commands.slice(-1)).toEqual([{ type: 'time-scale', scale: 1 }]);
    expect(commands.filter((c) => c.type === 'reset-roster')).toHaveLength(1);
  });

  it('skip restores the live tank exactly once, and only if the tank was changed', () => {
    const skipped = run('simulate', 3, [start, tick, { type: 'end' }, { type: 'end' }]);
    expect(skipped.commands.filter((c) => c.type === 'restore')).toHaveLength(1);
    expect(skipped.commands.slice(-2)).toEqual([
      { type: 'time-scale', scale: 1 },
      { type: 'restore' },
    ]);
    expect(skipped.state).toMatchObject({ ended: true, dirty: false, playing: false });

    const untouched = run('simulate', 3, [{ type: 'start', reducedMotion: true }, { type: 'end' }]);
    expect(untouched.commands.filter((c) => c.type === 'restore')).toEqual([]);
  });

  it('ignores every action after the end', () => {
    const { state } = run('simulate', 3, [start, { type: 'end' }]);
    for (const action of [tick, start, { type: 'toggle' } as const]) {
      expect(stepPlayback(state, action)).toEqual({ state, commands: [] });
    }
  });
});
