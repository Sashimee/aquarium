import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import type { LoadTracker } from './loadTracker';

/** The part of three's `LoadingManager` that reports how many requests have started and ended. */
export interface ProgressSource {
  onStart?: ((url: string, loaded: number, total: number) => void) | undefined;
  onProgress?: ((url: string, loaded: number, total: number) => void) | undefined;
}

export interface AssetWatch {
  /** Counts only the requests made from now on, for the next load. */
  rebase(): void;
  stop(): void;
}

/**
 * Feeds the share of finished asset requests (glb, textures and the rest that go through the
 * manager) to the tracker. The manager's total grows as new requests start, so the share is taken
 * against what was requested since `rebase`.
 */
export function watchAssets(source: ProgressSource, tracker: LoadTracker): AssetWatch {
  let loaded = 0;
  let total = 0;
  let baseLoaded = 0;
  let baseTotal = 0;
  const report = (_url: string, nowLoaded: number, nowTotal: number): void => {
    loaded = nowLoaded;
    total = nowTotal;
    const asked = total - baseTotal;
    if (asked > 0) tracker.assets((loaded - baseLoaded) / asked);
  };
  const before = { start: source.onStart, progress: source.onProgress };
  source.onStart = report;
  source.onProgress = report;
  return {
    rebase() {
      baseLoaded = loaded;
      baseTotal = total;
    },
    stop() {
      source.onStart = before.start;
      source.onProgress = before.progress;
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

export interface SwitchSources {
  interaction: EventBus<InteractionEvents>;
  tracker: LoadTracker;
  assets: AssetWatch;
  /** Settles once the scene for the wanted biome is mounted, or has failed. */
  sceneSettled(): Promise<void>;
  /** Settles once the fish for the new stock have joined the sim. */
  fishSynced(): Promise<void>;
  /** Resolves after `count` frames have been drawn. */
  frames(count: number): Promise<void>;
}

/**
 * Shows the loading screen for each tank switch, until the new tank has drawn two frames. A
 * switch begins when the scene's wanted tank changes: a saved tank loads, the session says there
 * is none, or the demo tank's biome is picked. It never interrupts the first load.
 */
export function watchSwitches(sources: SwitchSources): () => void {
  const { interaction, tracker, assets } = sources;
  let run = 0;
  const start = (): void => {
    if (tracker.current.reason === 'boot' && tracker.running) return;
    const mine = ++run;
    tracker.begin('switch');
    assets.rebase();
    void settle(mine);
  };
  const settle = async (mine: number): Promise<void> => {
    try {
      await Promise.resolve();
      await sources.sceneSettled();
      if (mine !== run) return;
      tracker.reach('scene');
      await sources.fishSynced();
      if (mine !== run) return;
      tracker.reach('fish');
      await sources.frames(2);
      if (mine === run) tracker.finish();
    } catch (cause) {
      if (mine !== run) return;
      tracker.fail(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const stops = [
    interaction.on('tank:loaded', start),
    interaction.on('tank:none', start),
    interaction.on('demo:biome-changed', start),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
