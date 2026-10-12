import type { Engine } from '../engine/Engine';
import type { TankDimensions } from '../engine/tank/dimensions';

/**
 * Starts the demo school without blocking boot. The fish code (loaders, sim client) is a separate
 * chunk, since nothing swims before the models arrive anyway. Returns the teardown.
 */
export function startDemoFish(engine: Engine, tank: TankDimensions, assetRoot: string): () => void {
  const abort = new AbortController();
  const system = import('./FishSystem')
    .then(({ FishSystem }) => FishSystem.create(engine, { tank, assetRoot, signal: abort.signal }))
    .catch((cause: unknown) => {
      if (!abort.signal.aborted) {
        engine.events.emit('engine:error', { message: 'Fish failed to start', cause });
      }
      return null;
    });
  return () => {
    abort.abort();
    void system.then((fish) => fish?.dispose());
  };
}
