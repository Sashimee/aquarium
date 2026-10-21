import type { GalleryEntry, GalleryResponse, GalleryWinner, Tank } from '@aquarium/shared';
import { ApiRequestError } from '../ui/api';

export type GalleryToggle =
  { kind: 'needs-link' } | { kind: 'quarantine' } | { kind: 'available'; listed: boolean };

/** Listing is a second opt-in on top of the link: a share link alone never lists a tank. */
export function galleryToggle(
  tank: Pick<Tank, 'shared' | 'quarantine' | 'inGallery'>,
): GalleryToggle {
  if (!tank.shared) return { kind: 'needs-link' };
  if (tank.quarantine && !tank.inGallery) return { kind: 'quarantine' };
  return { kind: 'available', listed: tank.inGallery };
}

export type VoteProblem =
  | { kind: 'sign-in' }
  | { kind: 'verify' }
  | { kind: 'own' }
  | { kind: 'gone' }
  | { kind: 'conflict'; message: string }
  | { kind: 'slow'; seconds: number | null }
  | { kind: 'failed'; message: string };

export function voteProblem(error: unknown): VoteProblem {
  if (!(error instanceof ApiRequestError)) {
    return { kind: 'failed', message: 'Your vote was not saved. Try again.' };
  }
  switch (error.status) {
    case 401:
      return { kind: 'sign-in' };
    case 403:
      if (error.code === 'email_not_verified') return { kind: 'verify' };
      return error.code === 'own_tank'
        ? { kind: 'own' }
        : { kind: 'failed', message: error.message };
    case 404:
      return { kind: 'gone' };
    case 409:
      return { kind: 'conflict', message: error.message };
    case 429:
      return { kind: 'slow', seconds: error.retryAfterSeconds };
    default:
      return { kind: 'failed', message: error.message };
  }
}

export function voteProblemText(problem: VoteProblem): string {
  switch (problem.kind) {
    case 'sign-in':
      return 'Sign in to vote for a tank.';
    case 'verify':
      return 'Verify your email address to vote.';
    case 'own':
      return 'This is your own tank, so you cannot vote for it.';
    case 'gone':
      return 'This tank has left the gallery. Pick another one.';
    case 'conflict':
      return `Your vote could not be changed right now. ${problem.message}`;
    case 'slow':
      return problem.seconds
        ? `You are voting too fast. Try again in ${problem.seconds} seconds.`
        : 'You are voting too fast. Try again in a moment.';
    case 'failed':
      return problem.message;
  }
}

export function galleryLoadMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 429) {
    return error.retryAfterSeconds
      ? `Too many people are looking right now. Try again in ${error.retryAfterSeconds} seconds.`
      : 'Too many people are looking right now. Try again in a minute.';
  }
  if (error instanceof ApiRequestError && error.status === 404) {
    return 'This tank is not in the gallery any more.';
  }
  return error instanceof ApiRequestError
    ? error.message
    : 'The gallery could not be loaded. Try again in a moment.';
}

/** Voting for the tank you already picked takes the vote back. */
export function voteTarget(myVote: string | null, pressed: string): string | null {
  return myVote === pressed ? null : pressed;
}

/** One vote per week: moving it takes a vote off the old pick and puts it on the new one. */
export function entryWithVote(entry: GalleryEntry, myVote: string | null): GalleryEntry {
  const now = entry.id === myVote;
  return {
    ...entry,
    voted: now,
    votes: Math.max(0, entry.votes + (now ? 1 : 0) - (entry.voted ? 1 : 0)),
  };
}

export function withVote(gallery: GalleryResponse, myVote: string | null): GalleryResponse {
  return { ...gallery, myVote, entries: gallery.entries.map((e) => entryWithVote(e, myVote)) };
}

export function votesText(votes: number): string {
  return `${votes} ${votes === 1 ? 'vote' : 'votes'}`;
}

export function voteLabel(entry: Pick<GalleryEntry, 'name' | 'voted' | 'mine' | 'votes'>): string {
  const count = votesText(entry.votes);
  if (entry.mine) return `${entry.name}, your tank, ${count}`;
  return entry.voted
    ? `Take back your vote for ${entry.name}, ${count}`
    : `Vote for ${entry.name}, ${count}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function weekLabel(weekStart: string, weekEnd: string): string {
  const lastDay = new Date(Date.parse(weekEnd) - 1);
  return `${DAY_FORMAT.format(new Date(weekStart))} to ${DAY_FORMAT.format(lastDay)}`;
}

export interface Showcase {
  current: GalleryEntry | null;
  last: GalleryWinner | null;
  earlier: GalleryWinner[];
}

/**
 * "Current" is the tank leading this week's vote; "last" is the newest settled winner, which the
 * server lists first. A week with no votes has no leader.
 */
export function showcase(gallery: GalleryResponse, winners: readonly GalleryWinner[]): Showcase {
  const leader = gallery.entries[0];
  const [last, ...earlier] = winners;
  return { current: leader && leader.votes > 0 ? leader : null, last: last ?? null, earlier };
}
