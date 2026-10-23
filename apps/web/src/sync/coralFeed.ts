import type { Coral } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { isPublicTankId } from './share';

export interface CoralSink {
  setCorals(corals: readonly Coral[] | undefined): void;
}

/**
 * Carries the active tank's coral state to everything that draws or collides with it: the scene
 * and the decor layer's sim colliders. Created before either exists, so `attach` hands over what is
 * held so far. A tank switch keeps the old corals until the next tank announces its own, so the
 * reef never flashes back to its starting size in between; signing out, having no tank or showing a
 * public tank (which has no coral state) returns to the corals as drawn.
 */
export class CoralFeed {
  private corals: readonly Coral[] | undefined;
  private readonly sinks = new Set<CoralSink>();
  private activeTankId: string | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => {
        this.activeTankId = tankId;
        if (isPublicTankId(tankId)) this.set(undefined);
      }),
      interaction.on('tank:corals', ({ tankId, corals }) => {
        if (tankId === this.activeTankId) this.set(corals);
      }),
      interaction.on('tank:unloaded', ({ reason }) => {
        if (reason === 'reset') this.reset();
        else this.activeTankId = null;
      }),
      interaction.on('tank:none', () => this.reset()),
    ];
  }

  /** Hands the sink what is held so far; the returned function detaches it. */
  attach(sink: CoralSink): () => void {
    this.sinks.add(sink);
    sink.setCorals(this.corals);
    return () => {
      this.sinks.delete(sink);
    };
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.sinks.clear();
  }

  private reset(): void {
    this.activeTankId = null;
    this.set(undefined);
  }

  private set(corals: readonly Coral[] | undefined): void {
    this.corals = corals;
    for (const sink of this.sinks) sink.setCorals(corals);
  }
}
