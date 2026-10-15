import type { Biome } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { LoadTracker } from './loadTracker';

/** The part of three's `LoadingManager` that reports how many requests have started and ended. */
export interface ProgressSource {
  onStart?: ((url: string, loaded: number, total: number) => void) | undefined;
  onProgress?: ((url: string, loaded: number, total: number) => void) | undefined;
}

/** The loading manager of a three loader, when it has one. */
export function managerOf(loader: object): ProgressSource | null {
  const manager: unknown = Reflect.get(loader, 'manager');
  return typeof manager === 'object' && manager !== null ? manager : null;
}

const PENDING_REQUESTS = 6;

export interface AssetWatch {
  /** Counts only the requests made from now on, for the next load. */
  rebase(): void;
  stop(): void;
}

/**
 * Feeds the progress of asset requests to the tracker. What goes through the watched managers
 * counts: glb files, and every KTX2 texture, since the shared loader's manager is one of the
 * sources (the substrate textures and the HDRI load through it; so do textures embedded in
 * glTF). A manager's total keeps growing as later waves of requests start (fish lod1/lod2), so
 * a plain done/total share would fall back after the first wave and the bar would stall. The
 * extra `PENDING` in the denominator leaves room for requests not yet made, and every finished
 * request moves the bar, as long as the load runs.
 */
export function watchAssets(sources: readonly ProgressSource[], tracker: LoadTracker): AssetWatch {
  const seen = sources.map(() => ({ loaded: 0, total: 0, baseLoaded: 0, baseTotal: 0 }));
  const report = (): void => {
    let asked = 0;
    let done = 0;
    for (const s of seen) {
      asked += s.total - s.baseTotal;
      done += s.loaded - s.baseLoaded;
    }
    if (asked > 0) tracker.assets(done / (asked + PENDING_REQUESTS));
  };
  const before = sources.map((source) => ({ start: source.onStart, progress: source.onProgress }));
  sources.forEach((source, index) => {
    const mine = seen[index];
    if (mine === undefined) return;
    const update = (_url: string, loaded: number, total: number): void => {
      mine.loaded = loaded;
      mine.total = total;
      report();
    };
    source.onStart = update;
    source.onProgress = update;
  });
  return {
    rebase() {
      for (const s of seen) {
        s.baseLoaded = s.loaded;
        s.baseTotal = s.total;
      }
    },
    stop() {
      sources.forEach((source, index) => {
        source.onStart = before[index]?.start;
        source.onProgress = before[index]?.progress;
      });
    },
  };
}

/**
 * `?loadStallMs=` shortens the stall check so a test can reach the error screen; it only applies
 * together with `?e2e`.
 */
export function parseStallMs(search: string): number | undefined {
  const params = new URLSearchParams(search);
  const raw = params.get('loadStallMs');
  if (raw === null || !params.has('e2e')) return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 100) {
    throw new Error(`Unknown ?loadStallMs=${raw}; use a whole number of at least 100`);
  }
  return ms;
}

/** Frames drawn before the new tank counts as shown. */
export const WARMUP_FRAMES = 2;

export interface SwitchSources {
  assets: AssetWatch;
  /** Settles once the scene for the wanted biome is mounted, or has failed. */
  sceneSettled(): Promise<void>;
  /** Settles once the fish for the new stock have joined the sim. */
  fishSynced(): Promise<void>;
  /** Resolves after `count` frames have been drawn, calling `each` with how many so far. */
  frames(count: number, each?: (drawn: number) => void): Promise<void>;
}

export interface SwitchWatch {
  /** Starts acting on switches; the tank on show is tracked from the call that created the watch. */
  attach(sources: SwitchSources): void;
  stop(): void;
}

/**
 * Shows the loading screen for each tank switch, until the new tank has drawn two frames. A
 * switch begins only when the tank on show changes: another saved tank, the demo tank after a
 * saved one, or the other demo biome. The session repeats `tank:none` and `tank:loaded` for the
 * tank already shown, and those start nothing. The first load is never interrupted, and a failed
 * one stays failed until the page is reloaded. Create it before the session can emit, and attach
 * the sources once the engine is up.
 */
export function watchSwitches(
  interaction: EventBus<InteractionEvents>,
  tracker: LoadTracker,
  initialDemo: Biome,
): SwitchWatch {
  let sources: SwitchSources | null = null;
  let run = 0;
  let demoBiome = initialDemo;
  let savedId: string | null = null;
  let shown = `demo:${demoBiome}`;
  const start = (): void => {
    const next = savedId === null ? `demo:${demoBiome}` : `tank:${savedId}`;
    if (next === shown) return;
    shown = next;
    if (sources === null) return;
    if (tracker.current.reason === 'boot' && tracker.current.active) return;
    const mine = ++run;
    tracker.begin('switch');
    sources.assets.rebase();
    void settle(sources, mine);
  };
  const settle = async (wired: SwitchSources, mine: number): Promise<void> => {
    try {
      await Promise.resolve();
      await wired.sceneSettled();
      if (mine !== run) return;
      tracker.reach('scene');
      await wired.fishSynced();
      if (mine !== run) return;
      tracker.reach('fish');
      await wired.frames(WARMUP_FRAMES, (drawn) => tracker.part('warmup', drawn / WARMUP_FRAMES));
      if (mine === run) tracker.finish();
    } catch (cause) {
      if (mine !== run) return;
      tracker.fail(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const stops = [
    interaction.on('tank:loaded', ({ tankId }) => {
      savedId = tankId;
      start();
    }),
    interaction.on('tank:none', () => {
      savedId = null;
      start();
    }),
    interaction.on('demo:biome-changed', ({ biome }) => {
      demoBiome = biome;
      start();
    }),
  ];
  return {
    attach(next) {
      sources = next;
    },
    stop() {
      for (const stop of stops) stop();
    },
  };
}
