import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressedTexture } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { parseFishAssets } from './assetIndex';
import {
  disposeFishModel,
  FIN_ATTRIBUTE,
  FishAssetLoader,
  LEG_PART_ID,
  SHARP_TEXTURE_MIN_LENGTH_M,
} from './assets';
import { MOUTH_LODS } from './lod';
import { curlAboveFloor, curledTip, MAX_TAIL_CURL } from './walk';

const ROOT = '/assets/';
const PUBLIC = fileURLToPath(new URL('../../public/assets/', import.meta.url));
const SWIMMERS = [
  ...parseFishAssets(JSON.parse(readFileSync(`${PUBLIC}index.json`, 'utf8'))).values(),
]
  .filter((entry) => entry.kind === 'fish')
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
    const model = await loader.load('betta');

    expect(model.textureSize).toBe(2048);
    expect(new Set(urls)).toEqual(
      new Set([
        '/assets/fish/betta/textures/betta_basecolor_2k.ktx2',
        '/assets/fish/betta/textures/betta_normal_2k.ktx2',
      ]),
    );
    disposeFishModel(model);
  });

  it('keeps an animal under 4 cm on its 1k maps at 2048, even where a 2k set ships', async () => {
    serveShippedAssets();
    const urls = spyTextureLoads();
    const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
    loader.textureSize = 2048;
    const neon = (await loader.entries()).get('neon-tetra');
    if (neon === undefined) throw new Error('shipped index changed');
    expect(neon.sharperTextures.size).toBeGreaterThan(0);
    expect(neon.standardLengthM).toBeLessThan(SHARP_TEXTURE_MIN_LENGTH_M);

    const model = await loader.load('neon-tetra');
    expect(model.textureSize).toBe(1024);
    expect(
      urls.every((url) => url.endsWith('_1k.ktx2')),
      urls.join(),
    ).toBe(true);
    disposeFishModel(model);
  });

  it('keeps a model with no larger 2k map at 1024, so a tier change never reloads it', async () => {
    serveShippedAssets();
    spyTextureLoads();
    const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
    loader.textureSize = 2048;
    const entries = await loader.entries();
    const corydoras = entries.get('bronze-corydoras');
    const angelfish = entries.get('angelfish');
    if (corydoras === undefined || angelfish === undefined) {
      throw new Error('shipped index changed');
    }

    expect(loader.textureSizeFor(corydoras)).toBe(1024);
    expect(loader.textureSizeFor(angelfish)).toBe(2048);
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

  it("finds the hermit crab's leg hips on the side its slot names, and the shell it sits in", async () => {
    serveShippedAssets();
    spyTextureLoads();
    const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
    const model = await loader.load('hermit-crab');
    const entry = (await loader.entries()).get('hermit-crab');
    if (entry?.shrimp == null || entry.standoff === null) throw new Error('hermit-crab: no rig');
    const [lod0] = model.lods;
    if (lod0 === undefined) throw new Error('hermit-crab: no LOD0');
    for (const part of lod0) {
      expect(part.geometry.getAttribute(FIN_ATTRIBUTE).itemSize).toBe(3);
      expect(part.legPivots).toHaveLength(entry.shrimp.legPairs * 2);
      part.legPivots.forEach((hip, leg) => {
        if (hip === null) return;
        expect(Math.sign(hip[0]), `leg ${leg} side`).toBe(leg % 2 === 0 ? -1 : 1);
      });
    }
    expect(lod0.some((part) => part.legPivots.some((hip) => hip !== null))).toBe(true);
    expect(model.tail).not.toBeNull();
    const { shell } = model;
    if (shell === null) throw new Error('hermit-crab: no shell rig');
    expect(shell.centre[1]).toBeGreaterThan(entry.min[1]);
    expect(shell.centre[1]).toBeLessThan(entry.max[1]);
    // The shell rests on its underside once the legs fold away, a little above the feet.
    expect(shell.drop).toBeGreaterThan(0);
    expect(shell.drop).toBeLessThan(entry.standoff);
    disposeFishModel(model);
  });

  it('loads the nerite snail with its foot weights and no legs, its shell already on the sole', async () => {
    serveShippedAssets();
    spyTextureLoads();
    const loader = new FishAssetLoader(new KTX2Loader(), ROOT);
    const model = await loader.load('nerite-snail');
    for (const part of model.lods.flat()) {
      expect(part.geometry.getAttribute(FIN_ATTRIBUTE).itemSize).toBe(2);
      expect(part.legPivots).toEqual([]);
      expect(part.mouth).toBe(false);
    }
    expect(model.tail).toBeNull();
    const { shell } = model;
    if (shell === null) throw new Error('nerite-snail: no shell rig');
    expect(shell.centre[1]).toBeGreaterThan(0);
    expect(shell.drop).toBeLessThan(0.0005);
    disposeFishModel(model);
  });

  it('keeps a fish without hips', async () => {
    serveShippedAssets();
    spyTextureLoads();
    const model = await new FishAssetLoader(new KTX2Loader(), ROOT).load('neon-tetra');
    for (const part of model.lods.flat()) expect(part.legPivots).toEqual([]);
    expect(model.tail).toBeNull();
    expect(model.shell).toBeNull();
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
