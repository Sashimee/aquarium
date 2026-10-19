import {
  shareTokenSchema,
  type Fish,
  type PublicFish,
  type PublicTank,
  type ReactionKind,
  type Tank,
} from '@aquarium/shared';
import type { InteractionEvents } from '../interaction/events';
import { ApiRequestError } from '../ui/api';
import { bundledCommonName } from './bundledSpecies';

export const PUBLIC_PATH_PREFIX = '/t/';

export function publicPath(token: string): string {
  return `${PUBLIC_PATH_PREFIX}${token}`;
}

export function publicUrl(origin: string, token: string): string {
  return `${origin}${publicPath(token)}`;
}

/** The token in `/t/<token>`, or null when the path is not a well-formed share link. */
export function tokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PUBLIC_PATH_PREFIX)) return null;
  const token = pathname.slice(PUBLIC_PATH_PREFIX.length).replace(/\/+$/, '');
  return shareTokenSchema.safeParse(token).success ? token : null;
}

export type ShareView =
  { kind: 'private' } | { kind: 'fresh'; token: string } | { kind: 'link-hidden' };

/**
 * The server only returns the token from the call that created or rotated it, so a shared tank
 * without a token in hand is one whose link nobody can read back: it has to be rotated.
 */
export function shareView(tank: Pick<Tank, 'shared'>, issuedToken: string | null): ShareView {
  if (!tank.shared) return { kind: 'private' };
  return issuedToken ? { kind: 'fresh', token: issuedToken } : { kind: 'link-hidden' };
}

export type ViewerPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; tank: PublicTank }
  | { kind: 'missing' }
  | { kind: 'throttled'; retryAfterSeconds: number | null }
  | { kind: 'failed'; message: string };

export function viewerFailure(error: unknown): ViewerPhase {
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return { kind: 'missing' };
    if (error.status === 429) {
      return { kind: 'throttled', retryAfterSeconds: error.retryAfterSeconds };
    }
    return { kind: 'failed', message: error.message };
  }
  return { kind: 'failed', message: 'This tank could not be loaded. Try again in a moment.' };
}

export function slowDownMessage(seconds: number | null): string {
  return seconds
    ? `Too many people are looking right now. Try again in ${seconds} seconds.`
    : 'Too many people are looking right now. Try again in a minute.';
}

export const MISSING_MESSAGE =
  'This tank is not shared any more, or the link is wrong. Ask the owner for a new link.';

export type ReactionProblem =
  | { kind: 'sign-in' }
  | { kind: 'verify' }
  | { kind: 'own' }
  | { kind: 'gone' }
  | { kind: 'slow'; seconds: number | null }
  | { kind: 'failed'; message: string };

export function reactionProblem(error: unknown): ReactionProblem {
  if (!(error instanceof ApiRequestError)) {
    return { kind: 'failed', message: 'The reaction was not saved. Try again.' };
  }
  switch (error.status) {
    case 401:
      return { kind: 'sign-in' };
    case 403:
      if (error.code === 'email_not_verified') return { kind: 'verify' };
      // The API uses one 'forbidden' code for both the own-tank and the cross-origin refusal.
      return error.code === 'forbidden' && /own tank/i.test(error.message)
        ? { kind: 'own' }
        : { kind: 'failed', message: error.message };
    case 404:
      return { kind: 'gone' };
    case 429:
      return { kind: 'slow', seconds: error.retryAfterSeconds };
    default:
      return { kind: 'failed', message: error.message };
  }
}

export function reactionProblemText(problem: ReactionProblem): string {
  switch (problem.kind) {
    case 'sign-in':
      return 'Sign in to react to this tank.';
    case 'verify':
      return 'Verify your email address to react to tanks.';
    case 'own':
      return 'This is your own tank, so you cannot react to it.';
    case 'gone':
      return MISSING_MESSAGE;
    case 'slow':
      return problem.seconds
        ? `You are reacting too fast. Try again in ${problem.seconds} seconds.`
        : 'You are reacting too fast. Try again in a moment.';
    case 'failed':
      return problem.message;
  }
}

/** Pressing your current reaction takes it back; anything else sets it. */
export function reactionTarget(
  current: ReactionKind | null,
  pressed: ReactionKind,
): ReactionKind | null {
  return current === pressed ? null : pressed;
}

export const REACTION_LABEL: Record<ReactionKind, string> = {
  heart: 'Heart',
  star: 'Star',
  wow: 'Wow',
};

export function reactionButtonName(kind: ReactionKind, count: number, mine: boolean): string {
  const noun = count === 1 ? 'reaction' : 'reactions';
  return `${REACTION_LABEL[kind]}, ${count} ${noun}${mine ? ', your choice' : ''}`;
}

export function publicTankId(tank: Pick<PublicTank, 'seed'>): string {
  return `public:${tank.seed.toString(16)}`;
}

/** Visitors get fish without ids; the stable per-fish seed stands in so the sim keeps them apart. */
export function publicFishAsFish(tank: Pick<PublicTank, 'seed'>, fish: PublicFish): Fish {
  return {
    ...fish,
    id: `public:${fish.seed.toString(16)}`,
    tankId: publicTankId(tank),
  };
}

export function publicTankLoaded(tank: PublicTank): InteractionEvents['tank:loaded'] {
  return {
    tankId: publicTankId(tank),
    biome: tank.biome,
    fish: tank.fish.map((f) => publicFishAsFish(tank, f)),
    decorLayout: tank.decorLayout,
    decorEdited: tank.decorLayout.length > 0,
  };
}

export function publicReportLines(tank: PublicTank): string[] {
  const living = tank.fish.filter((f) => f.status === 'alive');
  const dead = tank.fish.filter((f) => f.status === 'dead');
  const lines = [
    `${tank.name}, a shared ${tank.biome} tank. You can look, but not change anything.`,
    living.length === 0
      ? 'No fish are alive in this tank.'
      : `${living.length} fish alive: ${living
          .map((f) => `${f.name} the ${bundledCommonName(f.species)}`)
          .join('; ')}.`,
  ];
  if (dead.length > 0) {
    lines.push(`${dead.map((f) => f.name).join(', ')} ${dead.length === 1 ? 'has' : 'have'} died.`);
  }
  return lines;
}
