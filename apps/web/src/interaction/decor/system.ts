import type { Engine } from '../../engine/Engine';
import type { EventBus } from '../../engine/events';
import type { InteractionEvents } from '../events';
import { watchReducedMotion } from '../motion';
import { SavedDecor, type SavedTank } from './binding';
import type { DecorMode } from './mode';
import type { FeederLayer } from './feederLayer';
import { DecorWorld, type DecorScenePort } from './world';
import type { CoralFeed } from '../../sync/coralFeed';
import { reachCurrent, type CurrentParameters } from '../../scene/current';
import { DEFAULT_CURRENT } from '../../scene/TankScene';
import { loadPreset } from '../../scene/preset';
import { generateEuphyllia, parseEuphylliaId } from '../../scene/euphyllia';

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
  corals?: CoralFeed,
): DecorSystem {
  const saved = new SavedDecor(
    interaction,
    (message, cause) => console.error(message, cause),
    initial,
  );
  let disposed = false;
  let reach: CurrentParameters | null = null;
  const euphylliaBounds = new Map<string, ReturnType<typeof generateEuphyllia>['bounds']>();
  const world = new DecorWorld(scene, interaction, feeders, {
    dimensions: () => engine.tank.dimensions,
    current: () => {
      reach ??= reachCurrent(loadPreset(scene.biome).current ?? DEFAULT_CURRENT, scene.biome);
      return reach;
    },
    proceduralBounds(assetId) {
      const held = euphylliaBounds.get(assetId);
      if (held) return held;
      const id = parseEuphylliaId(assetId);
      if (!id) return null;
      const { bounds } = generateEuphyllia(id.variant, id.seed, 2);
      euphylliaBounds.set(assetId, bounds);
      return bounds;
    },
  });
  engine.scene.add(feeders.group);
  saved.attach(world);
  const stopTaps = interaction.on('play:tapped', ({ ray }) => {
    interaction.emit('coral:picked', { key: world.coralAt(ray)?.key ?? null });
  });
  const detachCorals = corals?.attach({ setCorals: (state) => world.setCorals(state) });

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

  let wanted = false;
  const stopRequests = interaction.on('decor:request-mode', ({ active }) => {
    if (disposed) return;
    wanted = active;
    if (!active) {
      mode?.stop();
      return;
    }
    ensureMode().then(
      (m) => {
        if (!disposed && wanted) m.start();
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
      stopTaps();
      detachCorals?.();
      stopMotion();
      mode?.dispose();
      saved.dispose();
    },
  };
}
