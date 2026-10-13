import type { Stimulus } from '@aquarium/sim';
import type { Engine } from '../engine/Engine';
import type { TankDimensions } from '../engine/tank/dimensions';
import type { FishSystem } from './FishSystem';

export interface DemoFish {
  /** Forwards to the sim once the school is up; stimuli before that are dropped. */
  readonly sim: { startle(stimulus: Stimulus): void };
  stop(): void;
}

/**
 * Starts the demo school without blocking boot. The fish code (loaders, sim client) is a separate
 * chunk, since nothing swims before the models arrive anyway.
 */
export function startDemoFish(engine: Engine, tank: TankDimensions, assetRoot: string): DemoFish {
  const abort = new AbortController();
  let ready: FishSystem | null = null;
  const system = import('./FishSystem')
    .then(({ FishSystem }) => FishSystem.create(engine, { tank, assetRoot, signal: abort.signal }))
    .then((fish) => {
      if (!abort.signal.aborted) ready = fish;
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
    stop() {
      abort.abort();
      ready = null;
      void system.then((fish) => fish?.dispose());
    },
  };
}
