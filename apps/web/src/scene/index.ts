import type { Biome } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import { parseSceneOptions } from './options';
import { loadPreset } from './preset';
import { TankScene } from './TankScene';

export { TankScene } from './TankScene';
export { CurrentField, sampleCurrent, type CurrentParameters } from './current';
export { ColliderField, type Collider } from './colliders';

/** Builds the biome's preset into the engine's tank; `search` carries `?colliders=1`. */
export function mountPreset(engine: Engine, biome: Biome, search: string): Promise<TankScene> {
  return TankScene.create(engine, loadPreset(biome), parseSceneOptions(search));
}
