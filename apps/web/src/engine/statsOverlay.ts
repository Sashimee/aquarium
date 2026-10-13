import type { Engine } from './Engine';
import { formatReadout, readStats } from './statsReadout';

/** On-device performance readout for `?stats=1`, loaded only when asked for. */
export function createStatsOverlay(engine: Engine, parent: HTMLElement): () => void {
  const box = document.createElement('pre');
  box.className = 'engine-stats';
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, {
    position: 'fixed',
    left: 'max(0.75rem, env(safe-area-inset-left))',
    bottom: 'calc(max(0.75rem, env(safe-area-inset-bottom)) + 3.75rem)',
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
  box.textContent = `${engine.backend}  ${engine.quality.tier}\nwaiting for frames`;
  parent.appendChild(box);

  const off = engine.events.on('engine:stats', (stats) => {
    box.textContent = formatReadout(readStats(engine, stats, window.devicePixelRatio));
  });

  return () => {
    off();
    box.remove();
  };
}
