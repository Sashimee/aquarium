import type { User } from '@aquarium/shared';

export type Route =
  | { name: 'home' }
  | { name: 'sign-in' }
  | { name: 'sign-up' }
  | { name: 'verify-email'; error: string | null }
  | { name: 'sessions' }
  | { name: 'not-found' };

export function parseRoute(href: string): Route {
  const url = new URL(href, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
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
    case 'verify-email':
      return route.error
        ? `/verify-email?error=${encodeURIComponent(route.error)}`
        : '/verify-email';
    default:
      return `/${route.name}`;
  }
}

/** Signed-out visitors cannot reach account pages; signed-in users skip the entry forms. */
export function guardRoute(route: Route, user: User | null): Route {
  if (route.name === 'sessions' && !user) return { name: 'sign-in' };
  if ((route.name === 'sign-in' || route.name === 'sign-up') && user) return { name: 'home' };
  return route;
}

function canonicalHref(href: string): string {
  const url = new URL(href, 'http://localhost');
  return (url.pathname.replace(/\/+$/, '') || '/') + url.search;
}

/** The URL the address bar should show for `href`, or null when it already does. */
export function redirectFor(href: string, user: User | null): string | null {
  const raw = parseRoute(href);
  if (raw.name === 'not-found') return null;
  const target = routePath(guardRoute(raw, user));
  return target === canonicalHref(href) ? null : target;
}

const NAVIGATE_EVENT = 'aquarium:navigate';

export function navigate(path: string, replace = false): void {
  if (path === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
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
