// Replaced at build time with a hash of the bundle names and every precached file (build/sw-build-id-plugin.ts),
// so every deploy gets fresh caches and activate drops the old ones.
const BUILD_ID = '__BUILD_ID__';
const SHELL_CACHE = `aquarium-shell-${BUILD_ID}`;
const ASSET_CACHE = `aquarium-assets-${BUILD_ID}`;
const OFFLINE_URL = '/offline.html';
const SHELL = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
// Vite emits content-hashed bundles flat in /assets/; models and textures sit in subdirectories
// under stable names and are left to the HTTP cache.
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

function isApi(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// skipWaiting + claim + dropping old caches means open tabs of the previous build lose their
// cached bundles; they fall back to the network, which still serves the old hashed files until
// the deploy replaces them. Fresh code beats waiting for every tab to close.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.resolve(self.registration.navigationPreload?.enable())
      .then(() => caches.keys())
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function navigate(event) {
  try {
    return (await event.preloadResponse) ?? (await fetch(event.request));
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(OFFLINE_URL)) ?? Response.error();
  }
}

async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match(request)) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApi(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event));
  } else if (HASHED_ASSET.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(shell(request));
  }
});

// The server sends no payload, so nothing about the tank leaves it; the text here is fixed.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Your fish are hungry', {
      body: 'It has been a while since the last feeding. Tap to check on your tank.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'care-reminder',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const onTank = windows.find((client) => new URL(client.url).pathname === '/');
      const open = onTank ?? windows[0];
      if (!open) return self.clients.openWindow('/');
      if (onTank) return open.focus();
      // Navigating is refused for tabs this worker does not control, so fall back to a new tab.
      const moved = await open.navigate('/').catch(() => null);
      return moved ? moved.focus() : self.clients.openWindow('/');
    }),
  );
});
