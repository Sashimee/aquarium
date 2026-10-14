import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import { DEFAULT_HDRI_URL } from '../engine/environment';
import { createSharedKtx2 } from '../engine/ktx2';
import { FishAssetLoader } from '../fish/assets';
import { AssetCatalog, materialTextureUrl, ModelLibrary } from './assets';

const PUBLIC_ASSETS = join(__dirname, '../../public/assets');

describe('materialTextureUrl', () => {
  it('keeps 1k textures at the 1024 tier', () => {
    expect(materialTextureUrl('/assets/rock/a/textures/a_1k.ktx2', 1024)).toBe(
      '/assets/rock/a/textures/a_1k.ktx2',
    );
  });

  it('swaps material textures to 2k at the 2048 tier, keeping any query', () => {
    expect(materialTextureUrl('/assets/rock/a/textures/a_1k.ktx2', 2048)).toBe(
      '/assets/rock/a/textures/a_2k.ktx2',
    );
    expect(materialTextureUrl('/assets/rock/a/textures/a_1k.ktx2?v=3', 2048)).toBe(
      '/assets/rock/a/textures/a_2k.ktx2?v=3',
    );
  });

  it('never rewrites the room HDRI, which has no 2k variant', () => {
    expect(materialTextureUrl(DEFAULT_HDRI_URL, 2048)).toBe(DEFAULT_HDRI_URL);
    expect(materialTextureUrl('/assets/hdri/x/x_1k.ktx2', 2048)).toBe('/assets/hdri/x/x_1k.ktx2');
  });

  it('leaves other urls alone', () => {
    expect(materialTextureUrl('/assets/rock/a/a.glb', 2048)).toBe('/assets/rock/a/a.glb');
    expect(materialTextureUrl('/assets/rock/textures/a_1k.png', 2048)).toBe(
      '/assets/rock/textures/a_1k.png',
    );
  });

  it('only ever points at a shipped file', () => {
    const files = new Set(
      readdirSync(PUBLIC_ASSETS, { recursive: true, encoding: 'utf8' }).map((f) =>
        f.split('\\').join('/'),
      ),
    );
    const oneK = [...files].filter((f) => f.endsWith('_1k.ktx2'));
    expect(oneK.some((f) => f.startsWith('hdri/'))).toBe(true);
    expect(oneK.some((f) => f.includes('/textures/'))).toBe(true);
    for (const file of oneK) expect(files).toContain(materialTextureUrl(`/${file}`, 2048).slice(1));
  });
});

describe('the shared KTX2 loader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves models, fish and the HDRI from one instance, scoping the 2k swap to the models', async () => {
    const index = JSON.parse(await readFile(join(PUBLIC_ASSETS, 'index.json'), 'utf8')) as {
      assets: ConstructorParameters<typeof AssetCatalog>[0];
    };
    const catalog = new AssetCatalog(index.assets);
    const rock = [...catalog.entries()].find((e) => e.kind === 'rock');
    const fish = [...catalog.entries()].find((e) => e.kind === 'fish');
    if (!rock || !fish)
      throw new Error('no rock or fish in the asset index; run pnpm build:assets');

    vi.stubGlobal('ProgressEvent', Event);
    vi.stubGlobal('self', globalThis);
    vi.stubGlobal(
      'Request',
      class {
        constructor(readonly url: string) {}
      },
    );
    vi.stubGlobal('fetch', async (input: { url: string } | string) => {
      const url = typeof input === 'string' ? input : input.url;
      const bytes = await readFile(join(PUBLIC_ASSETS, '..', new URL(url, 'http://x').pathname));
      return new Response(new Uint8Array(bytes));
    });
    const calls: { loader: KTX2Loader; url: string }[] = [];
    vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation(function (
      this: KTX2Loader,
      url,
      onLoad,
    ) {
      calls.push({ loader: this, url });
      onLoad(new CompressedTexture([], 1, 1));
    });

    const shared = createSharedKtx2({
      isWebGPURenderer: true,
      hasFeature: () => false,
    } as unknown as WebGPURenderer);
    const library = new ModelLibrary(shared.loader, catalog);
    const fishLoader = new FishAssetLoader(shared.loader, '/assets/');

    const model = library.load(rock.id, 0, 2048);
    const room = shared.loader.loadAsync(DEFAULT_HDRI_URL);
    const fishModel = fishLoader.load(fish.id);
    await Promise.all([model, room, fishModel]);

    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call.loader).toBe(shared.loader);
    const urls = calls.map((c) => c.url);
    expect(urls).toContain(DEFAULT_HDRI_URL);
    const rockTextures = urls.filter((u) => u.includes(`/${rock.kind}/`));
    const fishTextures = urls.filter((u) => u.includes('/fish/'));
    expect(rockTextures.length).toBeGreaterThan(0);
    expect(fishTextures.length).toBeGreaterThan(0);
    for (const url of rockTextures) expect(url).toMatch(/\/textures\/[^/]+_2k\.ktx2$/);
    for (const url of fishTextures) expect(url).toMatch(/_1k\.ktx2$/);
  });
});
