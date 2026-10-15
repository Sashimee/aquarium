import type { EventBus } from '../engine/events';
import type { FocusTarget } from './camera';
import type { InteractionEvents } from './events';

export function followAnyFish(
  target: FocusTarget | null | undefined,
  focusOn: (target: FocusTarget) => void,
  interaction: Pick<EventBus<InteractionEvents>, 'emit'>,
): void {
  if (target) focusOn(target);
  else interaction.emit('camera:follow-unavailable', {});
}
