import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { disposeFishModel, FishAssetLoader } from './assets';

const ROOT = '/assets/';
const PUBLIC = fileURLToPath(new URL('../../public/assets/', import.meta.url));

function serveShippedAssets(): void {
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('ProgressEvent', Event);
  vi.stubGlobal(
    'Request',
    class {
      constructor(readonly url: string) {}
    },
  );
  vi.stubGlobal('fetch', (input: string | { url: string }) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(ROOT)) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(readFileSync(`${PUBLIC}${url.slice(ROOT.length)}`)));
  });
}

function spyTextureLoads(): string[] {
  const urls: string[] = [];
  vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation((url, onLoad) => {
    urls.push(url);
    onLoad(new CompressedTexture([], 1, 1));
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FishAssetLoader', () => {
  it('loads the 1k maps the models reference by default', async () => {
    serveShippedAssets();
    const urls = spyTextureLoads();
    const model = await new FishAssetLoader(new KTX2Loader(), ROOT).load('neon-tetra');

    expect(model.textureSize).toBe(1024);
    expect(new Set(urls)).toEqual(
      new Set([
        '/assets/fish/neon-tetra/textures/neon-tetra_basecolor_1k.ktx2',
        '/assets/fish/neon-tetra/textures/neon-tetra_normal_1k.ktx2',
      ]),
    );
    disposeFishModel(model);
  });

  it('swaps in only the 2k maps that are larger at 2048', async () => {
    serveShippedAssets();
    const urls = spyTextureLoads();
    const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
    loader.textureSize = 2048;
    const model = await loader.load('neon-tetra');

    expect(model.textureSize).toBe(2048);
    expect(new Set(urls)).toEqual(
      new Set([
        '/assets/fish/neon-tetra/textures/neon-tetra_basecolor_1k.ktx2',
        '/assets/fish/neon-tetra/textures/neon-tetra_normal_2k.ktx2',
      ]),
    );
    disposeFishModel(model);
  });

  it('keeps a model with no larger 2k map at 1024, so a tier change never reloads it', async () => {
    serveShippedAssets();
    spyTextureLoads();
    const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
    loader.textureSize = 2048;
    const entries = await loader.entries();
    const corydoras = entries.get('bronze-corydoras');
    const neon = entries.get('neon-tetra');
    if (corydoras === undefined || neon === undefined) throw new Error('shipped index changed');

    expect(loader.textureSizeFor(corydoras)).toBe(1024);
    expect(loader.textureSizeFor(neon)).toBe(2048);
    const model = await loader.load('bronze-corydoras');
    expect(model.textureSize).toBe(1024);
    disposeFishModel(model);
  });
});
