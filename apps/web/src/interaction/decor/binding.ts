import type { DecorLayout } from '@aquarium/shared';
import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import type { DecorWorld } from './world';

/**
 * Keeps the scene on the active saved tank's layout, so a rearranged tank looks the same on
 * every visit. It listens from boot, because a tank usually loads before its scene is built,
 * and shows the latest layout once `attach` hands it the world.
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
  ) {
    this.offs = [
      interaction.on('decor:mode-changed', ({ active }) => {
        this.editing = active;
      }),
      interaction.on('tank:loaded', ({ tankId, biome, decorLayout }) => {
        this.loadedTankId = tankId;
        this.latest = { biome, layout: decorLayout };
        this.show();
      }),
      interaction.on('tank:decor', ({ layout }) => {
        if (this.editing || !this.latest) return;
        this.latest = { ...this.latest, layout };
        this.show();
      }),
      interaction.on('tank:unloaded', () => {
        this.loadedTankId = null;
        this.latest = null;
        this.show();
      }),
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
    const saved = this.latest && this.latest.biome === world.biome ? this.latest : null;
    if (!saved && !this.customised) return;
    this.customised = saved !== null;
    const task = saved ? world.showSaved(saved.layout) : world.showPreset();
    task.catch((cause: unknown) => this.report('Could not arrange the decor', cause));
  }
}
