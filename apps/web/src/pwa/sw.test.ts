import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildId,
  buildIdForOutput,
  emittedPaths,
  shellPaths,
  stampWorker,
} from '../../build/sw-build-id-plugin';

const BUILD = 'abc123';
const RAW_SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const EMITTED = ['/assets/index-C7vUOBtl.js'];
const SOURCE = stampWorker(RAW_SOURCE, BUILD, EMITTED);
const ORIGIN = 'https://fish.test';

type Listener = (event: unknown) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();
  async addAll(urls: string[]) {
    for (const url of urls)
      this.entries.set(new URL(url, ORIGIN).href, new Response(`cached ${url}`));
  }
  async match(request: Request | string) {
    const key = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.entries.get(key)?.clone();
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, response);
  }
}

function boot(network: (request: Request) => Promise<Response>) {
  const stores = new Map<string, FakeCache>();
  const listeners = new Map<string, Listener>();
  const fetched: string[] = [];
  let preloadEnabled = false;
  const notifications: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const navigated: string[] = [];
  let navigateFails = false;
  let windows: { url: string }[] = [];
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name) as FakeCache;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const scope = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
    registration: {
      navigationPreload: { enable: async () => void (preloadEnabled = true) },
      showNotification: async (title: string, options: Record<string, unknown>) => {
        notifications.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        windows.map((w) => ({
          url: w.url,
          navigate: async (url: string) => {
            if (navigateFails) throw new TypeError('Cannot navigate an uncontrolled client');
            navigated.push(url);
            const moved = { url: `${ORIGIN}${url}`, focus: async () => void focused.push(url) };
            return moved;
          },
          focus: async () => {
            focused.push(w.url);
            return w;
          },
        })),
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
  runInNewContext(SOURCE, {
    self: scope,
    caches,
    URL,
    Response,
    fetch: (request: Request) => {
      fetched.push(request.url);
      return network(request);
    },
  });

  const lifecycle = async (type: 'install' | 'activate') => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
  };

  const request = async (
    path: string,
    init: { mode?: string; method?: string; preload?: Response } = {},
  ) => {
    const req = new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
    });
    Object.defineProperty(req, 'mode', { value: init.mode ?? 'cors' });
    let answer: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: req,
      preloadResponse: Promise.resolve(init.preload),
      respondWith: (p: Promise<Response>) => {
        answer = p;
      },
    });
    return answer ? await answer : undefined;
  };

  const dispatch = async (type: 'push' | 'notificationclick') => {
    let pending: Promise<unknown> = Promise.resolve();
    let closed = false;
    listeners.get(type)?.({
      notification: { close: () => void (closed = true) },
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
    return closed;
  };

  return {
    stores,
    fetched,
    lifecycle,
    request,
    dispatch,
    notifications,
    opened,
    focused,
    navigated,
    failNavigation: () => void (navigateFails = true),
    setWindows: (next: { url: string }[]) => void (windows = next),
    preloadEnabled: () => preloadEnabled,
  };
}

const online = async (request: Request) => new Response(`net ${new URL(request.url).pathname}`);
const offline = async () => {
  throw new TypeError('Failed to fetch');
};

describe('service worker', () => {
  it('precaches the offline page, manifest and icons on install', async () => {
    const sw = boot(online);
    await sw.lifecycle('install');
    const shell = sw.stores.get(`aquarium-shell-${BUILD}`);
    expect([...(shell?.entries.keys() ?? [])]).toEqual(
      expect.arrayContaining([
        `${ORIGIN}/offline.html`,
        `${ORIGIN}/manifest.webmanifest`,
        `${ORIGIN}/icons/icon-192.png`,
        `${ORIGIN}/icons/icon-512.png`,
        `${ORIGIN}/icons/apple-touch-icon.png`,
      ]),
    );
  });

  it('never intercepts /api, so nothing under it is cached', async () => {
    const sw = boot(online);
    await sw.lifecycle('install');
    for (const path of ['/api/health', '/api/tanks', '/api', '/api/auth/get-session']) {
      expect(await sw.request(path), path).toBeUndefined();
      expect(await sw.request(path, { mode: 'navigate' }), path).toBeUndefined();
    }
    expect(sw.stores.has(`aquarium-assets-${BUILD}`)).toBe(false);
  });

  it('ignores non-GET and cross-origin requests', async () => {
    const sw = boot(online);
    expect(await sw.request('/assets/index-C7vUOBtl.js', { method: 'POST' })).toBeUndefined();
    expect(await sw.request('https://cdn.example/assets/index-C7vUOBtl.js')).toBeUndefined();
  });

  it('serves hashed bundles from cache after the first load', async () => {
    const sw = boot(online);
    const path = '/assets/index-C7vUOBtl.js';
    expect(await (await sw.request(path))?.text()).toBe(`net ${path}`);
    expect(await (await sw.request(path))?.text()).toBe(`net ${path}`);
    expect(sw.fetched).toHaveLength(1);
  });

  it('leaves public files with hashed-looking names to the HTTP cache', async () => {
    const sw = boot(online);
    for (const path of ['/assets/polyhaven-cabin-1k0abcde.ktx2', '/assets/index-ABCDEFGH.js']) {
      expect(await sw.request(path), path).toBeUndefined();
    }
    expect(sw.fetched).toEqual([]);
  });

  it('does not cache failed responses or models under stable names', async () => {
    const missing = boot(async () => new Response('gone', { status: 404 }));
    await missing.request('/assets/index-C7vUOBtl.js');
    await missing.request('/assets/index-C7vUOBtl.js');
    expect(missing.fetched).toHaveLength(2);

    const sw = boot(online);
    expect(await sw.request('/assets/fish/tetra/lod0.glb')).toBeUndefined();
    expect(await sw.request('/assets/index.json')).toBeUndefined();
  });

  it('answers a failed navigation with the offline page', async () => {
    const sw = boot(offline);
    await sw.lifecycle('install');
    const res = await sw.request('/', { mode: 'navigate' });
    expect(await res?.text()).toBe('cached /offline.html');
  });

  it('passes a working navigation through to the network', async () => {
    const sw = boot(online);
    await sw.lifecycle('install');
    expect(await (await sw.request('/tank/3', { mode: 'navigate' }))?.text()).toBe('net /tank/3');
  });

  it('uses the navigation preload response instead of fetching twice', async () => {
    const sw = boot(online);
    await sw.lifecycle('activate');
    expect(sw.preloadEnabled()).toBe(true);
    const res = await sw.request('/', { mode: 'navigate', preload: new Response('preloaded') });
    expect(await res?.text()).toBe('preloaded');
    expect(sw.fetched).toHaveLength(0);
  });

  it('drops caches from older versions on activate', async () => {
    const sw = boot(online);
    await sw.lifecycle('install');
    sw.stores.set('aquarium-shell-old', new FakeCache());
    await sw.lifecycle('activate');
    expect([...sw.stores.keys()]).toEqual([`aquarium-shell-${BUILD}`]);
  });
});

describe('push reminders', () => {
  it('shows a fixed reminder without reading any payload', async () => {
    const sw = boot(online);
    await sw.dispatch('push');
    expect(sw.notifications).toHaveLength(1);
    expect(sw.notifications[0]?.title).toBe('Your fish are hungry');
    expect(sw.notifications[0]?.options['tag']).toBe('care-reminder');
  });

  it('takes an open tab that is elsewhere in the app to the tank and focuses it', async () => {
    const sw = boot(online);
    sw.setWindows([{ url: `${ORIGIN}/settings` }]);
    expect(await sw.dispatch('notificationclick')).toBe(true);
    expect(sw.navigated).toEqual(['/']);
    expect(sw.focused).toEqual(['/']);
    expect(sw.opened).toEqual([]);
  });

  it('opens a new tab when the open one cannot be navigated', async () => {
    const sw = boot(online);
    sw.setWindows([{ url: `${ORIGIN}/settings` }]);
    sw.failNavigation();
    await sw.dispatch('notificationclick');
    expect(sw.opened).toEqual(['/']);
  });

  it('prefers a tab already on the tank without navigating', async () => {
    const sw = boot(online);
    sw.setWindows([{ url: `${ORIGIN}/settings` }, { url: `${ORIGIN}/?backend=webgl` }]);
    await sw.dispatch('notificationclick');
    expect(sw.navigated).toEqual([]);
    expect(sw.focused).toEqual([`${ORIGIN}/?backend=webgl`]);
  });

  it('opens the tank when no tab of the app is open', async () => {
    const sw = boot(online);
    sw.setWindows([]);
    await sw.dispatch('notificationclick');
    expect(sw.opened).toEqual(['/']);
    expect(sw.focused).toEqual([]);
  });
});

describe('build id', () => {
  const dirs: string[] = [];
  const outputDir = (offlinePage: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-build-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'icons'));
    for (const path of shellPaths(RAW_SOURCE)) {
      writeFileSync(join(dir, path), path === '/offline.html' ? offlinePage : `content of ${path}`);
    }
    return dir;
  };
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('reads the precached paths from the worker source', () => {
    expect(shellPaths(RAW_SOURCE)).toEqual(
      expect.arrayContaining(['/offline.html', '/manifest.webmanifest', '/icons/icon-512.png']),
    );
    expect(() => shellPaths('const nothing = 1;')).toThrow(/SHELL/);
  });

  it('changes when a bundle name changes, and ignores their order', () => {
    expect(buildId({ a: '1' })).not.toBe(buildId({ b: '1' }));
    expect(buildId({ b: '1', a: '2' })).toBe(buildId({ a: '2', b: '1' }));
  });

  it('changes when only the offline page content changes', () => {
    const bundles = ['assets/index-a.js'];
    const before = buildIdForOutput(outputDir('<p>asleep</p>'), bundles, RAW_SOURCE);
    const same = buildIdForOutput(outputDir('<p>asleep</p>'), bundles, RAW_SOURCE);
    const edited = buildIdForOutput(outputDir('<p>napping</p>'), bundles, RAW_SOURCE);
    expect(same).toBe(before);
    expect(edited).not.toBe(before);
  });

  it('changes when the worker source changes', () => {
    const dir = outputDir('<p>asleep</p>');
    const base = buildIdForOutput(dir, [], RAW_SOURCE);
    expect(buildIdForOutput(dir, [], `${RAW_SOURCE}\n// edit`)).not.toBe(base);
  });

  it('refuses to stamp a worker without the placeholder', () => {
    expect(() => stampWorker('no placeholder', BUILD, [])).toThrow(/__BUILD_ID__/);
    expect(() => stampWorker("const a = '__BUILD_ID__';", BUILD, [])).toThrow(/__EMITTED_ASSETS__/);
  });

  it('injects file names with quotes and backslashes as a literal array', () => {
    const names = ["/assets/it's.js", '/assets/a"b.js', '/assets/c\\d$&.js'];
    const stamped = stampWorker(RAW_SOURCE, BUILD, names);
    const literal = /const EMITTED = new Set\((.*)\);/.exec(stamped)?.[1] ?? '';
    const evaluated: unknown = new Function(`return ${literal}`)();
    expect(evaluated).toEqual([...names].sort());
  });

  it('leaves an unstamped worker parseable', () => {
    expect(() => new Function(RAW_SOURCE)).not.toThrow();
  });

  it('lists only emitted files under assets/ as cache-first paths', () => {
    expect(emittedPaths(['assets/a-1.js', 'index.html', 'assets/b-2.css'])).toEqual([
      '/assets/a-1.js',
      '/assets/b-2.css',
    ]);
  });
});
