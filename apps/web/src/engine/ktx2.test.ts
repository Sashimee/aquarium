import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import { bundledTranscoderUrl, createSharedKtx2, rewritingKtx2Loader } from './ktx2';

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
