import type { Engine } from '../../engine/Engine';
import { RoomBackdrop } from './RoomBackdrop';
import type { RoomPreference } from './preference';

export interface MountedRoom {
  readonly backdrop: RoomBackdrop;
  dispose(): void;
}

/**
 * Shows the room the preference names behind the engine's tank and keeps it fitted to the tank's
 * size and the quality tier. Choosing `none` removes it. `seed` varies the books.
 */
export function mountRoom(engine: Engine, preference: RoomPreference, seed?: number): MountedRoom {
  const backdrop = new RoomBackdrop();
  engine.scene.add(backdrop.group);
  const refresh = () =>
    backdrop.update({
      choice: preference.snapshot(),
      tank: engine.tank.dimensions,
      tier: engine.quality.tier,
      ...(seed === undefined ? {} : { seed }),
    });
  refresh();
  const offs = [
    preference.subscribe(refresh),
    engine.events.on('engine:tank-resized', refresh),
    engine.events.on('quality:tier-changed', refresh),
  ];
  return {
    backdrop,
    dispose() {
      for (const off of offs) off();
      backdrop.dispose();
    },
  };
}
