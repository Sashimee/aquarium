import type { User } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  guardRoute,
  isReadOnlyView,
  parseRoute,
  carryQuery,
  redirectFor,
  returnPathFromState,
  returnState,
  routePath,
} from './router';

const user: User = {
  id: 'u1',
  email: 'a@bas.lu',
  name: 'Ann',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('parseRoute', () => {
  it('maps known paths, ignoring trailing slashes', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/sign-in/')).toEqual({ name: 'sign-in' });
    expect(parseRoute('/sign-up')).toEqual({ name: 'sign-up' });
    expect(parseRoute('/sessions')).toEqual({ name: 'sessions' });
  });

  it('carries the verification error from the query string', () => {
    expect(parseRoute('/verify-email')).toEqual({ name: 'verify-email', error: null });
    expect(parseRoute('/verify-email?error=invalid_token')).toEqual({
      name: 'verify-email',
      error: 'invalid_token',
    });
  });

  it('falls back to not-found', () => {
    expect(parseRoute('/nope')).toEqual({ name: 'not-found' });
    expect(parseRoute('/sessions/extra')).toEqual({ name: 'not-found' });
    expect(parseRoute('/t/short')).toEqual({ name: 'not-found' });
  });
});

describe('routePath', () => {
  it('round-trips every route', () => {
    for (const href of [
      '/',
      '/sign-in',
      '/sign-up',
      '/sessions',
      '/verify-email',
      '/verify-email?error=x%20y',
    ]) {
      expect(parseRoute(routePath(parseRoute(href)))).toEqual(parseRoute(href));
    }
  });
});

describe('public tank route', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

  it('parses a share link and round-trips it', () => {
    expect(parseRoute(`/t/${token}`)).toEqual({ name: 'public-tank', token });
    expect(routePath({ name: 'public-tank', token })).toBe(`/t/${token}`);
  });

  it('is reachable signed in or out and is never redirected', () => {
    const route = parseRoute(`/t/${token}`);
    expect(guardRoute(route, null)).toEqual(route);
    expect(guardRoute(route, user)).toEqual(route);
    expect(redirectFor(`/t/${token}`, user)).toBeNull();
    expect(redirectFor(`/t/${token}/?backend=webgl`, null)).toBeNull();
  });
});

describe('return path after sign-in', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-';

  it('honours only a well-formed public tank path from history state', () => {
    expect(returnPathFromState({ returnTo: `/t/${token}` })).toBe(`/t/${token}`);
    expect(returnPathFromState({ returnTo: '/t/short' })).toBeNull();
    expect(returnPathFromState({ returnTo: 'https://evil.example/' })).toBeNull();
    expect(returnPathFromState({ returnTo: '//evil.example' })).toBeNull();
    expect(returnPathFromState({ returnTo: 5 })).toBeNull();
    expect(returnPathFromState({})).toBeNull();
    expect(returnPathFromState(null)).toBeNull();
  });

  it('carries the return path between sign-in and sign-up as history state', () => {
    expect(returnPathFromState(returnState(`/t/${token}`))).toBe(`/t/${token}`);
    expect(returnState(null)).toBeNull();
  });
});

describe('guardRoute', () => {
  it('sends signed-out visitors from sessions to sign-in', () => {
    expect(guardRoute({ name: 'sessions' }, null)).toEqual({ name: 'sign-in' });
    expect(guardRoute({ name: 'sessions' }, user)).toEqual({ name: 'sessions' });
  });
  it('sends signed-in users away from the entry forms', () => {
    expect(guardRoute({ name: 'sign-in' }, user)).toEqual({ name: 'home' });
    expect(guardRoute({ name: 'sign-up' }, user)).toEqual({ name: 'home' });
    expect(guardRoute({ name: 'sign-up' }, null)).toEqual({ name: 'sign-up' });
  });
  it('leaves the verification landing reachable either way', () => {
    expect(guardRoute({ name: 'verify-email', error: null }, user)).toEqual({
      name: 'verify-email',
      error: null,
    });
    expect(guardRoute({ name: 'verify-email', error: null }, null)).toEqual({
      name: 'verify-email',
      error: null,
    });
  });
});

describe('redirectFor', () => {
  it('moves a signed-out visitor from /sessions to /sign-in', () => {
    expect(redirectFor('/sessions', null)).toBe('/sign-in');
    expect(redirectFor('/sessions', user)).toBeNull();
  });
  it('moves a signed-in user from the entry forms to /', () => {
    expect(redirectFor('/sign-in', user)).toBe('/');
    expect(redirectFor('/sign-up', user)).toBe('/');
    expect(redirectFor('/sign-in', null)).toBeNull();
  });
  it('normalises failed verification redirects to the landing page', () => {
    expect(redirectFor('/?error=TOKEN_EXPIRED', null)).toBe('/verify-email?error=TOKEN_EXPIRED');
    expect(redirectFor('/verify-email?error=TOKEN_EXPIRED', null)).toBeNull();
  });
  it('leaves home and unknown paths alone', () => {
    expect(redirectFor('/', null)).toBeNull();
    expect(redirectFor('/', user)).toBeNull();
    expect(redirectFor('/nope', user)).toBeNull();
  });
  it('treats a trailing slash as the same URL', () => {
    expect(redirectFor('/sessions/', user)).toBeNull();
  });
});

describe('redirectFor query handling', () => {
  it('does not touch a URL whose route is already right, whatever its query', () => {
    expect(redirectFor('/?backend=webgl2&tier=low', null)).toBeNull();
    expect(redirectFor('/?backend=webgl2&tier=low', user)).toBeNull();
    expect(redirectFor('/sign-in?backend=webgl2', null)).toBeNull();
  });
  it('keeps engine options and the hash when the path changes', () => {
    expect(redirectFor('/sessions?backend=webgl2&tier=low#x', null)).toBe(
      '/sign-in?backend=webgl2&tier=low#x',
    );
    expect(redirectFor('/sign-up?adaptive=0', user)).toBe('/?adaptive=0');
  });
  it('keeps engine options when a failed verification is moved to the landing page', () => {
    expect(redirectFor('/?backend=webgl2&error=TOKEN_EXPIRED', null)).toBe(
      '/verify-email?backend=webgl2&error=TOKEN_EXPIRED',
    );
  });
});

describe('carryQuery', () => {
  it('carries the query to a bare path, minus the verification error', () => {
    expect(carryQuery('/', '?backend=webgl2&error=x')).toBe('/?backend=webgl2');
    expect(carryQuery('/sign-in', '')).toBe('/sign-in');
  });
  it('leaves destinations that bring their own query alone', () => {
    expect(carryQuery('/verify-email?error=x', '?backend=webgl2')).toBe('/verify-email?error=x');
  });
});

describe('password reset routes', () => {
  it('reads the token and the error from the reset link', () => {
    expect(parseRoute('/forgot-password')).toEqual({ name: 'forgot-password' });
    expect(parseRoute('/reset-password?token=abc')).toEqual({
      name: 'reset-password',
      token: 'abc',
      error: null,
    });
    expect(parseRoute('/reset-password?error=INVALID_TOKEN')).toEqual({
      name: 'reset-password',
      token: null,
      error: 'INVALID_TOKEN',
    });
  });

  it('keeps the error and token when the route is already right', () => {
    expect(redirectFor('/reset-password?error=INVALID_TOKEN', null)).toBeNull();
    expect(redirectFor('/reset-password?token=abc', user)).toBeNull();
    expect(redirectFor('/forgot-password', user)).toBeNull();
  });

  it('does not carry the reset token into other routes', () => {
    expect(carryQuery('/sign-in', '?token=abc&backend=webgl')).toBe('/sign-in?backend=webgl');
  });

  it('round-trips through routePath', () => {
    const route = { name: 'reset-password', token: 'a b', error: null } as const;
    expect(parseRoute(routePath(route))).toEqual(route);
  });
});

describe('gallery routes', () => {
  const id = '0b8f2c1e-5d3a-4f7e-9a61-2c4d8e0f1a37';

  it('parses the list and a tank and round-trips both', () => {
    expect(parseRoute('/gallery/')).toEqual({ name: 'gallery' });
    expect(parseRoute(`/gallery/${id}`)).toEqual({ name: 'gallery-tank', id });
    expect(routePath({ name: 'gallery' })).toBe('/gallery');
    expect(routePath({ name: 'gallery-tank', id })).toBe(`/gallery/${id}`);
  });

  it('treats only the shared-tank pages as read-only views, so they get no player session', () => {
    expect(isReadOnlyView(parseRoute(`/gallery/${id}`))).toBe(true);
    expect(isReadOnlyView(parseRoute(`/t/${'a'.repeat(43)}`))).toBe(true);
    expect(isReadOnlyView(parseRoute('/gallery'))).toBe(false);
    expect(isReadOnlyView(parseRoute('/'))).toBe(false);
  });

  it('returns to the gallery and a gallery tank after sign-in, but not to other pages', () => {
    expect(returnPathFromState({ returnTo: '/gallery' })).toBe('/gallery');
    expect(returnPathFromState({ returnTo: `/gallery/${id}` })).toBe(`/gallery/${id}`);
    expect(returnPathFromState({ returnTo: '/settings' })).toBeNull();
    expect(returnPathFromState({ returnTo: '/gallery/nope' })).toBeNull();
  });

  it('rejects a tank path that is not an id and is never redirected for anyone', () => {
    expect(parseRoute('/gallery/nope')).toEqual({ name: 'not-found' });
    expect(parseRoute(`/gallery/${id}/extra`)).toEqual({ name: 'not-found' });
    expect(redirectFor('/gallery', null)).toBeNull();
    expect(redirectFor(`/gallery/${id}`, null)).toBeNull();
  });
});
