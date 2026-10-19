import type { Biome } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { parseSceneOptions } from './options';
import { loadPreset } from './preset';
import { BiomeScene, type TankBiome } from './biomeScene';
import { TankScene } from './TankScene';

export { TankScene } from './TankScene';
export { parseBiome, withBiome } from './options';
export { BiomeScene, TankBiome } from './biomeScene';
export type { SceneAnchor } from './anemone';
export { CurrentField, sampleCurrent, type CurrentParameters } from './current';
export { ColliderField, type Collider } from './colliders';
export * from './room';

const TIER_WAIT_MS = 15_000;
const BUILD_TIMEOUT_MS = 90_000;

/**
 * Builds the biome's preset into the engine's tank; `search` carries `?colliders=1`. Aborting
 * `signal` stops the build at its next checkpoint, disposes whatever it produced, and only then
 * rejects with the abort reason.
 */
export function mountPreset(
  engine: Engine,
  biome: Biome,
  search: string,
  signal?: AbortSignal,
): Promise<TankScene> {
  return TankScene.create(engine, loadPreset(biome), parseSceneOptions(search), signal);
}

/**
 * Shows the preset of `biome.current` and rebuilds it in place whenever that changes. The first
 * build waits until the quality tier is known, so a device fetches only the models of its own
 * tier: call before `engine.start()`, since the tier is announced by that call (pinned) or when
 * the start-up probe ends. If neither happens in time it loads at the current tier.
 */
export function mountBiomeScene(
  engine: Engine,
  biome: TankBiome,
  search: string,
  hooks: {
    mounted(scene: TankScene): void;
    unmounting(scene: TankScene): void;
    failed?(message: string): void;
  },
): BiomeScene<TankScene> {
  return new BiomeScene<TankScene>(biome, {
    ready: tierKnown(engine),
    build: (b, signal) => mountPreset(engine, b, search, signal),
    mounted: hooks.mounted,
    unmounting: hooks.unmounting,
    onError: (message, cause) => engine.events.emit('engine:error', { message, cause }),
    ...(hooks.failed ? { onFailure: hooks.failed } : {}),
    timeoutMs: BUILD_TIMEOUT_MS,
  });
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
