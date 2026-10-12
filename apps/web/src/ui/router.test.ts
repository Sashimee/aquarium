import type { User } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { guardRoute, parseRoute, redirectFor, routePath } from './router';

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
