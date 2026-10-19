import type { Tier } from '../engine/quality/tiers';
import { REPLAY_STEP_MS, type ReplaySpeed } from './replay';

/** PLAN §9.2: simulate on high and mid, crossfade between event snapshots on low and mobile. */
export type ReplayMode = 'simulate' | 'crossfade';

export const FAST_FORWARD_SCALE = 20;

export function replayModeFor(tier: Tier, coarsePointer: boolean): ReplayMode {
  return tier === 'low' || coarsePointer ? 'crossfade' : 'simulate';
}

export interface PlaybackState {
  readonly mode: ReplayMode;
  readonly total: number;
  /** Events revealed and applied to the tank so far. */
  readonly shown: number;
  readonly playing: boolean;
  /** Crossfade only: the veil is down and the next tick swaps the snapshot. */
  readonly veiled: boolean;
  /** The tank on screen differs from the live one until a `restore`. */
  readonly dirty: boolean;
  readonly ended: boolean;
}

export type PlaybackAction =
  | { type: 'start'; reducedMotion: boolean }
  | { type: 'tick' }
  | { type: 'toggle' }
  | { type: 'scrub'; shown: number }
  | { type: 'end' };

export type PlaybackCommand =
  | { type: 'reset-roster'; shown: number }
  | { type: 'apply'; index: number }
  | { type: 'time-scale'; scale: number }
  | { type: 'restore' };

export interface PlaybackStep {
  state: PlaybackState;
  commands: PlaybackCommand[];
}

export function initialPlayback(mode: ReplayMode, total: number): PlaybackState {
  return { mode, total, shown: 0, playing: false, veiled: false, dirty: false, ended: false };
}

function scaleFor(state: PlaybackState): number {
  return state.mode === 'simulate' ? FAST_FORWARD_SCALE : 1;
}

function calm(): PlaybackCommand[] {
  return [{ type: 'time-scale', scale: 1 }];
}

function begin(state: PlaybackState): PlaybackStep {
  return {
    state: { ...state, shown: 0, playing: true, veiled: false, dirty: true },
    commands: [
      { type: 'reset-roster', shown: 0 },
      { type: 'time-scale', scale: scaleFor(state) },
    ],
  };
}

export function stepPlayback(state: PlaybackState, action: PlaybackAction): PlaybackStep {
  if (state.ended) return { state, commands: [] };
  switch (action.type) {
    case 'start':
      if (action.reducedMotion || state.total === 0) {
        return { state: { ...state, shown: state.total, playing: false }, commands: [] };
      }
      return begin(state);
    case 'tick': {
      if (!state.playing) return { state, commands: [] };
      if (state.mode === 'crossfade' && !state.veiled) {
        return { state: { ...state, veiled: true }, commands: [] };
      }
      const index = state.shown;
      const shown = index + 1;
      const commands: PlaybackCommand[] = [{ type: 'apply', index }];
      if (shown >= state.total) {
        commands.push({ type: 'time-scale', scale: 1 }, { type: 'restore' });
        return {
          state: { ...state, shown, playing: false, veiled: false, dirty: false },
          commands,
        };
      }
      return { state: { ...state, shown, veiled: false, dirty: true }, commands };
    }
    case 'toggle':
      if (state.playing) {
        return { state: { ...state, playing: false, veiled: false }, commands: calm() };
      }
      if (state.total === 0) return { state, commands: [] };
      if (state.shown >= state.total) return begin(state);
      return {
        state: { ...state, playing: true },
        commands: [{ type: 'time-scale', scale: scaleFor(state) }],
      };
    case 'scrub': {
      const shown = Math.max(0, Math.min(state.total, Math.round(action.shown)));
      return {
        state: { ...state, shown, playing: false, veiled: false, dirty: true },
        commands: [...calm(), { type: 'reset-roster', shown }],
      };
    }
    case 'end': {
      const commands = calm();
      if (state.dirty) commands.push({ type: 'restore' });
      return {
        state: { ...state, playing: false, veiled: false, dirty: false, ended: true },
        commands,
      };
    }
  }
}

/** How often to send `tick`; a crossfade step is two ticks, fade out then swap. */
export function tickIntervalMs(mode: ReplayMode, speed: ReplaySpeed): number {
  const dwell = REPLAY_STEP_MS / speed;
  return mode === 'crossfade' ? dwell / 2 : dwell;
}
