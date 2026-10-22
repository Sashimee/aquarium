// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  reloadHasStarted,
  resetReloadStartedForTests,
  reloadForNewBuild,
  watchStalePreloads,
  type ReloadDeps,
} from './staleBuild';

function deps(initial: Record<string, string> = {}, now = 1_000_000) {
  const store = new Map(Object.entries(initial));
  const reload = vi.fn();
  const value: ReloadDeps = {
    storage: () => ({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    }),
    now: () => now,
    reload,
  };
  return { value, reload, store };
}

describe('reloadForNewBuild', () => {
  it('reloads once and records when', () => {
    const d = deps();
    expect(reloadForNewBuild(d.value)).toBe(true);
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect([...d.store.values()]).toEqual(['1000000']);
  });

  it('does not reload again inside the guard window', () => {
    const d = deps({ 'aquarium:stale-chunk-reload': String(1_000_000 - 5_000) });
    expect(reloadForNewBuild(d.value)).toBe(false);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('reloads again once the window has passed', () => {
    const d = deps({ 'aquarium:stale-chunk-reload': String(1_000_000 - 120_000) });
    expect(reloadForNewBuild(d.value)).toBe(true);
  });

  it('fails closed when storage throws', () => {
    const reload = vi.fn();
    const blocked: ReloadDeps = {
      storage: () => {
        throw new Error('denied');
      },
      now: () => 1,
      reload,
    };
    expect(reloadForNewBuild(blocked)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('fails closed when writing fails', () => {
    const reload = vi.fn();
    const full: ReloadDeps = {
      storage: () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      }),
      now: () => 1,
      reload,
    };
    expect(reloadForNewBuild(full)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('reloadHasStarted', () => {
  it('is false until a reload is started, then true', () => {
    resetReloadStartedForTests();
    expect(reloadHasStarted()).toBe(false);
    reloadForNewBuild(deps({ 'aquarium:stale-chunk-reload': '999000' }).value);
    expect(reloadHasStarted()).toBe(false);
    reloadForNewBuild(deps().value);
    expect(reloadHasStarted()).toBe(true);
    resetReloadStartedForTests();
  });

  it('stays false when the reload call throws', () => {
    resetReloadStartedForTests();
    const throwing = deps();
    throwing.value.reload = () => {
      throw new Error('blocked');
    };
    expect(reloadForNewBuild(throwing.value)).toBe(false);
    expect(reloadHasStarted()).toBe(false);
  });
});

describe('watchStalePreloads', () => {
  it('reloads on vite:preloadError once, and stops when disposed', () => {
    const d = deps();
    const stop = watchStalePreloads(d.value);
    window.dispatchEvent(new Event('vite:preloadError'));
    window.dispatchEvent(new Event('vite:preloadError'));
    expect(d.reload).toHaveBeenCalledTimes(1);
    stop();
    const later = deps();
    const stopLater = watchStalePreloads(later.value);
    stopLater();
    window.dispatchEvent(new Event('vite:preloadError'));
    expect(later.reload).not.toHaveBeenCalled();
  });
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/a.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/a.css',
  ])('recognises %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('x is undefined'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});
