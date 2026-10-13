import type { Biome } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { parseSceneOptions } from './options';
import { loadPreset } from './preset';
import { TankScene } from './TankScene';

export { TankScene } from './TankScene';
export { parseBiome } from './options';
export type { SceneAnchor } from './anemone';
export { CurrentField, sampleCurrent, type CurrentParameters } from './current';
export { ColliderField, type Collider } from './colliders';

const TIER_WAIT_MS = 15_000;
const BUILD_TIMEOUT_MS = 90_000;

/** Builds the biome's preset into the engine's tank; `search` carries `?colliders=1`. */
export function mountPreset(engine: Engine, biome: Biome, search: string): Promise<TankScene> {
  return TankScene.create(engine, loadPreset(biome), parseSceneOptions(search));
}

/**
 * Loads the preset in the background once the quality tier is known, so a device fetches only
 * the models of its own tier. Call before `engine.start()`: the tier is announced by that call
 * (pinned) or when the start-up probe ends. If neither happens in time it loads at the current
 * tier, and a build that outlives its timeout is disposed instead of attached late.
 */
export function mountPresetWhenTierKnown(
  engine: Engine,
  biome: Biome,
  search: string,
  onMounted: (scene: TankScene) => void,
): void {
  const run = async (): Promise<void> => {
    await tierKnown(engine);
    const build = mountPreset(engine, biome, search);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      engine.events.emit('engine:error', {
        message: `The ${biome} preset did not finish loading in ${BUILD_TIMEOUT_MS / 1000} s; showing the empty tank`,
      });
    }, BUILD_TIMEOUT_MS);
    try {
      const scene = await build;
      if (timedOut) await scene.dispose();
      else onMounted(scene);
    } finally {
      clearTimeout(timer);
    }
  };
  run().catch((cause: unknown) =>
    engine.events.emit('engine:error', { message: `Could not build the ${biome} preset`, cause }),
  );
}

function tierKnown(engine: Engine): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      stop();
      clearTimeout(timer);
      resolve();
    };
    const stop = engine.events.on('quality:tier-changed', ({ from }) => {
      if (from === null) finish();
    });
    const timer = setTimeout(finish, TIER_WAIT_MS);
  });
}
