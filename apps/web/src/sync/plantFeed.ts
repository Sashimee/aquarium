import type { Plant } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { isPublicTankId } from './share';

export interface PlantSink {
  setPlants(plants: readonly Plant[] | undefined): void;
}

/**
 * Carries the active tank's growing plants to everything that draws or collides with them: the scene
 * and the decor layer's sim colliders. Created before the scene exists, so
 * `attach` hands over what is held so far. A tank switch keeps the old plants until the next tank
 * announces its own, so the garden never flashes bare in between; signing out, having no tank or
 * showing a public tank (which has no growth state) returns the scene to the plants as drawn.
 */
export class PlantFeed {
  private plants: readonly Plant[] | undefined;
  private readonly sinks = new Set<PlantSink>();
  private activeTankId: string | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('tank:loaded', ({ tankId }) => {
        this.activeTankId = tankId;
        if (isPublicTankId(tankId)) this.set(undefined);
      }),
      interaction.on('tank:plants', ({ tankId, plants }) => {
        if (tankId === this.activeTankId) this.set(plants);
      }),
      interaction.on('tank:unloaded', ({ reason }) => {
        if (reason === 'reset') this.reset();
        else this.activeTankId = null;
      }),
      interaction.on('tank:none', () => this.reset()),
    ];
  }

  /** Hands the sink what is held so far; the returned function detaches it. */
  attach(sink: PlantSink): () => void {
    this.sinks.add(sink);
    sink.setPlants(this.plants);
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

  private set(plants: readonly Plant[] | undefined): void {
    this.plants = plants;
    for (const sink of this.sinks) sink.setPlants(plants);
  }
}
