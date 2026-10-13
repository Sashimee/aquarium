import type { Biome } from '@aquarium/shared';
import type { Stimulus } from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import type { TankDimensions } from '../engine/tank/dimensions';
import type { SceneAnchor } from '../scene/anemone';
import type { FishSystem } from './FishSystem';

export interface DemoFish {
  /** Forwards to the sim once the school is up; stimuli before that are dropped. */
  readonly sim: { startle(stimulus: Stimulus): void };
  /** Engine-space homes; held until the school is up, then forwarded. */
  setAnchors(anchors: readonly SceneAnchor[]): void;
  stop(): void;
}

/**
 * Starts the demo school without blocking boot. The fish code (loaders, sim client) is a separate
 * chunk, since nothing swims before the models arrive anyway.
 */
export function startDemoFish(
  engine: Engine,
  tank: TankDimensions,
  biome: Biome,
  assetRoot: string,
): DemoFish {
  const abort = new AbortController();
  let ready: FishSystem | null = null;
  let anchors: readonly SceneAnchor[] | null = null;
  const system = import('./FishSystem')
    .then(({ FishSystem }) =>
      FishSystem.create(engine, { tank, biome, assetRoot, signal: abort.signal }),
    )
    .then((fish) => {
      if (!abort.signal.aborted) {
        ready = fish;
        if (anchors !== null) fish.setAnchors(anchors);
      }
      return fish;
    })
    .catch((cause: unknown) => {
      if (!abort.signal.aborted) {
        engine.events.emit('engine:error', { message: 'Fish failed to start', cause });
      }
      return null;
    });
  return {
    sim: { startle: (stimulus) => ready?.startle(stimulus) },
    setAnchors(next) {
      anchors = next;
      ready?.setAnchors(next);
    },
    stop() {
      abort.abort();
      ready = null;
      void system.then((fish) => fish?.dispose());
    },
  };
}
