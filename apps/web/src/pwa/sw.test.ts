import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildId, stampWorker } from '../../build/sw-build-id-plugin';

const BUILD = 'abc123';
const SOURCE = stampWorker(
  readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'),
  BUILD,
);
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
    clients: { claim: async () => undefined },
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

  const request = async (path: string, init: { mode?: string; method?: string } = {}) => {
    const req = new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
    });
    Object.defineProperty(req, 'mode', { value: init.mode ?? 'cors' });
    let answer: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: req,
      respondWith: (p: Promise<Response>) => {
        answer = p;
      },
    });
    return answer ? await answer : undefined;
  };

  return { stores, fetched, lifecycle, request };
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

  it('names its caches after the build, so a new deploy starts with empty ones', () => {
    expect(buildId(['assets/index-a.js'])).not.toBe(buildId(['assets/index-b.js']));
    expect(buildId(['b.js', 'a.js'])).toBe(buildId(['a.js', 'b.js']));
    expect(() => stampWorker('no placeholder', BUILD)).toThrow(/__BUILD_ID__/);
  });

  it('drops caches from older versions on activate', async () => {
    const sw = boot(online);
    await sw.lifecycle('install');
    sw.stores.set('aquarium-shell-old', new FakeCache());
    await sw.lifecycle('activate');
    expect([...sw.stores.keys()]).toEqual([`aquarium-shell-${BUILD}`]);
  });
});
