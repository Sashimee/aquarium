import { FoodField } from './particles';

/** What the sim sends back when a fish takes a particle. */
export interface AteEvent {
  readonly fishId: string;
  readonly foodId: number;
  readonly portion: number;
}

/**
 * The slice of the sim bridge that feeding needs. Both members are optional so the link runs
 * (particles render and settle, nobody eats) until the sim exposes them.
 */
export interface FoodBridge {
  setFood?(buffer: Float32Array): void;
  onAte?(listener: (events: readonly AteEvent[]) => void): () => void;
}

export interface EatenFood {
  readonly fishId: string;
  readonly portion: number;
}

export type ToSimSpace = (x: number, y: number, z: number, out: Float64Array) => void;

export const FOOD_SYNC_HZ = 30;

/** Pushes the particles to the sim each tick and applies its `ate` events. */
export class FoodLink {
  private accumulatorS = 0;
  private readonly detach: (() => void) | null;

  constructor(
    private readonly field: FoodField,
    private readonly bridge: FoodBridge,
    private readonly toSim: ToSimSpace,
    private readonly onEaten: (eaten: readonly EatenFood[]) => void,
  ) {
    this.detach = bridge.onAte?.((events) => this.handleAte(events)) ?? null;
  }

  /** Call once per frame; sends at most one buffer per sim tick. */
  update(deltaS: number): void {
    if (!this.bridge.setFood) return;
    this.accumulatorS += deltaS;
    const tick = 1 / FOOD_SYNC_HZ;
    if (this.accumulatorS < tick) return;
    this.accumulatorS %= tick;
    this.bridge.setFood(this.field.pack(this.toSim));
  }

  handleAte(events: readonly AteEvent[]): void {
    const eaten: EatenFood[] = [];
    const taken = new Set<number>();
    for (const e of events) {
      if (taken.has(e.foodId)) continue;
      if (this.field.remove([e.foodId]).length === 0) continue;
      taken.add(e.foodId);
      eaten.push({ fishId: e.fishId, portion: e.portion });
    }
    if (eaten.length > 0) this.onEaten(eaten);
  }

  dispose(): void {
    this.detach?.();
  }
}
