import type { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';

export function glassAlgaeAmount(algae: number): number {
  return Number.isFinite(algae) ? Math.min(1, Math.max(0, algae)) : 0;
}

/**
 * The algae on the glass of the saved tank on show, 0 for the demo tank. Create it before the UI
 * mounts, like `TankSizeSource`, since the session can load a tank before the engine is up.
 */
export class GlassAlgaeSource {
  private amount = 0;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:water', ({ water }) => this.set(glassAlgaeAmount(water.algae))),
      interaction.on('tank:none', () => this.set(0)),
    ];
  }

  current(): number {
    return this.amount;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.listeners.clear();
  }

  private set(amount: number): void {
    if (amount === this.amount) return;
    this.amount = amount;
    for (const listener of this.listeners) listener();
  }
}

/** Shows the source's algae on the engine's glass now and whenever it changes; returns the stop. */
export function followGlassAlgae(
  engine: { tank: { setAlgae(amount: number): void } },
  source: GlassAlgaeSource,
): () => void {
  engine.tank.setAlgae(source.current());
  return source.onChange(() => engine.tank.setAlgae(source.current()));
}
