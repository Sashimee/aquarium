import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import type { SavedTank } from './binding';
import type { DecorSystem } from './system';

export type DecorFactory<S> = (scene: S, initial: SavedTank | null) => DecorSystem;

/**
 * Gives each built scene its own decor system. The scene is rebuilt when the tank's biome changes
 * and the saved layout arrives on `tank:loaded` before the new scene is up, so the latest saved
 * tank is tracked here for the page's lifetime and handed to each new system. The decor code is a
 * lazy chunk; a scene unmounted before it arrives gets none. A request to enter decorate mode that
 * arrives while no system exists (first load, or between scenes) is remembered and replayed once
 * the next system is up, so the first tap on Decorate is never lost.
 */
export class SceneDecor<S> {
  private saved: SavedTank | null = null;
  private scene: S | null = null;
  private decor: DecorSystem | null = null;
  private stopped = false;
  private wanted = false;
  private failed = false;
  private readonly offs: (() => void)[];

  constructor(
    private readonly interaction: EventBus<InteractionEvents>,
    private readonly load: () => Promise<DecorFactory<S>>,
    private readonly report: (message: string, cause: unknown) => void,
  ) {
    this.offs = [
      interaction.on('decor:request-mode', ({ active }) => {
        this.wanted = active;
        if (active && this.failed && this.scene && !this.decor) this.mount(this.scene);
      }),
      interaction.on('decor:mode-changed', ({ active }) => {
        this.wanted = active;
      }),
      interaction.on('tank:loaded', ({ tankId, biome, decorLayout, decorEdited }) => {
        this.saved = { tankId, biome, layout: decorLayout, edited: decorEdited };
      }),
      interaction.on('tank:decor', ({ tankId, layout, edited }) => {
        if (this.saved?.tankId === tankId) this.saved = { ...this.saved, layout, edited };
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
        this.setFailed(null);
        if (this.wanted && !this.decor.active) {
          this.interaction.emit('decor:request-mode', { active: true });
        }
      },
      (cause: unknown) => {
        this.report('Decor failed to load', cause);
        if (!this.stopped && this.scene === scene) {
          this.setFailed('Decorating could not load. Check your connection and try again.');
        }
      },
    );
  }

  private setFailed(message: string | null): void {
    if (message === null && !this.failed) return;
    this.failed = message !== null;
    this.interaction.emit('decor:load-failed', { message });
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
