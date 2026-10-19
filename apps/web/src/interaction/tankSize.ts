import type { TankSize } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';

/**
 * The size of the saved tank on show, or none while the demo tank is. Create it before the UI
 * mounts, like `TankBiome`, since the session can load a tank before the engine is up.
 */
export class TankSizeSource {
  private loaded: TankSize | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ size }) => this.set(size)),
      interaction.on('tank:none', () => this.set(null)),
    ];
  }

  /** The loaded tank's size, else `demo`. */
  current(demo: TankSize): TankSize {
    return this.loaded ?? demo;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.listeners.clear();
  }

  private set(size: TankSize | null): void {
    if (size === this.loaded) return;
    this.loaded = size;
    for (const listener of this.listeners) listener();
  }
}

/** Resizes the engine's tank to the one on show now and whenever that changes; returns the stop. */
export function followTankSize(
  engine: { setTankSize(size: TankSize): void },
  source: TankSizeSource,
  demo: TankSize,
): () => void {
  engine.setTankSize(source.current(demo));
  return source.onChange(() => engine.setTankSize(source.current(demo)));
}
