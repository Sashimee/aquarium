import type { DecorLayout } from '@aquarium/shared';
import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import type { DecorWorld } from './world';

export interface SavedTank {
  readonly tankId: string;
  readonly biome: string;
  readonly layout: DecorLayout;
}

/**
 * Keeps the scene on the active saved tank's layout, so a rearranged tank looks the same on
 * every visit. It follows the tank events from construction on, and shows the latest layout
 * once `attach` hands it the world.
 */
export class SavedDecor {
  private world: DecorWorld | null = null;
  private latest: { biome: string; layout: DecorLayout } | null = null;
  private editing = false;
  private customised = false;
  private loadedTankId: string | null = null;
  private readonly offs: (() => void)[];

  constructor(
    interaction: EventBus<InteractionEvents>,
    private readonly report: (message: string, cause: unknown) => void,
    initial: SavedTank | null = null,
  ) {
    if (initial) {
      this.loadedTankId = initial.tankId;
      this.latest = { biome: initial.biome, layout: initial.layout };
    }
    this.offs = [
      interaction.on('decor:mode-changed', ({ active }) => {
        this.editing = active;
      }),
      interaction.on('tank:loaded', ({ tankId, biome, decorLayout }) => {
        this.loadedTankId = tankId;
        this.latest = { biome, layout: decorLayout };
        this.show();
      }),
      interaction.on('tank:decor', ({ tankId, layout }) => {
        if (this.editing || !this.latest || tankId !== this.loadedTankId) return;
        this.latest = { ...this.latest, layout };
        this.show();
      }),
      interaction.on('tank:unloaded', ({ reason }) => {
        this.loadedTankId = null;
        this.latest = null;
        // The next tank's layout follows a switch; rearranging to the preset in between would flash.
        if (reason !== 'switch') this.show();
      }),
      interaction.on('tank:none', () => this.show()),
    ];
  }

  /** The saved tank being shown, or null for the demo tank. */
  get tankId(): string | null {
    return this.loadedTankId;
  }

  /** False while a saved tank of another biome than the built scene is active. */
  get editable(): boolean {
    return this.world !== null && (this.latest === null || this.latest.biome === this.world.biome);
  }

  attach(world: DecorWorld): void {
    this.world = world;
    world.emitColliders();
    this.show();
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.world?.dispose();
    this.world = null;
  }

  private show(): void {
    const world = this.world;
    if (!world) return;
    // Another biome's tank means this scene is about to be replaced; arranging it would only race its disposal.
    if (this.latest && this.latest.biome !== world.biome) return;
    const saved = this.latest;
    if (!saved && !this.customised) return;
    this.customised = saved !== null;
    const task = saved ? world.showSaved(saved.layout) : world.showPreset();
    task.catch((cause: unknown) => this.report('Could not arrange the decor', cause));
  }
}
