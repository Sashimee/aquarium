const KEY = 'aquarium:stale-chunk-reload';
const WINDOW_MS = 60_000;

let started = false;

/** True once this page has asked the browser to reload; a reloaded page starts false again. */
export function reloadHasStarted(): boolean {
  return started;
}

export function resetReloadStartedForTests(): void {
  started = false;
}

export interface ReloadDeps {
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  now: () => number;
  reload: () => void;
}

const browser: ReloadDeps = {
  storage: () => window.sessionStorage,
  now: () => Date.now(),
  reload: () => window.location.reload(),
};

const CHUNK_ERROR =
  /dynamically imported module|importing a module script failed|unable to preload|failed to fetch dynamically/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

/** Reloads at most once per minute; any storage failure means no reload, so it cannot loop. */
export function reloadForNewBuild(deps: ReloadDeps = browser): boolean {
  try {
    const storage = deps.storage();
    const now = deps.now();
    const last = Number(storage.getItem(KEY));
    if (Number.isFinite(last) && last > 0 && now - last < WINDOW_MS) return false;
    storage.setItem(KEY, String(now));
    deps.reload();
    started = true;
    return true;
  } catch {
    return false;
  }
}

export function watchStalePreloads(deps: ReloadDeps = browser): () => void {
  const onError = () => {
    reloadForNewBuild(deps);
  };
  window.addEventListener('vite:preloadError', onError);
  return () => window.removeEventListener('vite:preloadError', onError);
}
