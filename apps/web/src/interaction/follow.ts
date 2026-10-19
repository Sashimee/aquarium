import type { EventBus } from '../engine/events';
import type { FocusTarget, Vec3 } from './camera';
import type { InteractionEvents } from './events';

export function followAnyFish(
  target: FocusTarget | null | undefined,
  focusOn: (target: FocusTarget) => void,
  interaction: Pick<EventBus<InteractionEvents>, 'emit'>,
): void {
  if (target) focusOn(target);
  else interaction.emit('camera:follow-unavailable', {});
}

/**
 * Follows the centre of the `fishIds` that can be seen each frame; null when none can be seen now.
 * The point is reused, as the camera copies it.
 */
export function broodTarget(
  fishIds: readonly string[],
  pointOf: (fishId: string) => Vec3 | null | undefined,
): FocusTarget | null {
  const centre = { x: 0, y: 0, z: 0 };
  const target = (): Vec3 | null => {
    let n = 0;
    centre.x = centre.y = centre.z = 0;
    for (const id of fishIds) {
      const p = pointOf(id);
      if (!p) continue;
      centre.x += p.x;
      centre.y += p.y;
      centre.z += p.z;
      n++;
    }
    if (n === 0) return null;
    centre.x /= n;
    centre.y /= n;
    centre.z /= n;
    return centre;
  };
  return target() ? target : null;
}
