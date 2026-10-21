import type { Plant } from '@aquarium/shared';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { isPublicTankId } from './share';

export interface PlantSink {
  setPlants(plants: readonly Plant[] | undefined): void;
}

/**
 * Carries the active tank's growing plants to the scene. Created before the scene exists, so
 * `attach` hands over what is held so far. A tank switch keeps the old plants until the next tank
 * announces its own, so the garden never flashes bare in between; signing out, having no tank or
 * showing a public tank (which has no growth state) returns the scene to the plants as drawn.
 */
export class PlantFeed {
  private plants: readonly Plant[] | undefined;
  private sink: PlantSink | null = null;
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

  attach(sink: PlantSink): void {
    this.sink = sink;
    sink.setPlants(this.plants);
  }

  detach(): void {
    this.sink = null;
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.sink = null;
  }

  private reset(): void {
    this.activeTankId = null;
    this.set(undefined);
  }

  private set(plants: readonly Plant[] | undefined): void {
    this.plants = plants;
    this.sink?.setPlants(plants);
  }
}
