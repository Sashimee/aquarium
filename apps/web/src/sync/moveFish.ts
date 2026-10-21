import type { Fish, Tank } from '@aquarium/shared';
import { ApiRequestError } from '../ui/api';

/** Quarantine tanks send fish out to display tanks, and display tanks send them to quarantine. */
export function moveTargets(from: Tank, tanks: readonly Tank[]): Tank[] {
  return tanks.filter((t) => t.id !== from.id && t.quarantine !== from.quarantine);
}

export function movableFish(tank: Tank): Fish[] {
  return tank.fish.filter((f) => f.status === 'alive');
}

/** Text for a refused move, or null when the failure is not a refusal the player can act on. */
export function moveRefusalText(error: unknown, fishName: string, tankName: string): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'rate_limited') {
    return error.retryAfterSeconds === null
      ? 'Too many moves in a short time. Wait a moment and try again.'
      : `Too many moves in a short time. Try again in ${error.retryAfterSeconds} seconds.`;
  }
  if (error.status !== 409) return null;
  switch (error.reason) {
    case 'fish_dead':
      return `${fishName} has died, so it cannot be moved. Net it from the tank instead.`;
    case 'wrong_biome':
      return `${fishName} cannot live in ${tankName}: it is a different kind of water.`;
    case 'tank_full':
      return `${tankName} has no room for ${fishName}. Make space there or pick another tank.`;
    case 'key_reused':
      return 'That move clashed with an earlier one. Press the button again to move the fish.';
    default:
      return error.message;
  }
}
