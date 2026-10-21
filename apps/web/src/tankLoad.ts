import type { EngineEvents, EventBus } from './engine/events';

export const TANK_LOAD_FAILED = 'The tank code failed to load. Reload the page to try again.';
export const ROOM_LOAD_FAILED = 'The room code failed to load. Reload the page to try again.';

/** Reports the real cause on the engine error path, then rejects with a message for the page. */
export function awaitTankModules<T>(
  tank: Promise<T>,
  events: EventBus<EngineEvents>,
  part: 'tank' | 'room' = 'tank',
): Promise<T> {
  return tank.catch((cause: unknown) => {
    events.emit('engine:error', { message: `The ${part} code failed to load`, cause });
    throw new Error(part === 'room' ? ROOM_LOAD_FAILED : TANK_LOAD_FAILED, { cause });
  });
}

const settled = <T>(result: PromiseSettledResult<T>): Promise<T> =>
  result.status === 'fulfilled' ? Promise.resolve(result.value) : Promise.reject(result.reason);

/** Loads both bundles together and reports only the first failure, tank before room. */
export async function awaitAppModules<T, R>(
  tank: Promise<T>,
  room: Promise<R>,
  events: EventBus<EngineEvents>,
): Promise<[T, R]> {
  const [tankResult, roomResult] = await Promise.allSettled([tank, room]);
  const loadedTank = await awaitTankModules(settled(tankResult), events);
  const loadedRoom = await awaitTankModules(settled(roomResult), events, 'room');
  return [loadedTank, loadedRoom];
}
