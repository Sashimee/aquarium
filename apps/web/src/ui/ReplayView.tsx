import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tank } from '@aquarium/shared';
import {
  REPLAY_SPEEDS,
  describeEvent,
  loadTimeline,
  offsetLabel,
  replayFailureText,
  scrubTo,
  startPlayback,
  stepIntervalMs,
  tickPlayback,
  togglePlayback,
  type PlaybackState,
  type ReplayLine,
  type ReplaySpeed,
  type Timeline,
} from '../sync/replay';
import { useApi } from './context';
import { useSpeciesNames } from './session';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export type ReplayLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; lines: ReplayLine[]; truncated: boolean };

export interface ReplayPanelProps {
  load: ReplayLoad;
  since: string;
  playback: PlaybackState;
  speed: ReplaySpeed;
  onSkip(): void;
  onToggle(): void;
  onScrub(shown: number): void;
  onSpeed(speed: ReplaySpeed): void;
  onRetry(): void;
}

export function ReplayPanel(props: ReplayPanelProps) {
  const { load, since, playback, speed } = props;
  return (
    <section className="replay" aria-label="Away replay">
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
          <ol className="replay-list" aria-live="off">
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

export function ReplayView({ tank, since, onSkip }: { tank: Tank; since: string; onSkip(): void }) {
  const api = useApi();
  const names = useSpeciesNames();
  const [load, setLoad] = useState<ReplayLoad>({ status: 'loading' });
  const [playback, setPlayback] = useState<PlaybackState>({ shown: 0, playing: false });
  const [speed, setSpeed] = useState<ReplaySpeed>(2);
  const [attempt, setAttempt] = useState(0);
  const fishNames = useMemo(() => new Map(tank.fish.map((f) => [f.id, f.name])), [tank.fish]);
  const total = load.status === 'ready' ? load.lines.length : 0;
  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ status: 'loading' });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setLoad({ status: 'error', message: replayFailureText(null, false) });
      return () => ctl.abort();
    }
    loadTimeline(api, tank.id, since, { signal: ctl.signal }).then(
      (tl: Timeline) => {
        if (ctl.signal.aborted) return;
        const lines = tl.events.map((e) => describeEvent(e, fishNames, names));
        setLoad({ status: 'ready', lines, truncated: tl.truncated });
        setPlayback(startPlayback(lines.length, prefersReducedMotion()));
      },
      (error: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ status: 'error', message: replayFailureText(error, true) });
      },
    );
    return () => ctl.abort();
  }, [api, tank.id, since, attempt, fishNames, names]);

  useEffect(() => {
    if (!playback.playing) return;
    const timer = window.setInterval(
      () => setPlayback((s) => tickPlayback(s, totalRef.current)),
      stepIntervalMs(speed),
    );
    return () => window.clearInterval(timer);
  }, [playback.playing, speed]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return (
    <ReplayPanel
      load={load}
      since={since}
      playback={playback}
      speed={speed}
      onSkip={onSkip}
      onToggle={() => setPlayback((s) => togglePlayback(s, total))}
      onScrub={(shown) => setPlayback(scrubTo(total, shown))}
      onSpeed={setSpeed}
      onRetry={retry}
    />
  );
}
