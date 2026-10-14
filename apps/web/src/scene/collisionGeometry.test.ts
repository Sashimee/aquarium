import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BufferGeometry, CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import { createSharedKtx2 } from '../engine/ktx2';
import { AssetCatalog, ModelLibrary, type ModelLod } from './assets';

const PUBLIC = join(__dirname, '../../public');

async function setup() {
  const index = JSON.parse(await readFile(join(PUBLIC, 'assets/index.json'), 'utf8')) as {
    assets: ConstructorParameters<typeof AssetCatalog>[0];
  };
  const catalog = new AssetCatalog(index.assets);
  const rock = [...catalog.entries()].find((e) => e.kind === 'rock');
  if (!rock) throw new Error('no rock in the asset index; run pnpm build:assets');

  const requested: string[] = [];
  vi.stubGlobal('ProgressEvent', Event);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal(
    'Request',
    class {
      constructor(readonly url: string) {}
    },
  );
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'object' && 'url' in input ? input.url : String(input);
    requested.push(url);
    const bytes = await readFile(join(PUBLIC, new URL(url, 'http://x').pathname));
    return new Response(new Uint8Array(bytes));
  });

  const library = new ModelLibrary(
    createSharedKtx2({
      isWebGPURenderer: true,
      hasFeature: () => false,
    } as unknown as WebGPURenderer).loader,
    catalog,
  );
  const lowLod = Math.min(2, rock.lods.length - 1) as ModelLod;
  return { library, rock, requested, lowLod };
}

describe('ModelLibrary.collisionGeometry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads geometry without requesting any texture', async () => {
    const { library, rock, requested } = await setup();
    const geometries = await library.collisionGeometry(rock.id);

    expect(geometries.length).toBeGreaterThan(0);
    expect(geometries[0]?.getAttribute('position').count).toBeGreaterThan(0);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((u) => /\.ktx2/.test(u))).toEqual([]);
    const fetched = requested.length;
    await library.collisionGeometry(rock.id);
    expect(requested.length).toBe(fetched);
  });

  it('matches the positions load() returns for the same LOD', async () => {
    const { library, rock, lowLod } = await setup();
    vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation((_url, onLoad) => {
      onLoad(new CompressedTexture([], 1, 1));
    });
    const collision = await library.collisionGeometry(rock.id);
    const rendered = await library.load(rock.id, lowLod, 1024);

    expect(collision.length).toBe(rendered.primitives.length);
    collision.forEach((geometry, i) => {
      const expected = rendered.primitives[i]?.geometry.getAttribute('position');
      const actual = geometry.getAttribute('position');
      expect(actual.count).toBe(expected?.count);
      expect(Array.from(actual.array)).toEqual(Array.from(expected?.array ?? []));
    });
  });

  it('parses the model once when the render path loaded the same LOD', async () => {
    const { library, rock, requested, lowLod } = await setup();
    vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation((_url, onLoad) => {
      onLoad(new CompressedTexture([], 1, 1));
    });
    await library.load(rock.id, lowLod, 1024);
    const glbFetches = () => requested.filter((u) => /\.glb/.test(u)).length;
    const before = glbFetches();
    expect(before).toBe(1);
    const geometries = await library.collisionGeometry(rock.id);
    expect(geometries.length).toBeGreaterThan(0);
    expect(glbFetches()).toBe(before);
  });

  it('does not share vertex arrays with the render model and survives its disposal', async () => {
    const { library, rock, lowLod } = await setup();
    vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation((_url, onLoad) => {
      onLoad(new CompressedTexture([], 1, 1));
    });
    const rendered = await library.load(rock.id, lowLod, 1024);
    const collision = await library.collisionGeometry(rock.id);

    expect(collision.length).toBe(rendered.primitives.length);
    collision.forEach((geometry, i) => {
      const renderGeometry = rendered.primitives[i]?.geometry;
      expect(geometry.getAttribute('position').array).not.toBe(
        renderGeometry?.getAttribute('position').array,
      );
    });
    const before = collision.map((g) => Array.from(g.getAttribute('position').array));
    for (const primitive of rendered.primitives) {
      primitive.geometry.getAttribute('position').array.fill(0);
      primitive.geometry.dispose();
    }
    expect(collision.map((g) => Array.from(g.getAttribute('position').array))).toEqual(before);
  });

  it('does not wait on an in-flight render load', async () => {
    const { library, rock, lowLod } = await setup();
    vi.spyOn(KTX2Loader.prototype, 'load').mockImplementation(() => {});
    void library.load(rock.id, lowLod, 1024);
    const geometries = await library.collisionGeometry(rock.id);
    expect(geometries.length).toBeGreaterThan(0);
  });

  it('retainOnly drops collision geometry of assets no longer kept and refetches on demand', async () => {
    const { library, rock, lowLod, requested } = await setup();
    const first = await library.collisionGeometry(rock.id);
    const disposed = vi.spyOn(first[0] as BufferGeometry, 'dispose');

    await library.retainOnly(new Set([library.modelKey(rock.id, lowLod, 1024)]));
    expect(disposed).not.toHaveBeenCalled();

    await library.retainOnly(new Set());
    expect(disposed).toHaveBeenCalledOnce();

    const before = requested.length;
    await library.collisionGeometry(rock.id);
    expect(requested.length).toBeGreaterThan(before);
  });
});
