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
  it('redirects the basis transcoder to the bundled copy', () => {
    const js = bundledTranscoderUrl('https://cdn/libs/basis/basis_transcoder.js');
    const wasm = bundledTranscoderUrl('https://cdn/libs/basis/basis_transcoder.wasm');
    expect(js).not.toContain('cdn');
    expect(wasm).not.toContain('cdn');
    expect(js).not.toBe(wasm);
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
    expect(requested.filter((u) => u.includes('basis_transcoder')).length).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    shared.dispose();
  });

  it('is what three would warn about if it were a second loader', async () => {
    stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = createSharedKtx2(renderer);
    const b = createSharedKtx2(renderer);

    await a.loader.init();
    await b.loader.init();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Multiple active KTX2 loaders'));
    a.dispose();
    b.dispose();
  });
});

describe('the shared loader after dispose', () => {
  const texture = readFileSync(
    join(
      __dirname,
      '../../public/assets/substrate/clean-pebbles/textures/clean-pebbles_arm_1k.ktx2',
    ),
  );

  /** Serves a real KTX2 file once `textureArrives` resolves, so a load would reach the workers. */
  function stubDownloads(textureArrives: Promise<void> = Promise.resolve()): {
    requested: string[];
    workers: number;
  } {
    const seen = { requested: [] as string[], workers: 0 };
    vi.stubGlobal('ProgressEvent', Event);
    vi.stubGlobal(
      'Request',
      class {
        constructor(readonly url: string) {}
      },
    );
    vi.stubGlobal('fetch', async (input: { url: string }) => {
      seen.requested.push(input.url);
      if (input.url.includes('basis_transcoder')) return new Response(new Uint8Array(4));
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
        postMessage(): void {}
        terminate(): void {}
      },
    );
    return seen;
  }

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
    const seen = stubDownloads(new Promise((resolve) => (arrive = resolve)));
    const shared = createSharedKtx2(renderer);

    const late = shared.loader.loadAsync('fish_1k.ktx2');
    shared.dispose();
    arrive();

    await expect(late).rejects.toThrow(/cannot load a downloaded texture, the shared loader/);
    expect(seen.workers).toBe(0);
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
