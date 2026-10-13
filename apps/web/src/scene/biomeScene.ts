import type { Biome } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';

/**
 * The biome the scene should show: the loaded saved tank's, or `fallback` (from `?biome=`) while
 * none is loaded. Create it before the UI mounts, since the bus drops events nobody listens to and
 * the session can load a tank before the engine is up.
 */
export class TankBiome implements BiomeSource {
  private loaded: { readonly tankId: string; readonly biome: Biome } | null = null;
  private readonly listeners = new Set<(biome: Biome) => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(
    interaction: EventBus<InteractionEvents>,
    readonly fallback: Biome,
  ) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId, biome }) => {
        this.loaded = { tankId, biome };
        this.notify();
      }),
      interaction.on('tank:unloaded', ({ tankId }) => {
        if (this.loaded?.tankId !== tankId) return;
        this.loaded = null;
        this.notify();
      }),
    ];
  }

  get current(): Biome {
    return this.loaded?.biome ?? this.fallback;
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
 * Keeps one scene built for the wanted biome. Requests made in the same tick coalesce, so a tank
 * switch (unload, then load) between two tanks of one biome never rebuilds. The old scene is
 * disposed before the new one is built, because a scene captures and restores engine state
 * (lighting, the substrate material) and two alive at once would restore each other's. A build
 * that is no longer wanted when it lands, or that outlives `timeoutMs`, is disposed unseen, and a
 * failed biome is not retried until a different one has been asked for.
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
      this.options.mounted(scene);
    }
  }

  private async build(biome: Biome): Promise<S | null> {
    const { timeoutMs, onError } = this.options;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onError(
        `The ${biome} preset did not finish loading in ${timeoutMs / 1000} s; showing the empty tank`,
      );
    }, timeoutMs);
    let scene: S;
    try {
      scene = await this.options.build(biome);
    } catch (cause) {
      onError(`Could not build the ${biome} preset`, cause);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!timedOut) return scene;
    await this.release(scene);
    return null;
  }

  private async unmount(): Promise<void> {
    const scene = this.shown;
    if (scene === null) return;
    this.shown = null;
    this.options.unmounting(scene);
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
