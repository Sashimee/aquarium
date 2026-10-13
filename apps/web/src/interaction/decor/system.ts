import type { Engine } from '../../engine/Engine';
import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import { watchReducedMotion } from '../motion';
import { SavedDecor, type SavedTank } from './binding';
import type { DecorMode } from './mode';
import type { FeederLayer } from './feederLayer';
import { DecorWorld, type DecorScenePort } from './world';

export interface DecorSystem {
  readonly active: boolean;
  readonly claimsDrag: boolean;
  tap(x: number, y: number): void;
  pointerDown(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerUp(): void;
  dispose(): void;
}

/** The saved layouts are shown from the start; the editor itself is fetched when decorating is first asked for. */
export function createDecorSystem(
  engine: Engine,
  scene: DecorScenePort,
  interaction: EventBus<InteractionEvents>,
  initial: SavedTank | null,
  feeders: FeederLayer,
): DecorSystem {
  const saved = new SavedDecor(
    interaction,
    (message, cause) => console.error(message, cause),
    initial,
  );
  let disposed = false;
  const world = new DecorWorld(scene, interaction, feeders);
  engine.scene.add(feeders.group);
  saved.attach(world);

  let reduced = false;
  const stopMotion = watchReducedMotion((value) => {
    reduced = value;
  });
  let mode: DecorMode | null = null;
  let loading: Promise<void> | null = null;

  const ensureMode = async (): Promise<DecorMode> => {
    if (mode) return mode;
    loading ??= import('./mode').then(({ DecorMode: Mode }) => {
      mode = new Mode({ engine, world, saved, interaction, reducedMotion: () => reduced });
    });
    await loading;
    if (!mode) throw new Error('Decorate mode failed to load. Reload the page and try again.');
    return mode;
  };

  const stopRequests = interaction.on('decor:request-mode', ({ active }) => {
    if (disposed) return;
    if (!active) {
      mode?.stop();
      return;
    }
    ensureMode().then(
      (m) => {
        if (!disposed) m.start();
      },
      (cause: unknown) => engine.events.emit('engine:error', { message: 'Decorate mode', cause }),
    );
  });

  return {
    get active() {
      return mode?.active ?? false;
    },
    get claimsDrag() {
      return mode?.claimsDrag ?? false;
    },
    tap: (x, y) => mode?.tap(x, y),
    pointerDown: (x, y) => mode?.pointerDown(x, y),
    pointerMove: (x, y) => mode?.pointerMove(x, y),
    pointerUp: () => mode?.pointerUp(),
    dispose() {
      disposed = true;
      stopRequests();
      saved.dispose();
      stopMotion();
      mode?.dispose();
    },
  };
}
