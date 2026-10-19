import type { Achievement, Collection } from '@aquarium/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiRequestError, createApiClient } from './api';
import { CollectionBody, type BookState } from './CollectionBook';
import {
  achievementRow,
  collectionErrorMessage,
  collectionSummary,
  formatDay,
  speciesCard,
} from './collectionBook';

const collection: Collection = {
  species: [
    {
      species: 'neon-tetra',
      commonName: 'Neon tetra',
      biome: 'freshwater',
      entry: {
        species: 'neon-tetra',
        keptAt: '2026-03-02T23:30:00.000Z',
        bredAt: '2026-04-10T08:00:00.000Z',
        raisedAt: null,
      },
    },
    { species: 'hidden-angelfish', commonName: 'Hidden angel', biome: 'reef', entry: null },
  ],
  kept: 1,
  bred: 1,
  raised: 0,
  total: 2,
};

const achievement = (over: Partial<Achievement>): Achievement => ({
  id: 'first-fish',
  title: 'First fish',
  description: 'Keep your first fish.',
  earnedAt: null,
  progress: 0,
  target: 1,
  ...over,
});

const ready = (): BookState => ({
  status: 'ready',
  collection,
  achievements: {
    achievements: [
      achievement({ earnedAt: '2026-03-02T23:30:00.000Z', progress: 1 }),
      achievement({ id: 'kept-5', title: 'Hobbyist', progress: 2, target: 5 }),
    ],
  },
});

const noop = () => undefined;
const render = (state: BookState, tab: 'species' | 'achievements' = 'species') =>
  renderToStaticMarkup(
    createElement(CollectionBody, { state, tab, onTab: noop, onRetry: noop, onClose: noop }),
  );

describe('collection helpers', () => {
  it('formats dates in UTC so the day does not depend on the viewer', () => {
    expect(formatDay('2026-03-02T23:30:00.000Z')).toBe('2 Mar 2026');
  });

  it('shows a found species with its dates and a locked one without its name', () => {
    const [found, locked] = collection.species.map(speciesCard);
    expect(found).toMatchObject({
      kind: 'found',
      name: 'Neon tetra',
      keptOn: '2 Mar 2026',
      milestones: ['Bred 10 Apr 2026'],
    });
    expect(locked).toEqual({ kind: 'locked', species: 'hidden-angelfish', biome: 'reef' });
  });

  it('describes progress and earned state', () => {
    expect(achievementRow(achievement({ progress: 2, target: 5 }))).toMatchObject({
      earned: false,
      earnedOn: null,
      progressText: '2 of 5',
    });
    expect(
      achievementRow(achievement({ earnedAt: '2026-05-01T00:00:00.000Z', progress: 1 })),
    ).toMatchObject({ earned: true, earnedOn: '1 May 2026', progressText: 'Done' });
  });

  it('summarises the totals', () => {
    expect(collectionSummary(collection)).toBe('1 of 2 species kept, 1 bred, 0 raised to adult.');
  });

  it('turns API failures into actionable text', () => {
    expect(
      collectionErrorMessage(new ApiRequestError(401, 'unauthenticated', 'Sign in required.')),
    ).toContain('Sign in');
    expect(collectionErrorMessage(new ApiRequestError(403, 'email_not_verified', 'x'))).toContain(
      'Verify',
    );
    expect(collectionErrorMessage(new ApiRequestError(429, 'rate_limited', 'x', {}, 30))).toContain(
      '30 s',
    );
    expect(collectionErrorMessage(new ApiRequestError(500, 'internal', 'Server broke.'))).toBe(
      'Server broke.',
    );
    expect(collectionErrorMessage(new TypeError('fetch failed'))).toContain('try again');
  });
});

describe('CollectionBody', () => {
  it('announces loading', () => {
    expect(render({ status: 'loading' })).toContain('role="status"');
  });

  it('fails visibly with a retry', () => {
    const html = render({ status: 'error', message: 'Nope.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Nope.');
    expect(html).toContain('Try again');
  });

  it('lists species with a locked silhouette that hides the name', () => {
    const html = render(ready());
    expect(html).toContain('Neon tetra');
    expect(html).toContain('First kept 2 Mar 2026');
    expect(html).toContain('data-state="locked"');
    expect(html).not.toContain('Hidden angel');
    expect(html).not.toContain('hidden-angelfish');
    expect(html).toContain('class="book"');
  });

  it('lists achievements with earned date and progress', () => {
    const html = render(ready(), 'achievements');
    expect(html).toContain('Earned 2 Mar 2026');
    expect(html).toContain('2 of 5');
    expect(html).toContain('data-earned="true"');
  });
});

describe('api collection client', () => {
  it('reads the collection and rejects an unreadable achievements body', async () => {
    const api = createApiClient(
      async () => new Response(JSON.stringify(collection), { status: 200 }),
    );
    await expect(api.collection()).resolves.toMatchObject({ total: 2 });
    await expect(api.achievements()).rejects.toMatchObject({ code: 'unexpected_response' });
  });

  it('surfaces the 401 envelope', async () => {
    const body = JSON.stringify({
      error: { code: 'unauthenticated', message: 'Sign in required.' },
    });
    const api = createApiClient(async () => new Response(body, { status: 401 }));
    await expect(api.collection()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });
});
