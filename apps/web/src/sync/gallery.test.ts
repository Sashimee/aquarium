import type { GalleryEntry, GalleryResponse, GalleryWinner } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../ui/api';
import {
  entryWithVote,
  galleryLoadMessage,
  galleryToggle,
  showcase,
  voteLabel,
  voteProblem,
  voteProblemText,
  voteTarget,
  weekLabel,
  withVote,
} from './gallery';

const A = '0b8f2c1e-5d3a-4f7e-9a61-2c4d8e0f1a37';
const B = '1c9f3d2f-6e4b-4a8f-8b72-3d5e9f1a2b48';

function entry(id: string, over: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    id,
    name: id === A ? 'Reef' : 'Pond',
    biome: 'freshwater',
    size: 'medium',
    backgroundId: 'none',
    fishCount: 3,
    votes: 0,
    mine: false,
    voted: false,
    ...over,
  } as GalleryEntry;
}

function gallery(entries: GalleryEntry[], myVote: string | null = null): GalleryResponse {
  return {
    weekStart: '2026-02-02T00:00:00.000Z',
    weekEnd: '2026-02-09T00:00:00.000Z',
    total: entries.length,
    entries,
    myVote,
  };
}

const err = (status: number, code: ApiRequestError['code'], retry: number | null = null) =>
  new ApiRequestError(status, code, `${code} message`, {}, retry);

describe('galleryToggle', () => {
  it('needs the public link first: a link alone never lists a tank', () => {
    expect(galleryToggle({ shared: false, quarantine: false, inGallery: false })).toEqual({
      kind: 'needs-link',
    });
    expect(galleryToggle({ shared: true, quarantine: false, inGallery: false })).toEqual({
      kind: 'available',
      listed: false,
    });
  });

  it('blocks a quarantine tank from joining, but lets a listed one leave', () => {
    expect(galleryToggle({ shared: true, quarantine: true, inGallery: false })).toEqual({
      kind: 'quarantine',
    });
    expect(galleryToggle({ shared: true, quarantine: true, inGallery: true })).toEqual({
      kind: 'available',
      listed: true,
    });
  });
});

describe('vote state', () => {
  it('takes the vote back when the same tank is pressed again', () => {
    expect(voteTarget(null, A)).toBe(A);
    expect(voteTarget(B, A)).toBe(A);
    expect(voteTarget(A, A)).toBeNull();
  });

  it('moves the single vote from the old pick to the new one', () => {
    const before = gallery([entry(A, { votes: 2, voted: true }), entry(B, { votes: 1 })], A);
    const after = withVote(before, B);
    expect(after.myVote).toBe(B);
    expect(after.entries.map((e) => [e.votes, e.voted])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('removes the vote without going below zero', () => {
    const before = gallery([entry(A, { votes: 0, voted: true })], A);
    expect(withVote(before, null).entries[0]).toMatchObject({ votes: 0, voted: false });
    expect(entryWithVote(entry(A, { votes: 1 }), A)).toMatchObject({ votes: 2, voted: true });
  });

  it('labels the button for the vote, the take-back and the owner', () => {
    expect(voteLabel(entry(A, { votes: 1 }))).toBe('Vote for Reef, 1 vote');
    expect(voteLabel(entry(A, { votes: 3, voted: true }))).toBe(
      'Take back your vote for Reef, 3 votes',
    );
    expect(voteLabel(entry(A, { mine: true }))).toBe('Reef, your tank, 0 votes');
  });
});

describe('vote errors', () => {
  it.each([
    [err(401, 'unauthenticated'), 'Sign in to vote for a tank.'],
    [err(403, 'email_not_verified'), 'Verify your email address to vote.'],
    [err(403, 'own_tank'), 'This is your own tank, so you cannot vote for it.'],
    [err(404, 'not_found'), 'This tank has left the gallery. Pick another one.'],
    [err(409, 'conflict'), 'Your vote could not be changed right now. conflict message'],
    [err(429, 'rate_limited', 30), 'You are voting too fast. Try again in 30 seconds.'],
    [err(429, 'rate_limited'), 'You are voting too fast. Try again in a moment.'],
    [err(500, 'internal'), 'internal message'],
    [new Error('boom'), 'Your vote was not saved. Try again.'],
  ] as const)('explains %#', (error, text) => {
    expect(voteProblemText(voteProblem(error))).toBe(text);
  });

  it('explains load failures', () => {
    expect(galleryLoadMessage(err(429, 'rate_limited', 9))).toContain('9 seconds');
    expect(galleryLoadMessage(err(429, 'rate_limited'))).toContain('a minute');
    expect(galleryLoadMessage(err(404, 'not_found'))).toBe(
      'This tank is not in the gallery any more.',
    );
    expect(galleryLoadMessage(new Error('x'))).toContain('could not be loaded');
  });
});

describe('showcase', () => {
  const winner = (id: string, weekStart: string): GalleryWinner =>
    ({
      ...entry(id),
      weekStart,
      weekEnd: weekStart,
      votes: 4,
    }) as GalleryWinner;

  it('shows the leader and the newest winner, keeping the rest as earlier', () => {
    const result = showcase(gallery([entry(A, { votes: 2 }), entry(B, { votes: 1 })]), [
      winner(B, '2026-01-26T00:00:00.000Z'),
      winner(A, '2026-01-19T00:00:00.000Z'),
    ]);
    expect(result.current?.id).toBe(A);
    expect(result.last?.id).toBe(B);
    expect(result.earlier.map((w) => w.id)).toEqual([A]);
  });

  it('has no leader before any vote and no winner before a week has settled', () => {
    expect(showcase(gallery([entry(A)]), [])).toEqual({ current: null, last: null, earlier: [] });
    expect(showcase(gallery([]), [])).toEqual({ current: null, last: null, earlier: [] });
  });
});

describe('weekLabel', () => {
  it('names the Monday to Sunday span in UTC', () => {
    expect(weekLabel('2026-02-02T00:00:00.000Z', '2026-02-09T00:00:00.000Z')).toBe(
      'Feb 2 to Feb 8',
    );
  });
});
