import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { parseFishAssets } from './assetIndex';
import { disposeFishModel, FIN_ATTRIBUTE, FishAssetLoader, LEG_PART_ID } from './assets';
import { MOUTH_LODS } from './lod';
import { curlAboveFloor, curledTip, MAX_TAIL_CURL } from './walk';

const ROOT = '/assets/';
const PUBLIC = fileURLToPath(new URL('../../public/assets/', import.meta.url));
const SWIMMERS = [
  ...parseFishAssets(JSON.parse(readFileSync(`${PUBLIC}index.json`, 'utf8'))).values(),
]
  .filter((entry) => entry.shrimp === null)
  .map((entry) => entry.id);

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

  it.each(['cherry-shrimp', 'cleaner-shrimp'])(
    'packs the limb index of %s and finds a hip beside the body for every leg',
    async (id) => {
      serveShippedAssets();
      spyTextureLoads();
      const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
      const model = await loader.load(id);
      const entry = (await loader.entries()).get(id);
      if (entry?.shrimp == null) throw new Error(`${id}: no shrimp rig in the shipped index`);
      const halfWidth = Math.max(-entry.min[0], entry.max[0]);
      for (const [level, parts] of model.lods.entries()) {
        for (const part of parts) {
          const fin = part.geometry.getAttribute(FIN_ATTRIBUTE);
          expect(fin.itemSize).toBe(3);
          expect(part.legPivots).toHaveLength(entry.shrimp.legPairs * 2);
          const hasLegs = Array.from({ length: fin.count }, (_, i) => fin.getY(i)).includes(
            LEG_PART_ID,
          );
          if (!hasLegs) continue;
          part.legPivots.forEach((hip, leg) => {
            if (level === 0) expect(hip, `${id} leg ${leg}`).not.toBeNull();
            if (hip === null) return;
            expect(Math.sign(hip[0]), `${id} leg ${leg} side`).toBe(leg % 2 === 0 ? -1 : 1);
            expect(Math.abs(hip[0])).toBeLessThan(halfWidth);
            expect(hip[1]).toBeLessThan(entry.max[1]);
          });
        }
      }
      disposeFishModel(model);
    },
  );

  it.each(['cherry-shrimp', 'cleaner-shrimp'])(
    'finds the tail tip of %s, which a full curl on the floor would put into the sand',
    async (id) => {
      serveShippedAssets();
      spyTextureLoads();
      const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
      const model = await loader.load(id);
      const entry = (await loader.entries()).get(id);
      if (entry?.shrimp == null || model.tail === null) throw new Error(`${id}: no tail rig`);
      const { tail } = model;
      expect(tail.hinge).toEqual(entry.shrimp.hinge);
      expect(tail.tip.share).toBe(1);
      expect(tail.tip.z).toBeGreaterThan(entry.min[2] - 1e-6);

      // A millimetre into a flip off the floor, a full curl would still sweep the fan deep below.
      const floor = 0;
      const y = -entry.min[1] + 0.001;
      const level = { x: 0, y: 0, z: 0, w: 1 };
      expect(y + curledTip(tail, MAX_TAIL_CURL).y).toBeLessThan(floor - 0.005);
      const curl = curlAboveFloor(MAX_TAIL_CURL, tail, 1, { y }, level, floor);
      expect(curl).toBeGreaterThan(0);
      expect(y + curledTip(tail, curl).y).toBeGreaterThan(floor);
      disposeFishModel(model);
    },
  );

  it('keeps a fish without hips', async () => {
    serveShippedAssets();
    spyTextureLoads();
    const model = await new FishAssetLoader(new KTX2Loader(), ROOT).load('neon-tetra');
    for (const part of model.lods.flat()) expect(part.legPivots).toEqual([]);
    expect(model.tail).toBeNull();
    disposeFishModel(model);
  });

  it('checks the mouth packing of every shipped swimmer', () => {
    expect(SWIMMERS).toContain('neon-tetra');
    expect(SWIMMERS).toContain('discus');
    expect(SWIMMERS.length).toBeGreaterThanOrEqual(15);
  });

  it.each(SWIMMERS)(
    'packs the mouth weight of %s into its near LODs only, peaking at 1 off the fins',
    async (id) => {
      serveShippedAssets();
      spyTextureLoads();
      const model = await new FishAssetLoader(new KTX2Loader(), ROOT).load(id);
      expect(model.lods.length).toBeGreaterThan(MOUTH_LODS);
      for (const [level, parts] of model.lods.entries()) {
        let peak = 0;
        for (const part of parts) {
          const fin = part.geometry.getAttribute(FIN_ATTRIBUTE);
          expect(part.mouth).toBe(level < MOUTH_LODS && fin.itemSize === 3);
          expect(fin.itemSize).toBe(part.mouth ? 3 : 2);
          if (!part.mouth) continue;
          for (let i = 0; i < fin.count; i++) {
            const weight = fin.getZ(i);
            expect(weight).toBeGreaterThanOrEqual(0);
            expect(weight).toBeLessThanOrEqual(1);
            if (fin.getY(i) !== 0) expect(weight).toBe(0);
            peak = Math.max(peak, weight);
          }
        }
        expect(peak, `${id} lod${level}`).toBe(level < MOUTH_LODS ? 1 : 0);
      }
      disposeFishModel(model);
    },
  );
});
