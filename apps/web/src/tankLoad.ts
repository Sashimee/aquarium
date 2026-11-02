import type { EngineEvents, EventBus } from './engine/events';

export const TANK_LOAD_FAILED = 'The tank code failed to load. Reload the page to try again.';

/** Reports the real cause on the engine error path, then rejects with a message for the page. */
export function awaitTankModules<T>(tank: Promise<T>, events: EventBus<EngineEvents>): Promise<T> {
  return tank.catch((cause: unknown) => {
    events.emit('engine:error', { message: 'The tank code failed to load', cause });
    throw new Error(TANK_LOAD_FAILED, { cause });
  });
}

/** Both imports start before the first await, so the room code loads beside the tank code. */
export function awaitAppModules<T, R>(
  tank: Promise<T>,
  room: Promise<R>,
  events: EventBus<EngineEvents>,
): Promise<[T, R]> {
  return awaitTankModules(Promise.all([tank, room]), events);
}
