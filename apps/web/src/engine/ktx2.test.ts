import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import {
  bundledTranscoderUrl,
  createSharedKtx2,
  gltfKtx2Loader,
  KTX2_WORKER_URL,
  rewritingKtx2Loader,
} from './ktx2';

const renderer = { isWebGPURenderer: true, hasFeature: () => false } as unknown as WebGPURenderer;

function stubFetch(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('ProgressEvent', Event);
  vi.stubGlobal(
    'Request',
    class {
      constructor(readonly url: string) {}
    },
  );
  vi.stubGlobal('fetch', (input: { url: string }) => {
    requested.push(input.url);
    return Promise.resolve(new Response(new Uint8Array(4)));
  });
  return requested;
}

function spyLoads(): { loader: KTX2Loader; url: string }[] {
  const calls: { loader: KTX2Loader; url: string }[] = [];
  vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation(function (
    this: KTX2Loader,
    url,
    onLoad,
  ) {
    calls.push({ loader: this, url });
    onLoad(new CompressedTexture([], 1, 1));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bundledTranscoderUrl', () => {
  it('redirects the wasm to the bundled copy', () => {
    const wasm = bundledTranscoderUrl('https://cdn/libs/basis/basis_transcoder.wasm');
    expect(wasm).not.toContain('cdn');
    expect(wasm).toContain('basis_transcoder');
  });

  it('versions the worker url by content hash, not by three revision', () => {
    expect(KTX2_WORKER_URL).toMatch(/^\/ktx2-worker\.js\?v=[0-9a-f]{12}$/);
  });

  it('leaves texture urls alone, so no caller sees another caller’s variant choice', () => {
    expect(bundledTranscoderUrl('/assets/rock/a/textures/a_1k.ktx2')).toBe(
      '/assets/rock/a/textures/a_1k.ktx2',
    );
  });
});

describe('rewritingKtx2Loader', () => {
  it('loads through the shared loader with the rewritten url', async () => {
    const calls = spyLoads();
    const { loader } = createSharedKtx2(renderer);
    const view = rewritingKtx2Loader(loader, (url) => url.replace('_1k', '_2k'));

    view.load('a_1k.ktx2', () => {});
    await view.loadAsync('b_1k.ktx2');
    await loader.loadAsync('hdri_1k.ktx2');

    expect(calls).toEqual([
      { loader, url: 'a_2k.ktx2' },
      { loader, url: 'b_2k.ktx2' },
      { loader, url: 'hdri_1k.ktx2' },
    ]);
  });

  it('shares the transcoder and workers instead of starting a second set', async () => {
    const requested = stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shared = createSharedKtx2(renderer);
    const view = rewritingKtx2Loader(shared.loader, (url) => url);

    const first = shared.loader.init();
    const second = view.init();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(view.workerPool).toBe(shared.loader.workerPool);
    expect(requested.filter((u) => u.includes('basis_transcoder'))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    shared.dispose();
  });

  it('is what a second loader would cost: a second transcoder download', async () => {
    const requested = stubFetch();
    const a = createSharedKtx2(renderer);
    const b = createSharedKtx2(renderer);

    await a.loader.init();
    await b.loader.init();

    expect(requested.filter((u) => u.includes('basis_transcoder'))).toHaveLength(2);
    a.dispose();
    b.dispose();
  });
});

describe('the shared loader init', () => {
  it('fetches only the transcoder binary, not the glue script the worker file already carries', async () => {
    const requested = stubFetch();
    const shared = createSharedKtx2(renderer);

    await shared.loader.init();

    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/basis_transcoder.*\.wasm/);
    expect(requested.some((u) => u.endsWith('.js') || u.includes('ktx2-worker'))).toBe(false);
    expect(shared.loader.workerSourceURL).toBe('');
    shared.dispose();
  });

  it('starts pool workers from the versioned same-origin worker file with the binary', async () => {
    stubFetch();
    const started: { url: string; message: { type: string; transcoderBinary: ArrayBuffer } }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        constructor(readonly url: string) {}
        addEventListener(): void {}
        postMessage(message: { type: string; transcoderBinary: ArrayBuffer }): void {
          if (message.type === 'init') started.push({ url: this.url, message });
        }
        terminate(): void {}
      },
    );
    const shared = createSharedKtx2(renderer);
    await shared.loader.init();

    void shared.loader.workerPool.postMessage({ type: 'transcode' }, []);

    expect(started).toHaveLength(1);
    expect(started[0]?.url).toBe(KTX2_WORKER_URL);
    expect(KTX2_WORKER_URL).toMatch(/^\/ktx2-worker\.js\?v=\d+$/);
    expect(started[0]?.message.transcoderBinary.byteLength).toBe(4);
    shared.dispose();
  });

  it('fails init loudly when the transcoder binary cannot be fetched', async () => {
    vi.stubGlobal('ProgressEvent', Event);
    vi.stubGlobal(
      'Request',
      class {
        constructor(readonly url: string) {}
      },
    );
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('missing', { status: 404 })));
    const shared = createSharedKtx2(renderer);

    await expect(shared.loader.init()).rejects.toThrow(/404/);
    expect(shared.loader.transcoderBinary).toBeNull();
    shared.dispose();
  });
});

describe('the shared loader after dispose', () => {
  const texture = readFileSync(
    join(
      __dirname,
      '../../public/assets/substrate/clean-pebbles/textures/clean-pebbles_arm_1k.ktx2',
    ),
  );

  /**
   * Serves a real KTX2 file, so a load reaches the workers, and workers that never answer, so a
   * transcode stays in the pool until something settles it.
   */
  function stubDownloads({
    textureArrives = Promise.resolve(),
    transcoderArrives = Promise.resolve(),
  }: { textureArrives?: Promise<void>; transcoderArrives?: Promise<void> } = {}): {
    requested: string[];
    workers: number;
    transcodes: number;
  } {
    const seen = { requested: [] as string[], workers: 0, transcodes: 0 };
    vi.stubGlobal('ProgressEvent', Event);
    vi.stubGlobal(
      'Request',
      class {
        constructor(readonly url: string) {}
      },
    );
    vi.stubGlobal('fetch', async (input: { url: string }) => {
      seen.requested.push(input.url);
      if (input.url.includes('basis_transcoder')) {
        await transcoderArrives;
        return new Response(new Uint8Array(4));
      }
      await textureArrives;
      return new Response(new Uint8Array(texture));
    });
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          seen.workers++;
        }
        addEventListener(): void {}
        postMessage(message: { type: string }): void {
          if (message.type === 'transcode') seen.transcodes++;
        }
        terminate(): void {}
      },
    );
    return seen;
  }

  function texturePromise(parse: KTX2Loader['parse']): Promise<unknown> {
    return new Promise((resolve, reject) => {
      parse(new Uint8Array(texture).buffer, resolve, reject);
    });
  }

  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('rejects a late load instead of starting a worker from the revoked transcoder', async () => {
    const seen = stubDownloads();
    const shared = createSharedKtx2(renderer);
    await shared.loader.init();
    shared.dispose();
    const fetchedBefore = seen.requested.length;

    await expect(shared.loader.loadAsync('fish_1k.ktx2')).rejects.toThrow(
      /cannot load fish_1k\.ktx2, the shared loader was disposed/,
    );
    await expect(
      rewritingKtx2Loader(shared.loader, (url) => url).loadAsync('rock_1k.ktx2'),
    ).rejects.toThrow(/disposed/);
    expect(() => {
      shared.loader.load('sand_1k.ktx2', () => {});
    }).toThrow(/disposed/);

    expect(seen.requested.length).toBe(fetchedBefore);
    expect(seen.workers).toBe(0);
  });

  it('does not transcode a download that finishes after dispose', async () => {
    let arrive = (): void => {};
    const seen = stubDownloads({ textureArrives: new Promise((resolve) => (arrive = resolve)) });
    const shared = createSharedKtx2(renderer);

    const late = shared.loader.loadAsync('fish_1k.ktx2');
    shared.dispose();
    arrive();

    await expect(late).rejects.toThrow(/cannot load a downloaded texture, the shared loader/);
    expect(seen.workers).toBe(0);
  });

  it('rejects transcodes that are running or queued in the pool when it is disposed', async () => {
    const seen = stubDownloads();
    const shared = createSharedKtx2(renderer);
    await shared.loader.init();
    const loads = Array.from({ length: shared.loader.workerPool.pool + 2 }, (_, i) =>
      shared.loader.loadAsync(`fish_${i}_1k.ktx2`),
    );
    await vi.waitFor(() => expect(seen.transcodes).toBe(shared.loader.workerPool.pool));
    const workersAtDispose = seen.workers;

    shared.dispose();

    for (const load of loads) await expect(load).rejects.toThrow(/disposed/);
    await nextTask();
    expect(seen.workers).toBe(workersAtDispose);
  });

  it('rejects a transcode accepted in the same tick as dispose without starting a worker', async () => {
    const seen = stubDownloads();
    const shared = createSharedKtx2(renderer);
    await shared.loader.init();

    const transcoded = texturePromise((...args) => shared.loader.parse(...args));
    shared.dispose();

    await expect(transcoded).rejects.toThrow(/disposed/);
    await nextTask();
    expect(seen.workers).toBe(0);
  });

  it('rejects every pending transcode even when one error callback throws', async () => {
    stubDownloads();
    const shared = createSharedKtx2(renderer);
    await shared.loader.init();
    const boom = new Error('caller bug');
    const buffer = (): ArrayBuffer => new Uint8Array(texture).buffer;

    shared.loader.parse(
      buffer(),
      () => undefined,
      () => {
        throw boom;
      },
    );
    const second = texturePromise((...args) => shared.loader.parse(...args));

    let thrown: unknown;
    try {
      shared.dispose();
    } catch (error) {
      thrown = error;
    }

    await expect(second).rejects.toThrow(/disposed/);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([boom]);
  });

  it('rejects a transcode whose transcoder arrives after dispose without starting a worker', async () => {
    let arrive = (): void => {};
    const seen = stubDownloads({
      transcoderArrives: new Promise((resolve) => (arrive = resolve)),
    });
    const shared = createSharedKtx2(renderer);

    const transcoded = texturePromise((...args) => shared.loader.parse(...args));
    shared.dispose();
    arrive();

    await expect(transcoded).rejects.toThrow(/disposed/);
    const transcoder = shared.loader.init();
    await Promise.allSettled([transcoder]);
    await nextTask();
    expect(seen.workers).toBe(0);
    await expect(transcoder).rejects.toThrow(/disposed/);
  });
});

describe('the shared loader before dispose', () => {
  it('still reports an exception thrown by onLoad through onError, as three does', async () => {
    vi.spyOn(KTX2Loader.prototype, 'parse').mockImplementation((_buffer, onLoad, onError) => {
      Promise.resolve(new CompressedTexture([], 1, 1))
        .then(onLoad)
        .catch(onError);
    });
    const shared = createSharedKtx2(renderer);
    const boom = new Error('boom');

    const reported = await new Promise((resolve) => {
      shared.loader.parse(
        new ArrayBuffer(4),
        () => {
          throw boom;
        },
        resolve,
      );
    });

    expect(reported).toBe(boom);
    shared.dispose();
  });
});

describe('views of the shared loader', () => {
  it('cannot dispose it', async () => {
    const calls = spyLoads();
    const shared = createSharedKtx2(renderer);
    const view = gltfKtx2Loader(shared.loader);

    expect(() => view.dispose()).toThrow(/the engine owns it/);
    await shared.loader.loadAsync('fish_1k.ktx2');

    expect(calls).toEqual([{ loader: shared.loader, url: 'fish_1k.ktx2' }]);
  });

  it('refuse a source that is not a KTX2Loader', () => {
    const fake = { load: () => {}, loadAsync: () => Promise.reject(new Error('unused')) };
    expect(() => gltfKtx2Loader(fake)).toThrow(TypeError);
  });
});
