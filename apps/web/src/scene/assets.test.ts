import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, CompressedTexture, LoaderUtils, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import { DEFAULT_HDRI_URL } from '../engine/environment';
import { createSharedKtx2 } from '../engine/ktx2';
import { FishAssetLoader } from '../fish/assets';
import {
  ASSET_BASE,
  AssetCatalog,
  type CatalogEntry,
  collapseDotSegments,
  type LoadedModel,
  ModelLibrary,
} from './assets';

const PUBLIC_ASSETS = join(__dirname, '../../public/assets');

type TextureVariants = NonNullable<CatalogEntry['textures']>[number]['variants'];

function rockWith(id: string, variants: TextureVariants): CatalogEntry {
  return {
    id,
    kind: 'rock',
    lods: [{ file: `rock/${id}/lod0.glb` }],
    textures: [{ role: 'baseColor', variants }],
  };
}

const oneK = (id: string) => ({ file: `rock/${id}/textures/${id}_1k.ktx2`, size: 1024 });

const catalog = new AssetCatalog([
  rockWith('listed', {
    '1k': oneK('listed'),
    '2k': { file: 'rock/listed/textures/listed_2k.ktx2', size: 2048 },
  }),
  rockWith('absent', { '1k': oneK('absent') }),
  rockWith('aliased', { '1k': oneK('aliased'), '2k': oneK('aliased') }),
  rockWith('copied', {
    '1k': oneK('copied'),
    '2k': { file: 'rock/copied/textures/copied_2k.ktx2', size: 1024 },
  }),
]);

describe('AssetCatalog texture tiers', () => {
  it('keeps 1k textures at the 1024 tier', () => {
    expect(catalog.materialTextureUrl('/assets/rock/listed/textures/listed_1k.ktx2', 1024)).toBe(
      '/assets/rock/listed/textures/listed_1k.ktx2',
    );
    expect(catalog.textureFile('listed', 'baseColor', 1024)).toBe(
      'rock/listed/textures/listed_1k.ktx2',
    );
    expect(catalog.textureSizeFor('listed', 1024)).toBe(1024);
  });

  it('swaps to the listed 2k at the 2048 tier, keeping any query', () => {
    expect(catalog.materialTextureUrl('/assets/rock/listed/textures/listed_1k.ktx2', 2048)).toBe(
      '/assets/rock/listed/textures/listed_2k.ktx2',
    );
    expect(
      catalog.materialTextureUrl('/assets/rock/listed/textures/listed_1k.ktx2?v=3', 2048),
    ).toBe('/assets/rock/listed/textures/listed_2k.ktx2?v=3');
    expect(catalog.textureFile('listed', 'baseColor', 2048)).toBe(
      'rock/listed/textures/listed_2k.ktx2',
    );
    expect(catalog.textureSizeFor('listed', 2048)).toBe(2048);
  });

  it.each(['absent', 'aliased', 'copied'])(
    'stays on 1k at 2048 when %s has no larger 2k listed',
    (id) => {
      const url = `/assets/rock/${id}/textures/${id}_1k.ktx2`;
      expect(catalog.materialTextureUrl(url, 2048)).toBe(url);
      expect(catalog.textureFile(id, 'baseColor', 2048)).toBe(`rock/${id}/textures/${id}_1k.ktx2`);
      expect(catalog.textureSizeFor(id, 2048)).toBe(1024);
    },
  );

  it('gives an asset without a larger 2k one model key for both tiers', async () => {
    const library = new ModelLibrary(
      createSharedKtx2({
        isWebGPURenderer: true,
        hasFeature: () => false,
      } as unknown as WebGPURenderer).loader,
      catalog,
    );
    expect(library.modelKey('aliased', 0, 2048)).toBe(library.modelKey('aliased', 0, 1024));
    expect(library.modelKey('listed', 0, 2048)).not.toBe(library.modelKey('listed', 0, 1024));
    await library.dispose();
  });

  it('never rewrites a texture the index does not list, like the room HDRI', () => {
    expect(catalog.materialTextureUrl(DEFAULT_HDRI_URL, 2048)).toBe(DEFAULT_HDRI_URL);
    expect(catalog.materialTextureUrl('/assets/rock/other/textures/other_1k.ktx2', 2048)).toBe(
      '/assets/rock/other/textures/other_1k.ktx2',
    );
    expect(catalog.materialTextureUrl('/assets/rock/listed/lod0.glb', 2048)).toBe(
      '/assets/rock/listed/lod0.glb',
    );
  });

  it('swaps a borrowed map a GLB reaches through ../', () => {
    const url = LoaderUtils.resolveURL(
      '../listed/textures/listed_1k.ktx2',
      LoaderUtils.extractUrlBase('/assets/rock/pile/lod0.glb'),
    );
    expect(url).toBe('/assets/rock/pile/../listed/textures/listed_1k.ktx2');
    expect(catalog.materialTextureUrl(url, 2048)).toBe(
      '/assets/rock/listed/textures/listed_2k.ktx2',
    );
    expect(catalog.materialTextureUrl(`${url}?v=3`, 2048)).toBe(
      '/assets/rock/listed/textures/listed_2k.ktx2?v=3',
    );
    expect(catalog.materialTextureUrl(url, 1024)).toBe(url);
  });

  it('collapses dot segments without climbing out of the root', () => {
    expect(collapseDotSegments('/assets/rock/a/./../b/x.ktx2')).toBe('/assets/rock/b/x.ktx2');
    expect(collapseDotSegments('/../x.ktx2')).toBe('/../x.ktx2');
    expect(collapseDotSegments('../../x.ktx2')).toBe('../../x.ktx2');
    expect(collapseDotSegments('a/b/../../../x.ktx2')).toBe('../x.ktx2');
  });

  it('rejects two assets listing one 1k map with different 2k maps', () => {
    const shared = { file: 'rock/listed/textures/listed_1k.ktx2', size: 1024 };
    expect(
      () =>
        new AssetCatalog([
          rockWith('a', { '1k': shared, '2k': { file: 'rock/a/a_2k.ktx2', size: 2048 } }),
          rockWith('b', { '1k': shared, '2k': { file: 'rock/b/b_2k.ktx2', size: 2048 } }),
        ]),
    ).toThrow(/two different 2k variants/);
  });

  it('rejects a 2k variant without a size', () => {
    expect(
      () =>
        new AssetCatalog([
          rockWith('broken', { '1k': oneK('broken'), '2k': { file: 'rock/broken/b_2k.ktx2' } }),
        ]),
    ).toThrow(/2k\.size must be a positive number/);
  });

  it('only ever points at a shipped file, and at the 2k wherever the index lists a larger one', async () => {
    const files = new Set(
      readdirSync(PUBLIC_ASSETS, { recursive: true, encoding: 'utf8' }).map((f) =>
        f.split('\\').join('/'),
      ),
    );
    const index = JSON.parse(await readFile(join(PUBLIC_ASSETS, 'index.json'), 'utf8')) as {
      assets: CatalogEntry[];
    };
    const shipped = new AssetCatalog(index.assets);
    let sharper = 0;
    for (const entry of index.assets) {
      for (const { variants } of entry.textures ?? []) {
        const small = variants['1k'];
        if (small === undefined)
          throw new Error(`${entry.id} lists a texture without a 1k variant`);
        const large = variants['2k'];
        const swapped = shipped
          .materialTextureUrl(`${ASSET_BASE}${small.file}`, 2048)
          .slice(ASSET_BASE.length);
        expect(files).toContain(swapped);
        if (large !== undefined && (large.size ?? 0) > (small.size ?? 0)) {
          expect(swapped).toBe(large.file);
          sharper++;
        } else {
          expect(swapped).toBe(small.file);
        }
      }
    }
    expect(sharper).toBeGreaterThan(0);
  });

  it('swaps every map a shipped model GLB requests to its larger 2k', async () => {
    const index = JSON.parse(await readFile(join(PUBLIC_ASSETS, 'index.json'), 'utf8')) as {
      assets: CatalogEntry[];
    };
    const shipped = new AssetCatalog(index.assets);
    const larger = new Map<string, string>();
    for (const entry of index.assets) {
      for (const { variants } of entry.textures ?? []) {
        const small = variants['1k'];
        const large = variants['2k'];
        if (small && large && (large.size ?? 0) > (small.size ?? 0)) {
          larger.set(`${ASSET_BASE}${small.file}`, `${ASSET_BASE}${large.file}`);
        }
      }
    }
    let borrowed = 0;
    let swapped = 0;
    for (const entry of index.assets) {
      if (MODEL_LIBRARY_KINDS.has(entry.kind) === false) continue;
      for (const { file } of entry.lods) {
        const lodUrl = `${ASSET_BASE}${file}`;
        for (const uri of glbImageUris(await readFile(join(PUBLIC_ASSETS, file)))) {
          const url = LoaderUtils.resolveURL(uri, LoaderUtils.extractUrlBase(lodUrl));
          if (uri.startsWith('../')) borrowed++;
          const want = larger.get(collapseDotSegments(url));
          const got = shipped.materialTextureUrl(url, 2048);
          if (want === undefined) {
            expect(got, `${file}: ${uri}`).toBe(url);
          } else {
            expect(got, `${file}: ${uri}`).toBe(want);
            swapped++;
          }
        }
      }
    }
    expect(borrowed).toBeGreaterThan(0);
    expect(swapped).toBeGreaterThan(0);
  });
});

const MODEL_LIBRARY_KINDS: ReadonlySet<string> = new Set([
  'plant',
  'coral',
  'anemone',
  'driftwood',
  'rock',
  'decor',
  'substrate',
]);

function glbImageUris(glb: Buffer): string[] {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a binary glTF');
  const length = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first GLB chunk is not JSON');
  const json = JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as {
    images?: { uri?: string }[];
  };
  return (json.images ?? []).flatMap((image) => (image.uri === undefined ? [] : [image.uri]));
}

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

describe('ModelLibrary shared model textures', () => {
  const PILE = 'rock-pile-cave';
  const MEMBER = 'malawi-boulder-03';
  const MEMBER_MAP = `${ASSET_BASE}rock/${MEMBER}/textures/${MEMBER}_basecolor_1k.ktx2`;

  let ktx2Urls: string[];
  let failing: Set<string>;
  let disposed: Set<Texture>;
  let ktx2Gate: Promise<void> | undefined;
  let library: ModelLibrary;

  beforeEach(async () => {
    const index = JSON.parse(await readFile(join(PUBLIC_ASSETS, 'index.json'), 'utf8')) as {
      assets: CatalogEntry[];
    };
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
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ktx2Urls = [];
    failing = new Set();
    disposed = new Set();
    ktx2Gate = undefined;
    vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation(function (
      this: KTX2Loader,
      url,
      onLoad,
      _onProgress,
      onError,
    ) {
      ktx2Urls.push(url);
      if (failing.has(url)) {
        onError?.(new Error(`${url}: 404`));
        return;
      }
      const texture = new CompressedTexture([], 1, 1);
      texture.addEventListener('dispose', () => disposed.add(texture));
      if (ktx2Gate) void ktx2Gate.then(() => onLoad(texture));
      else onLoad(texture);
    });
    library = new ModelLibrary(
      createSharedKtx2({
        isWebGPURenderer: true,
        hasFeature: () => false,
      } as unknown as WebGPURenderer).loader,
      new AssetCatalog(index.assets),
    );
  });

  afterEach(async () => {
    await library.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function textures(model: LoadedModel): Set<Texture> {
    const out = new Set<Texture>();
    for (const { material } of model.primitives) {
      for (const value of Object.values(material)) if (value instanceof Texture) out.add(value);
    }
    return out;
  }

  it('loads a map a pile borrows from its member rock once, as one texture', async () => {
    const [pile, member] = await Promise.all([
      library.load(PILE, 0, 1024),
      library.load(MEMBER, 0, 1024),
    ]);

    expect(ktx2Urls.filter((url) => url === MEMBER_MAP)).toHaveLength(1);
    expect(new Set(ktx2Urls).size).toBe(ktx2Urls.length);
    const memberTextures = textures(member);
    expect(memberTextures.size).toBe(2);
    for (const texture of memberTextures) expect(textures(pile)).toContain(texture);
  });

  it('keeps a shared map alive while another model still uses it', async () => {
    const pile = await library.load(PILE, 0, 1024);
    const member = await library.load(MEMBER, 0, 1024);
    const memberTextures = textures(member);
    const pileOnly = [...textures(pile)].filter((t) => !memberTextures.has(t));
    expect(pileOnly.length).toBeGreaterThan(0);

    await library.retainOnly(new Set([library.modelKey(MEMBER, 0, 1024)]));
    for (const texture of memberTextures) expect(disposed).not.toContain(texture);
    for (const texture of pileOnly) expect(disposed).toContain(texture);

    const loadsBefore = ktx2Urls.length;
    const again = await library.load(PILE, 0, 1024);
    for (const texture of memberTextures) expect(textures(again)).toContain(texture);
    expect(ktx2Urls.slice(loadsBefore)).not.toContain(MEMBER_MAP);

    await library.retainOnly(new Set());
    for (const texture of textures(again)) expect(disposed).toContain(texture);
  });

  it('frees a shared map once its last user goes, and loads it afresh after', async () => {
    const member = await library.load(MEMBER, 0, 1024);
    await library.retainOnly(new Set());
    for (const texture of textures(member)) expect(disposed).toContain(texture);

    const reloaded = await library.load(MEMBER, 0, 1024);
    expect(ktx2Urls.filter((url) => url === MEMBER_MAP)).toHaveLength(2);
    for (const texture of textures(reloaded)) expect(disposed).not.toContain(texture);
  });

  it('keeps distinct URLs distinct, including the 1k and 2k of one map', async () => {
    const small = await library.load(MEMBER, 0, 1024);
    const large = await library.load(MEMBER, 0, 2048);

    const smallTextures = textures(small);
    expect(smallTextures.size).toBe(2);
    for (const texture of textures(large)) expect(smallTextures).not.toContain(texture);
    expect(ktx2Urls).toContain(MEMBER_MAP);
    expect(ktx2Urls).toContain(MEMBER_MAP.replace('_1k.ktx2', '_2k.ktx2'));
  });

  it('does not cache a map that failed to load', async () => {
    failing.add(MEMBER_MAP);
    const broken = await library.load(MEMBER, 0, 1024);
    expect(textures(broken).size).toBe(1);

    failing.clear();
    await library.retainOnly(new Set());
    const fixed = await library.load(MEMBER, 0, 1024);
    expect(textures(fixed).size).toBe(2);
    expect(ktx2Urls.filter((url) => url === MEMBER_MAP)).toHaveLength(2);
  });

  it('disposes each shared texture once when dispose runs during retainOnly', async () => {
    const counts = new Map<Texture, number>();
    const original = Texture.prototype.dispose;
    vi.spyOn(Texture.prototype, 'dispose').mockImplementation(function (this: Texture) {
      counts.set(this, (counts.get(this) ?? 0) + 1);
      original.call(this);
    });
    const model = await library.load(MEMBER, 0, 1024);

    const retaining = library.retainOnly(new Set());
    const disposing = library.dispose();
    await Promise.all([retaining, disposing]);

    expect(textures(model).size).toBeGreaterThan(0);
    for (const texture of textures(model)) expect(counts.get(texture)).toBe(1);
  });

  it('frees a model whose load resolves while dispose is running', async () => {
    const loading = library.load(MEMBER, 0, 1024);
    const disposing = library.dispose();
    const model = await loading;
    await disposing;

    expect(textures(model).size).toBeGreaterThan(0);
    for (const texture of textures(model)) expect(disposed).toContain(texture);
  });

  it('frees a model whose load starts while dispose is running', async () => {
    const disposing = library.dispose();
    const model = await library.load(MEMBER, 0, 1024);
    await disposing;

    expect(textures(model).size).toBeGreaterThan(0);
    for (const texture of textures(model)) expect(disposed).toContain(texture);
  });

  it('frees collision geometry requested after dispose took its snapshot', async () => {
    const freed: BufferGeometry[] = [];
    const original = BufferGeometry.prototype.dispose;
    vi.spyOn(BufferGeometry.prototype, 'dispose').mockImplementation(function (
      this: BufferGeometry,
    ) {
      freed.push(this);
      original.call(this);
    });
    const early = library.collisionGeometry(MEMBER);
    const disposing = library.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const late = await library.collisionGeometry(PILE);
    await disposing;

    expect(late.length).toBeGreaterThan(0);
    for (const geometry of late) expect(freed.filter((g) => g === geometry)).toHaveLength(1);
    for (const geometry of await early) {
      expect(freed.filter((g) => g === geometry)).toHaveLength(1);
    }
  });

  it('frees a texture whose load resolves after dispose', async () => {
    let open!: () => void;
    ktx2Gate = new Promise<void>((resolve) => (open = resolve));
    const loading = library.loadTexture(MEMBER, 'baseColor', 1024, 4);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await library.dispose();
    open();
    const texture = await loading;

    expect(disposed).toContain(texture);
  });

  function failFirstGltfLoad(): () => void {
    const original = GLTFLoader.prototype.loadAsync;
    let calls = 0;
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => (fail = resolve));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(function (
      this: GLTFLoader,
      url,
      onProgress,
    ) {
      if (calls++ === 0) return gate.then(() => Promise.reject(new Error(`${url}: 404`)));
      return original.call(this, url, onProgress);
    });
    return fail;
  }

  it('keeps a newer model cache entry when an older load finishes after dispose', async () => {
    const original = GLTFLoader.prototype.loadAsync;
    const releases: (() => void)[] = [];
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(function (
      this: GLTFLoader,
      url,
      onProgress,
    ) {
      const result = original.call(this, url, onProgress);
      return new Promise<Awaited<typeof result>>((resolve, reject) => {
        releases.push(() => result.then(resolve, reject));
      });
    });
    const first = library.load(MEMBER, 0, 1024);
    const disposing = library.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = library.load(MEMBER, 0, 1024);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases[0]?.();
    await first;
    await disposing;

    expect(library.load(MEMBER, 0, 1024)).toBe(second);
    releases.forEach((release) => release());
    await second;
  });

  const raceCases = [
    ['model', 'retainOnly', '', (l: ModelLibrary) => l.load(MEMBER, 0, 1024)],
    ['collision', 'retainOnly', '', (l: ModelLibrary) => l.collisionGeometry(MEMBER)],
    [
      'model',
      'dispose',
      ' (until the disposed library frees the newer load)',
      (l: ModelLibrary) => l.load(MEMBER, 0, 1024),
    ],
    [
      'collision',
      'dispose',
      ' (until the disposed library frees the newer load)',
      (l: ModelLibrary) => l.collisionGeometry(MEMBER),
    ],
  ] as const;

  it.each(raceCases)(
    'keeps a newer %s cache entry when %s evicts an older load that then fails%s',
    async (_cache, eviction, _scope, request) => {
      const fail = failFirstGltfLoad();
      const first = request(library);
      const firstResult = first.catch((error: unknown) => error);
      const evicting =
        eviction === 'retainOnly' ? library.retainOnly(new Set()) : library.dispose();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = request(library);
      fail();
      expect(await firstResult).toBeInstanceOf(Error);
      await evicting;

      expect(request(library)).toBe(second);
      await second;
    },
  );
});
