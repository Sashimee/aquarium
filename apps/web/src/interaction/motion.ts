const QUERY = '(prefers-reduced-motion: reduce)';

export interface MotionSource {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (e: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (e: { matches: boolean }) => void): void;
}

/** Calls back immediately with the current preference and again whenever it changes. */
export function watchReducedMotion(
  onChange: (reduced: boolean) => void,
  source: MotionSource | null = typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia(QUERY)
    : null,
): () => void {
  if (!source) {
    onChange(false);
    return () => undefined;
  }
  const listener = (e: { matches: boolean }) => onChange(e.matches);
  source.addEventListener('change', listener);
  onChange(source.matches);
  return () => source.removeEventListener('change', listener);
}
