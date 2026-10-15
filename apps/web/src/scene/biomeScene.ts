import type { Biome } from '@aquarium/shared';
import { raceAbort } from './abortable';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

/**
 * The biome the scene should show: the last loaded saved tank's, or `fallback` (from `?biome=`)
 * once the session says no saved tank is coming (`tank:none`). An unload alone changes nothing:
 * on a switch the session awaits the old tank's report flush before the next one loads, and
 * falling back there would build the fallback preset only to tear it down again. Create it before
 * the UI mounts, since the bus drops events nobody listens to and the session can load a tank
 * before the engine is up.
 */
export class TankBiome implements BiomeSource {
  private loaded: Biome | null = null;
  private demo: Biome;
  private readonly listeners = new Set<(biome: Biome) => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>, fallback: Biome) {
    this.demo = fallback;
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ biome }) => {
        this.loaded = biome;
        this.notify();
      }),
      interaction.on('tank:none', () => {
        this.loaded = null;
        this.notify();
      }),
    ];
  }

  get fallback(): Biome {
    return this.demo;
  }

  get current(): Biome {
    return this.loaded ?? this.demo;
  }

  /** Picks the demo tank's biome; the scene only follows it while no saved tank is loaded. */
  setFallback(biome: Biome): void {
    if (biome === this.demo) return;
    this.demo = biome;
    if (this.loaded === null) this.notify();
  }

  onChange(listener: (biome: Biome) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.listeners.clear();
  }

  private notify(): void {
    const biome = this.current;
    for (const listener of this.listeners) listener(biome);
  }
}

export interface BiomeSource {
  readonly current: Biome;
  onChange(listener: (biome: Biome) => void): () => void;
}

const ABANDONED_WAIT_MS = 5_000;

export interface DisposableScene {
  dispose(): Promise<void>;
}

export interface BiomeSceneOptions<S extends DisposableScene> {
  /** Resolves once the first build may start (the quality tier is known). */
  readonly ready: Promise<void>;
  /** `signal` aborts when the build is superseded or the scene is disposed. */
  readonly build: (biome: Biome, signal: AbortSignal) => Promise<S>;
  readonly mounted: (scene: S) => void;
  /** Called before `scene` is disposed, so whatever holds it can let go first. */
  readonly unmounting: (scene: S) => void;
  readonly onError: (message: string, cause?: unknown) => void;
  readonly timeoutMs: number;
}

/**
 * Keeps one scene built for the wanted biome. Requests made in the same tick coalesce, and a tank
 * switch between two tanks of one biome never rebuilds because `TankBiome` leaves the biome
 * unchanged across it. The old scene is disposed before the new one is built, because a scene
 * captures and restores engine state (lighting, the substrate material) and two alive at once
 * would restore each other's. A build that is no longer wanted is aborted and abandoned at once,
 * so the next biome never waits on it, and an abandoned build never mounts: whatever it still
 * produces is disposed when it lands. One that outlives `timeoutMs` reports a slow load and is
 * still mounted when it lands. A failed biome is not retried until a different one has been asked
 * for.
 */
export class BiomeScene<S extends DisposableScene> {
  private wanted: Biome;
  private attempted: Biome | null = null;
  private shown: S | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private building: { biome: Biome; controller: AbortController } | null = null;
  private readonly abandoned = new Set<Promise<void>>();
  private readonly unfollow: () => void;

  /** Follows `source` until disposed. */
  constructor(
    source: BiomeSource,
    private readonly options: BiomeSceneOptions<S>,
  ) {
    this.wanted = source.current;
    this.unfollow = source.onChange((biome) => this.show(biome));
    this.kick();
  }

  get scene(): S | null {
    return this.shown;
  }

  show(biome: Biome): void {
    if (this.stopped) return;
    this.wanted = biome;
    queueMicrotask(() => this.abandonUnwanted());
    this.kick();
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.unfollow();
    this.building?.controller.abort(new DOMException('The scene was disposed', 'AbortError'));
    await this.unmount();
    await this.settled();
    if (this.abandoned.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), ABANDONED_WAIT_MS);
    });
    const drained = (async () => {
      while (this.abandoned.size > 0) await Promise.all([...this.abandoned]);
      return false;
    })();
    const timedOut = await Promise.race([drained, gaveUp]);
    clearTimeout(timer);
    if (timedOut) {
      this.options.onError(
        `An abandoned preset build did not stop within ${ABANDONED_WAIT_MS / 1000} s; it is released when it lands`,
      );
    }
  }

  private abandonUnwanted(): void {
    const { building } = this;
    if (!building || building.biome === this.wanted) return;
    if (this.attempted === building.biome) this.attempted = null;
    building.controller.abort(new DOMException('A newer biome was requested', 'AbortError'));
  }

  private kick(): void {
    this.running ??= this.drain().finally(() => {
      this.running = null;
      if (!this.stopped && this.wanted !== this.attempted) this.kick();
    });
  }

  private async drain(): Promise<void> {
    await this.options.ready;
    while (!this.stopped && this.wanted !== this.attempted) {
      const biome = this.wanted;
      this.attempted = biome;
      await this.unmount();
      const scene = await this.build(biome);
      if (scene === null) continue;
      if (this.stopped || this.wanted !== biome) {
        await this.release(scene);
        continue;
      }
      this.shown = scene;
      this.hook('mounted', scene);
    }
  }

  private hook(name: 'mounted' | 'unmounting', scene: S): void {
    try {
      this.options[name](scene);
    } catch (cause) {
      this.options.onError(`Scene ${name} hook failed`, cause);
    }
  }

  private async build(biome: Biome): Promise<S | null> {
    const { timeoutMs, onError } = this.options;
    const controller = new AbortController();
    this.building = { biome, controller };
    const timer = setTimeout(() => {
      onError(
        `The ${biome} preset is still loading after ${timeoutMs / 1000} s; showing the empty tank until it arrives`,
      );
    }, timeoutMs);
    const attempt = this.options.build(biome, controller.signal);
    try {
      const scene = await raceAbort(attempt, controller.signal);
      if (controller.signal.aborted) {
        await this.release(scene);
        return null;
      }
      return scene;
    } catch (cause) {
      if (controller.signal.aborted) {
        this.track(
          attempt.then(
            (late) => this.release(late),
            (late: unknown) => {
              if (!isAbort(late)) console.debug(`The abandoned ${biome} preset build failed`, late);
            },
          ),
        );
        return null;
      }
      onError(`Could not build the ${biome} preset`, cause);
      return null;
    } finally {
      clearTimeout(timer);
      this.building = null;
    }
  }

  private track(cleanup: Promise<void>): void {
    this.abandoned.add(cleanup);
    void cleanup.finally(() => this.abandoned.delete(cleanup));
  }

  private async unmount(): Promise<void> {
    const scene = this.shown;
    if (scene === null) return;
    this.shown = null;
    this.hook('unmounting', scene);
    await this.release(scene);
  }

  private async release(scene: S): Promise<void> {
    try {
      await scene.dispose();
    } catch (cause) {
      this.options.onError('Scene dispose failed', cause);
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
