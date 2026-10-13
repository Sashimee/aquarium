import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import { AssetCatalog, ModelLibrary } from './assets';

const PUBLIC = join(__dirname, '../../public');

describe('ModelLibrary.collisionGeometry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads geometry without requesting any texture', async () => {
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
      { isWebGPURenderer: true, hasFeature: () => false } as unknown as WebGPURenderer,
      catalog,
    );
    const geometries = await library.collisionGeometry(rock.id);

    expect(geometries.length).toBeGreaterThan(0);
    expect(geometries[0]?.getAttribute('position').count).toBeGreaterThan(0);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((u) => /\.ktx2/.test(u))).toEqual([]);
    const fetched = requested.length;
    await library.collisionGeometry(rock.id);
    expect(requested.length).toBe(fetched);
  });
});
