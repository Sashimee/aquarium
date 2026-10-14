import type { Engine } from './Engine';
import { formatPending, formatReadout, readStats } from './statsReadout';

const EDGE = 'max(0.75rem, env(safe-area-inset-bottom))';
/** The Tank report sits in the same corner and grows upwards when opened. */
const STACK_ABOVE = '#ui .report';
const GAP_PX = 8;

/** The CSS `bottom` that keeps the readout `GAP_PX` above the report, or at the edge without it. */
export function stackedBottom(viewportHeight: number, reportTop: number | null): string {
  return reportTop === null ? EDGE : `${viewportHeight - reportTop + GAP_PX}px`;
}

/** On-device performance readout for `?stats=1`, loaded only when asked for. */
export function createStatsOverlay(engine: Engine, parent: HTMLElement): () => void {
  const box = document.createElement('pre');
  box.className = 'engine-stats';
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, {
    position: 'fixed',
    left: 'max(0.75rem, env(safe-area-inset-left))',
    bottom: EDGE,
    zIndex: '2',
    margin: '0',
    padding: '0.35rem 0.5rem',
    background: 'rgba(0, 0, 0, 0.6)',
    color: '#d8f5d0',
    font: '11px/1.35 ui-monospace, Menlo, monospace',
    whiteSpace: 'pre',
    borderRadius: '4px',
    pointerEvents: 'none',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  // Opening or closing the report resizes it between stats ticks.
  const resized = new ResizeObserver(() => place());
  let observed: Element | null = null;
  const place = () => {
    const below = document.querySelector(STACK_ABOVE);
    if (below !== observed) {
      if (observed !== null) resized.unobserve(observed);
      if (below !== null) resized.observe(below);
      observed = below;
    }
    box.style.bottom = stackedBottom(
      window.innerHeight,
      below === null ? null : below.getBoundingClientRect().top,
    );
  };
  box.textContent = formatPending({
    backend: engine.backend,
    tier: engine.quality.tier,
    adaptive: engine.quality.adaptive,
  });
  place();
  parent.appendChild(box);

  const off = engine.events.on('engine:stats', (stats) => {
    box.textContent = formatReadout(readStats(engine, stats, window.devicePixelRatio));
    place();
  });

  return () => {
    off();
    resized.disconnect();
    box.remove();
  };
}
