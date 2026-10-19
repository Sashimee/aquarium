import type { FoodType } from '@aquarium/shared';
import type { EventBus } from '../../engine/events';
import type { InteractionEvents, PlayTool } from '../events';

/**
 * The play tool and food the UI last asked for. A play system is rebuilt with every scene and its
 * controller starts at tap and flakes, while the UI keeps showing the user's choice, so this
 * outlives the play systems and hands the choice to each new controller. A tool picked while a
 * scene was building, when no controller listened, is applied the same way.
 * The game tool belongs to a running round, which a rebuilt scene does not carry, so it is never kept. Taps and feeds in
 * that window are dropped: there is no water to drop food into, and no `feed:dropped` fires, so
 * nothing is posted or announced.
 */
export class PlayChoices {
  private tool: PlayTool = 'tap';
  private food: FoodType = 'flakes';
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly interaction: EventBus<InteractionEvents>) {
    this.unsubscribe = [
      interaction.on('play:request-tool', ({ tool }) => {
        if (tool !== 'game') this.tool = tool;
      }),
      interaction.on('play:tool-changed', ({ tool }) => {
        if (tool !== 'game') this.tool = tool;
      }),
      interaction.on('feed:select', ({ food }) => {
        this.food = food;
      }),
      interaction.on('feed:request', ({ food }) => {
        this.food = food;
      }),
    ];
  }

  /** Call right after creating a play system, before any input reaches it. */
  applyTo(controller: { setTool(tool: PlayTool): void }): void {
    controller.setTool(this.tool);
    this.interaction.emit('feed:select', { food: this.food });
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
  }
}
