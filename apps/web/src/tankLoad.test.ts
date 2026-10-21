import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from './engine/events';
import { awaitTankModules, ROOM_LOAD_FAILED, TANK_LOAD_FAILED } from './tankLoad';

function recordErrors() {
  const events = new EventBus<EngineEvents>();
  const errors: EngineEvents['engine:error'][] = [];
  events.on('engine:error', (error) => errors.push(error));
  return { events, errors };
}

describe('awaitTankModules', () => {
  it('passes the modules through and reports nothing when the import succeeds', async () => {
    const { events, errors } = recordErrors();
    const modules = { Engine: 'engine' };
    await expect(awaitTankModules(Promise.resolve(modules), events)).resolves.toBe(modules);
    expect(errors).toEqual([]);
  });

  it('reports the real cause and rejects with a reload hint when the import fails', async () => {
    const { events, errors } = recordErrors();
    const cause = new TypeError(
      'Failed to fetch dynamically imported module: https://devfish.bas.lu/assets/tank-old.js',
    );
    const rejection = awaitTankModules(Promise.reject(cause), events);
    await expect(rejection).rejects.toThrow(TANK_LOAD_FAILED);
    await expect(rejection).rejects.toMatchObject({ cause });
    expect(errors).toEqual([{ message: 'The tank code failed to load', cause }]);
  });

  it('reports a non-Error rejection as it was thrown', async () => {
    const { events, errors } = recordErrors();
    await expect(awaitTankModules(Promise.reject('offline'), events)).rejects.toMatchObject({
      message: TANK_LOAD_FAILED,
      cause: 'offline',
    });
    expect(errors).toEqual([{ message: 'The tank code failed to load', cause: 'offline' }]);
  });

  it('names the room when the room import fails', async () => {
    const { events, errors } = recordErrors();
    const cause = new TypeError('Failed to fetch dynamically imported module');
    await expect(awaitTankModules(Promise.reject(cause), events, 'room')).rejects.toThrow(
      ROOM_LOAD_FAILED,
    );
    expect(errors).toEqual([{ message: 'The room code failed to load', cause }]);
  });
});
