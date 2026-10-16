const VERSION = 'v1';
const SHELL_CACHE = `aquarium-shell-${VERSION}`;
const ASSET_CACHE = `aquarium-assets-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const SHELL = [
  OFFLINE_URL,
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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
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

async function navigate(request) {
  try {
    return await fetch(request);
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
    event.respondWith(navigate(request));
  } else if (HASHED_ASSET.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(shell(request));
  }
});
