import type { Engine } from '../../engine/Engine';
import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import { watchReducedMotion } from '../motion';
import type { SavedDecor } from './binding';
import type { DecorMode } from './mode';
import type { DecorScenePort, DecorWorld } from './world';

export interface DecorSystem {
  readonly active: boolean;
  readonly claimsDrag: boolean;
  tap(x: number, y: number): void;
  pointerDown(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerUp(): void;
  dispose(): void;
}

/** The decor chunks are fetched once the engine is up, so they stay out of the initial bundle. */
export function createDecorSystem(
  engine: Engine,
  scene: DecorScenePort,
  interaction: EventBus<InteractionEvents>,
  saved: SavedDecor,
): DecorSystem {
  let disposed = false;
  let world: DecorWorld | null = null;
  const loadingWorld = import('./world').then(({ DecorWorld: World }) => {
    if (disposed) return null;
    world = new World(scene, interaction);
    engine.scene.add(world.group);
    saved.attach(world);
    return world;
  });
  loadingWorld.catch((cause: unknown) =>
    engine.events.emit('engine:error', { message: 'Decor', cause }),
  );

  let reduced = false;
  const stopMotion = watchReducedMotion((value) => {
    reduced = value;
  });
  let mode: DecorMode | null = null;
  let loading: Promise<void> | null = null;

  const ensureMode = async (): Promise<DecorMode> => {
    if (mode) return mode;
    loading ??= Promise.all([import('./mode'), loadingWorld]).then(
      ([{ DecorMode: Mode }, ready]) => {
        if (ready)
          mode = new Mode({
            engine,
            world: ready,
            saved,
            interaction,
            reducedMotion: () => reduced,
          });
      },
    );
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
      stopMotion();
      mode?.dispose();
      if (world) engine.scene.remove(world.group);
    },
  };
}
