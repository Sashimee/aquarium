import type { User } from '@aquarium/shared';
import { publicPath, tokenFromPath } from '../sync/share';

const GALLERY_TANK_PREFIX = '/gallery/';
const TANK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function galleryTankIdFromPath(path: string): string | null {
  if (!path.startsWith(GALLERY_TANK_PREFIX)) return null;
  const id = path.slice(GALLERY_TANK_PREFIX.length);
  return TANK_ID.test(id) ? id.toLowerCase() : null;
}

export type Route =
  | { name: 'home' }
  | { name: 'sign-in' }
  | { name: 'sign-up' }
  | { name: 'verify-email'; error: string | null }
  | { name: 'forgot-password' }
  | { name: 'reset-password'; token: string | null; error: string | null }
  | { name: 'sessions' }
  | { name: 'settings' }
  | { name: 'privacy' }
  | { name: 'credits' }
  | { name: 'gallery' }
  | { name: 'gallery-tank'; id: string }
  | { name: 'public-tank'; token: string }
  | { name: 'not-found' };

export function parseRoute(href: string): Route {
  const url = new URL(href, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const token = tokenFromPath(path);
  if (token) return { name: 'public-tank', token };
  const galleryId = galleryTankIdFromPath(path);
  if (galleryId) return { name: 'gallery-tank', id: galleryId };
  switch (path) {
    case '/': {
      // Better Auth sends failed verifications to the bare callback root with ?error=.
      const error = url.searchParams.get('error');
      return error ? { name: 'verify-email', error } : { name: 'home' };
    }
    case '/sign-in':
      return { name: 'sign-in' };
    case '/sign-up':
      return { name: 'sign-up' };
    case '/sessions':
      return { name: 'sessions' };
    case '/settings':
      return { name: 'settings' };
    case '/privacy':
      return { name: 'privacy' };
    case '/credits':
      return { name: 'credits' };
    case '/gallery':
      return { name: 'gallery' };
    case '/forgot-password':
      return { name: 'forgot-password' };
    case '/reset-password':
      return {
        name: 'reset-password',
        token: url.searchParams.get('token'),
        error: url.searchParams.get('error'),
      };
    case '/verify-email':
      return { name: 'verify-email', error: url.searchParams.get('error') };
    default:
      return { name: 'not-found' };
  }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case 'home':
      return '/';
    case 'not-found':
      return '/';
    case 'public-tank':
      return publicPath(route.token);
    case 'gallery-tank':
      return `${GALLERY_TANK_PREFIX}${route.id}`;
    case 'verify-email':
      return route.error
        ? `/verify-email?error=${encodeURIComponent(route.error)}`
        : '/verify-email';
    case 'reset-password': {
      const params = new URLSearchParams();
      if (route.token) params.set('token', route.token);
      if (route.error) params.set('error', route.error);
      const query = params.toString();
      return query ? `/reset-password?${query}` : '/reset-password';
    }
    default:
      return `/${route.name}`;
  }
}

/** Signed-out visitors cannot reach account pages; signed-in users skip the entry forms. */
export function guardRoute(route: Route, user: User | null): Route {
  if ((route.name === 'sessions' || route.name === 'settings') && !user) return { name: 'sign-in' };
  if ((route.name === 'sign-in' || route.name === 'sign-up') && user) return { name: 'home' };
  return route;
}

function trimmedPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Where the address bar should go for `href`, or null when the route already matches its path.
 * Query parameters the router does not own (the engine's ?backend= and friends) and the hash
 * survive the move.
 */
export function redirectFor(href: string, user: User | null): string | null {
  const raw = parseRoute(href);
  if (raw.name === 'not-found') return null;
  const targetRoute = guardRoute(raw, user);
  const target = new URL(routePath(targetRoute), 'http://localhost');
  const url = new URL(href, 'http://localhost');
  if (trimmedPath(url.pathname) === target.pathname) return null;
  const params = new URLSearchParams(url.search);
  if (targetRoute.name !== 'verify-email' && targetRoute.name !== 'reset-password') {
    params.delete('error');
  }
  for (const [key, value] of target.searchParams) params.set(key, value);
  const query = params.toString();
  return target.pathname + (query ? `?${query}` : '') + url.hash;
}

/** Keeps the current query string on in-app navigation unless the destination brings its own. */
export function carryQuery(path: string, currentSearch: string): string {
  if (path.includes('?') || path.includes('#')) return path;
  const params = new URLSearchParams(currentSearch);
  params.delete('error');
  params.delete('token');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const NAVIGATE_EVENT = 'aquarium:navigate';

export function navigate(destination: string, replace = false, state: unknown = null): void {
  const path = carryQuery(destination, window.location.search);
  if (path === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(state, '', path);
  else window.history.pushState(state, '', path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function subscribeToLocation(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

export function currentHref(): string {
  return window.location.pathname + window.location.search;
}

/**
 * Kept in history.state, never the URL, so the share token stays out of address-bar and server logs.
 * Only a well-formed public tank path is honoured.
 */
export function returnPathFromState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('returnTo' in state)) return null;
  const { returnTo } = state;
  return typeof returnTo === 'string' && tokenFromPath(returnTo) !== null ? returnTo : null;
}

export function currentReturnPath(): string | null {
  return returnPathFromState(window.history.state);
}

export function leaveToViewerSignIn(path: string, destination = '/sign-in'): void {
  navigate(destination, false, { returnTo: path });
}

export function returnState(returnTo: string | null): { returnTo: string } | null {
  return returnTo === null ? null : { returnTo };
}

/** The viewer needs a full page load, so a return trip is a hard navigation. */
export function finishSignIn(returnTo: string | null): void {
  if (returnTo === null) {
    navigate('/');
    return;
  }
  window.location.assign(carryQuery(returnTo, window.location.search));
}
