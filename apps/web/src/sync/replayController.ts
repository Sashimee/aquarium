import type { CareEvent, Tank } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { loadTimeline, replayFailureText, type ReplayApi, type ReplaySpeed } from './replay';
import { createReplayDirector, type ReplayDirector } from './replayDirector';
import {
  initialPlayback,
  stepPlayback,
  tickIntervalMs,
  type PlaybackAction,
  type PlaybackState,
  type ReplayMode,
} from './replayPlayback';

export type ReplayLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; events: readonly CareEvent[]; truncated: boolean };

export interface ReplaySnapshot {
  load: ReplayLoad;
  playback: PlaybackState;
  speed: ReplaySpeed;
}

export interface ReplayTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ReplayControllerDeps {
  api: ReplayApi;
  interaction: Pick<EventBus<InteractionEvents>, 'emit' | 'on'>;
  tank: Tank;
  since: string;
  mode: ReplayMode;
  reducedMotion: boolean;
  timers: ReplayTimers;
  online(): boolean;
  now(): number;
}

/**
 * One away replay: loads the timeline once (again only on `retry`), plays it into the tank and
 * puts the live tank back on `skip`/`dispose`. Tank snapshots arriving meanwhile only update what
 * a restore will show; they never refetch or restart playback.
 */
export class ReplayController {
  private tank: Tank;
  private readonly until: string;
  private snapshot: ReplaySnapshot;
  private readonly listeners = new Set<() => void>();
  private director: ReplayDirector | null = null;
  private abort: AbortController | null = null;
  private timer: { handle: unknown; ms: number } | null = null;
  private disposed = false;
  private scrubPending = false;

  constructor(private readonly deps: ReplayControllerDeps) {
    this.tank = deps.tank;
    this.until = new Date(deps.now()).toISOString();
    this.snapshot = {
      load: { status: 'loading' },
      playback: initialPlayback(deps.mode, 0),
      speed: 2,
    };
    void this.load();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReplaySnapshot => this.snapshot;

  setTank(tank: Tank): void {
    this.tank = tank;
  }

  retry(): void {
    if (this.disposed || this.snapshot.load.status === 'ready') return;
    void this.load();
  }

  toggle(): void {
    this.commitScrub();
    this.dispatch({ type: 'toggle' });
  }

  /** Moves the captions and slider only; the tank follows on `commitScrub`, so a drag rebuilds it once. */
  previewScrub(shown: number): void {
    if (this.disposed || this.snapshot.load.status !== 'ready') return;
    this.scrubPending = true;
    this.dispatch({ type: 'preview', shown });
  }

  commitScrub(): void {
    if (!this.scrubPending) return;
    this.scrubPending = false;
    this.dispatch({ type: 'scrub', shown: this.snapshot.playback.shown });
  }

  scrub(shown: number): void {
    this.scrubPending = false;
    this.dispatch({ type: 'scrub', shown });
  }

  setSpeed(speed: ReplaySpeed): void {
    if (this.disposed) return;
    this.publish({ ...this.snapshot, speed });
    this.syncTimer();
  }

  /** Stops playback and puts the live tank back; safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.dispatch({ type: 'end' });
    this.director?.dispose();
    this.disposed = true;
    this.abort?.abort();
    this.listeners.clear();
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ ...this.snapshot, load: { status: 'loading' } });
    if (!this.deps.online()) {
      this.publish({
        ...this.snapshot,
        load: { status: 'error', message: replayFailureText(null, false) },
      });
      return;
    }
    try {
      const timeline = await loadTimeline(this.deps.api, this.tank.id, this.deps.since, {
        until: this.until,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      this.director = createReplayDirector({
        interaction: this.deps.interaction,
        getTank: () => this.tank,
        events: timeline.events,
      });
      this.snapshot = {
        ...this.snapshot,
        load: { status: 'ready', events: timeline.events, truncated: timeline.truncated },
        playback: initialPlayback(this.deps.mode, timeline.events.length),
      };
      this.dispatch({ type: 'start', reducedMotion: this.deps.reducedMotion });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.publish({
        ...this.snapshot,
        load: { status: 'error', message: replayFailureText(error, this.deps.online()) },
      });
    }
  }

  private dispatch(action: PlaybackAction): void {
    if (this.disposed || this.snapshot.load.status !== 'ready') return;
    const step = stepPlayback(this.snapshot.playback, action);
    this.director?.run(step.commands);
    this.publish({ ...this.snapshot, playback: step.state });
    this.syncTimer();
  }

  private syncTimer(): void {
    const { playback, speed } = this.snapshot;
    const wanted = playback.playing ? tickIntervalMs(playback.mode, speed) : null;
    if (this.timer !== null && this.timer.ms === wanted) return;
    if (this.timer !== null) this.deps.timers.clearInterval(this.timer.handle);
    this.timer = null;
    if (wanted === null) return;
    this.timer = {
      handle: this.deps.timers.setInterval(() => this.dispatch({ type: 'tick' }), wanted),
      ms: wanted,
    };
  }

  private publish(next: ReplaySnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
