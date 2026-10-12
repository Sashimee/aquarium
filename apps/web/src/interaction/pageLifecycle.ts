export interface PageEventTarget {
  addEventListener(type: 'pagehide', listener: (event: { persisted: boolean }) => void): void;
  removeEventListener(type: 'pagehide', listener: (event: { persisted: boolean }) => void): void;
}

/**
 * Runs `teardown` when the page is really going away. A persisted pagehide means the browser is
 * parking the page in the back/forward cache and may restore it, so everything must stay alive.
 */
export function onPageTeardown(target: PageEventTarget, teardown: () => void): () => void {
  const listener = (event: { persisted: boolean }) => {
    if (!event.persisted) teardown();
  };
  target.addEventListener('pagehide', listener);
  return () => target.removeEventListener('pagehide', listener);
}
