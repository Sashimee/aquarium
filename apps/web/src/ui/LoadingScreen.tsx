import { useEffect, useRef, useState } from 'react';
import type { LoadState } from '../interaction/events';
import { useLoadState } from './context';

/** A load that finishes sooner than this never shows the screen. */
export const SHOW_AFTER_MS = 150;
export const FADE_MS = 420;

export type LoadingPhase = 'hidden' | 'shown' | 'leaving';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function useLoadingPhase(load: LoadState | null): LoadingPhase {
  const [phase, setPhase] = useState<LoadingPhase>('hidden');
  const wanted = load !== null && load.active;
  const failed = load?.error != null;

  useEffect(() => {
    if (wanted) {
      setPhase((current) => (current === 'leaving' ? 'shown' : current));
      const timer = window.setTimeout(() => setPhase('shown'), failed ? 0 : SHOW_AFTER_MS);
      return () => window.clearTimeout(timer);
    }
    setPhase((current) => {
      if (current !== 'shown') return current;
      return prefersReducedMotion() ? 'hidden' : 'leaving';
    });
    return undefined;
  }, [wanted, failed]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = window.setTimeout(() => setPhase('hidden'), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return phase;
}

export function LoadingScreen() {
  const load = useLoadState();
  const phase = useLoadingPhase(load);
  const retry = useRef<HTMLButtonElement>(null);
  const failed = load?.error != null;

  useEffect(() => {
    if (phase === 'shown' && failed) retry.current?.focus();
  }, [phase, failed]);

  if (load === null || phase === 'hidden') return null;

  const percent = Math.round(load.progress * 100);
  const noun = load.reason === 'boot' ? 'the aquarium' : 'the tank';

  return (
    <div className={phase === 'leaving' ? 'loading leaving' : 'loading'} aria-busy={!failed}>
      <div className="loading-card">
        <div className="loading-mark" aria-hidden="true">
          <svg viewBox="0 0 64 40" focusable="false">
            <path
              className="loading-fish"
              d="M4 20c9-12 22-14 34-8 5 2 9 5 12 8-3 3-7 6-12 8-12 6-25 4-34-8zm46 0 10-9v18z"
            />
            <circle className="loading-eye" cx="16" cy="18" r="2" />
          </svg>
          <i className="loading-bubble" />
          <i className="loading-bubble" />
          <i className="loading-bubble" />
        </div>
        <h2 className="loading-title">{failed ? 'Could not load' : `Loading ${noun}`}</h2>
        {failed ? (
          <>
            <p className="loading-error" role="alert">
              {load.error}
            </p>
            <button
              ref={retry}
              type="button"
              className="primary"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <div
              className="loading-bar"
              role="progressbar"
              aria-label={`Loading ${noun}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${load.stage}, ${percent} percent`}
            >
              <span style={{ transform: `scaleX(${load.progress})` }} />
            </div>
            <p className="loading-stage" role="status">
              {load.stage}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
