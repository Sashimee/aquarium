import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import type { SavedTank } from './binding';
import type { DecorSystem } from './system';

export type DecorFactory<S> = (scene: S, initial: SavedTank | null) => DecorSystem;

/**
 * Gives each built scene its own decor system. The scene is rebuilt when the tank's biome changes
 * and the saved layout arrives on `tank:loaded` before the new scene is up, so the latest saved
 * tank is tracked here for the page's lifetime and handed to each new system. The decor code is a
 * lazy chunk; a scene unmounted before it arrives gets none.
 */
export class SceneDecor<S> {
  private saved: SavedTank | null = null;
  private scene: S | null = null;
  private decor: DecorSystem | null = null;
  private stopped = false;
  private readonly offs: (() => void)[];

  constructor(
    interaction: EventBus<InteractionEvents>,
    private readonly load: () => Promise<DecorFactory<S>>,
    private readonly report: (message: string, cause: unknown) => void,
  ) {
    this.offs = [
      interaction.on('tank:loaded', ({ tankId, biome, decorLayout }) => {
        this.saved = { tankId, biome, layout: decorLayout };
      }),
      interaction.on('tank:decor', ({ tankId, layout }) => {
        if (this.saved?.tankId === tankId) this.saved = { ...this.saved, layout };
      }),
      interaction.on('tank:unloaded', () => {
        this.saved = null;
      }),
    ];
  }

  get system(): DecorSystem | null {
    return this.decor;
  }

  mount(scene: S): void {
    if (this.stopped) return;
    this.scene = scene;
    this.load().then(
      (create) => {
        if (this.stopped || this.scene !== scene || this.decor) return;
        this.decor = create(scene, this.saved);
      },
      (cause: unknown) => this.report('Decor failed to load', cause),
    );
  }

  unmount(): void {
    this.scene = null;
    this.decor?.dispose();
    this.decor = null;
  }

  dispose(): void {
    this.stopped = true;
    this.unmount();
    for (const off of this.offs) off();
  }
}
