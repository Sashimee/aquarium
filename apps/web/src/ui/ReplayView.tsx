import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AwaySummary, Tank } from '@aquarium/shared';
import {
  REPLAY_SPEEDS,
  describeEvent,
  fishNamesFor,
  offsetLabel,
  type ReplayLine,
  type ReplaySpeed,
} from '../sync/replay';
import { isTouchFirstDevice } from '../engine/displayPreference';
import { ReplayController } from '../sync/replayController';
import { replayModeFor, type ReplayMode } from '../sync/replayPlayback';
import { useApi, useBridge, useEngineReady } from './context';
import { useSpeciesNames } from './session';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export type ReplayPanelLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; lines: ReplayLine[]; truncated: boolean };

export interface ReplayPanelProps {
  load: ReplayPanelLoad;
  since: string;
  playback: { shown: number; playing: boolean; mode: ReplayMode };
  speed: ReplaySpeed;
  onSkip(): void;
  onToggle(): void;
  onScrub(shown: number): void;
  onScrubEnd(): void;
  onSpeed(speed: ReplaySpeed): void;
  onRetry(): void;
}

export function ReplayPanel(props: ReplayPanelProps) {
  const { load, since, playback, speed } = props;
  return (
    <section className="panel replay" aria-label="Away replay">
      <h3>What happened while you were away</h3>
      {load.status === 'loading' && <p role="status">Loading the replay...</p>}
      {load.status === 'error' && (
        <>
          <p role="alert">{load.message}</p>
          <button type="button" onClick={props.onRetry}>
            Try again
          </button>
        </>
      )}
      {load.status === 'ready' && load.lines.length === 0 && (
        <p>Nothing happened that is worth replaying. A quiet stretch.</p>
      )}
      {load.status === 'ready' && load.lines.length > 0 && (
        <>
          <p className="hint">
            {playback.mode === 'simulate'
              ? 'The tank runs fast-forward between events.'
              : 'The tank fades between snapshots of each event.'}
          </p>
          <ol className="replay-list" aria-label="Captions" aria-live="polite">
            {load.lines.slice(0, playback.shown).map((line) => (
              <li key={line.id} className={`replay-${line.tone}`}>
                <span className="hint">{offsetLabel(since, line.at)}</span> {line.text}
              </li>
            ))}
          </ol>
          {load.truncated && <p className="hint">Only the first part of the story is shown.</p>}
          <div className="row">
            <button type="button" onClick={props.onToggle}>
              {playback.playing ? 'Pause' : playback.shown >= load.lines.length ? 'Replay' : 'Play'}
            </button>
            {REPLAY_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={s === speed}
                onClick={() => props.onSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
          <label>
            Scrub the replay
            <input
              type="range"
              min={0}
              max={load.lines.length}
              value={playback.shown}
              aria-valuetext={`${playback.shown} of ${load.lines.length} events`}
              onChange={(e) => props.onScrub(Number(e.currentTarget.value))}
              onPointerUp={props.onScrubEnd}
              onPointerCancel={props.onScrubEnd}
              onKeyUp={props.onScrubEnd}
              onBlur={props.onScrubEnd}
            />
          </label>
        </>
      )}
      <div className="row">
        <button type="button" onClick={props.onSkip}>
          Skip replay
        </button>
      </div>
    </section>
  );
}

export function ReplayView({
  tank,
  away,
  since,
  onSkip,
}: {
  tank: Tank;
  away: AwaySummary;
  since: string;
  onSkip(): void;
}) {
  const api = useApi();
  const { interaction } = useBridge();
  const ready = useEngineReady();
  // Fixed for the replay: a tier change mid-watch must not refetch or restart it.
  const [mode] = useState(() => replayModeFor(ready?.tier ?? 'medium', isTouchFirstDevice()));
  const latestTank = useRef(tank);
  latestTank.current = tank;
  const [controller, setController] = useState<ReplayController | null>(null);

  useEffect(() => {
    const next = new ReplayController({
      api,
      interaction,
      tank: latestTank.current,
      since,
      mode,
      reducedMotion: prefersReducedMotion(),
      timers: {
        setInterval: (cb, ms) => window.setInterval(cb, ms),
        clearInterval: (handle) => window.clearInterval(handle as number),
      },
      online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      now: () => Date.now(),
    });
    setController(next);
    return () => {
      next.dispose();
      setController(null);
    };
  }, [api, interaction, mode, tank.id, since]);

  useEffect(() => {
    controller?.setTank(tank);
  }, [controller, tank]);

  if (!controller) return null;
  return (
    <ReplayBody controller={controller} tank={tank} away={away} since={since} onSkip={onSkip} />
  );
}

function ReplayBody({
  controller,
  tank,
  away,
  since,
  onSkip,
}: {
  controller: ReplayController;
  tank: Tank;
  away: AwaySummary;
  since: string;
  onSkip(): void;
}) {
  const names = useSpeciesNames();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const fishNames = useMemo(() => fishNamesFor(tank.fish, away), [tank.fish, away]);
  const events = state.load.status === 'ready' ? state.load.events : null;
  const lines = useMemo(
    () => events?.map((e) => describeEvent(e, fishNames, names)) ?? null,
    [events, fishNames, names],
  );
  const load: ReplayPanelLoad =
    state.load.status === 'ready'
      ? { status: 'ready', lines: lines ?? [], truncated: state.load.truncated }
      : state.load;

  return (
    <div
      className="replay-bar"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onSkip();
      }}
    >
      <div className={`replay-veil${state.playback.veiled ? ' on' : ''}`} aria-hidden="true" />
      <ReplayPanel
        load={load}
        since={since}
        playback={state.playback}
        speed={state.speed}
        onSkip={onSkip}
        onToggle={() => controller.toggle()}
        onScrub={(shown) => controller.previewScrub(shown)}
        onScrubEnd={() => controller.commitScrub()}
        onSpeed={(speed) => controller.setSpeed(speed)}
        onRetry={() => controller.retry()}
      />
    </div>
  );
}
