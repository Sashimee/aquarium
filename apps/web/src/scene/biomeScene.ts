import type { Biome } from '@aquarium/shared';
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

export interface DisposableScene {
  dispose(): Promise<void>;
}

export interface BiomeSceneOptions<S extends DisposableScene> {
  /** Resolves once the first build may start (the quality tier is known). */
  readonly ready: Promise<void>;
  readonly build: (biome: Biome) => Promise<S>;
  readonly mounted: (scene: S) => void;
  /** Called before `scene` is disposed, so whatever holds it can let go first. */
  readonly unmounting: (scene: S) => void;
  readonly onError: (message: string, cause?: unknown) => void;
  readonly timeoutMs: number;
}

/**
 * Keeps one scene built for the wanted biome. Requests made in the same tick coalesce, but a tank
 * switch between two tanks of one biome never rebuilds because `TankBiome` keeps the biome
 * unchanged across it, not because of the coalescing. The old scene is
 * disposed before the new one is built, because a scene captures and restores engine state
 * (lighting, the substrate material) and two alive at once would restore each other's. A build
 * that is no longer wanted when it lands is disposed unseen. One that outlives `timeoutMs` reports
 * a slow load and is still mounted when it lands. A failed biome is not retried until a different one has been asked for.
 */
export class BiomeScene<S extends DisposableScene> {
  private wanted: Biome;
  private attempted: Biome | null = null;
  private shown: S | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
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
    this.kick();
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.unfollow();
    await this.unmount();
    await this.settled();
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
    const timer = setTimeout(() => {
      onError(
        `The ${biome} preset is still loading after ${timeoutMs / 1000} s; showing the empty tank until it arrives`,
      );
    }, timeoutMs);
    try {
      return await this.options.build(biome);
    } catch (cause) {
      onError(`Could not build the ${biome} preset`, cause);
      return null;
    } finally {
      clearTimeout(timer);
    }
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
