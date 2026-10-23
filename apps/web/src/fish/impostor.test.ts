import { describe, expect, it, vi } from 'vitest';
import { CompressedTexture, LinearFilter, LinearMipmapLinearFilter } from 'three/webgpu';
import type { Ktx2Textures } from '../engine/ktx2';
import type { ImpostorAtlasInfo } from './assetIndex';
import {
  IMPOSTOR_STRIDE,
  ImpostorInstanceData,
  ImpostorSlot,
  droppedNormalLevels,
  loadImpostorAtlas,
  type ImpostorValues,
} from './impostor';
import { InstanceSlot } from './instances';

const values: ImpostorValues = {
  qx: 0.1,
  qy: 0.2,
  qz: 0.3,
  qw: 0.9,
  scale: 1.5,
  phase: 2,
  amplitude: 0.7,
  curvature: -3,
  viewX: 0.6,
  viewY: 0.8,
  viewZ: 0,
  pale: 0.25,
  tint: [1.1, 0.9, 1],
  youth: 0.375,
  frames: { i: 3, j: 7, fx: 0.25, fy: 0.75 },
  ich: 0.9,
  finRot: 0.5,
  velvet: 0.125,
};

describe('ImpostorInstanceData', () => {
  it('writes each vec4 slot where the material reads it', () => {
    const data = new ImpostorInstanceData(4);
    data.write(2, values);
    const at = (slot: number): number[] =>
      Array.from(data.array.subarray(2 * IMPOSTOR_STRIDE + slot, 2 * IMPOSTOR_STRIDE + slot + 4));
    const near = (actual: number[], expected: number[]): void =>
      expected.forEach((e, k) => expect(actual[k]).toBeCloseTo(e, 6));
    near(at(ImpostorSlot.Orientation), [0.1, 0.2, 0.3, 0.9]);
    near(at(ImpostorSlot.Swim), [1.5, 2, 0.7, -3]);
    near(at(ImpostorSlot.View), [0.6, 0.8, 0, 0.25]);
    near(at(ImpostorSlot.Tint), [1.1, 0.9, 1, 0.375]);
    near(at(ImpostorSlot.Frames), [3, 7, 0.25, 0.75]);
    near(at(ImpostorSlot.Illness), [0.9, 0.5, 0.125, 0]);
    expect(data.array.subarray(0, 2 * IMPOSTOR_STRIDE).every((x) => x === 0)).toBe(true);
  });

  it('keeps the disease signs at the offset the meshes read them from', () => {
    expect(ImpostorSlot.Illness).toBe(InstanceSlot.Ich);
    expect(ImpostorSlot.Illness + 1).toBe(InstanceSlot.FinRot);
    expect(ImpostorSlot.Illness + 2).toBe(InstanceSlot.Velvet);
    expect(ImpostorSlot.Illness + 4).toBe(IMPOSTOR_STRIDE);
  });

  it('collapses a slot to zero scale with a finite, unit view direction', () => {
    const data = new ImpostorInstanceData(2);
    data.write(1, values);
    data.collapse(1);
    const slot = data.array.subarray(IMPOSTOR_STRIDE, 2 * IMPOSTOR_STRIDE);
    expect(slot[ImpostorSlot.Swim]).toBe(0);
    expect(Array.from(slot.subarray(ImpostorSlot.View, ImpostorSlot.View + 4))).toEqual([
      1, 0, 0, 0,
    ]);
    expect(Math.hypot(...slot.subarray(ImpostorSlot.View, ImpostorSlot.View + 3))).toBe(1);
    const rest = Array.from(slot).filter((_, k) => k !== ImpostorSlot.View);
    expect(rest.every((x) => x === 0)).toBe(true);
    expect(data.array.subarray(0, IMPOSTOR_STRIDE).every((x) => x === 0)).toBe(true);
  });

  it('marks the buffer for upload on commit', () => {
    const data = new ImpostorInstanceData(1);
    const version = data.buffer.version;
    data.commit();
    expect(data.buffer.version).toBeGreaterThan(version);
  });

  it('rejects a bad capacity or a slot outside it', () => {
    expect(() => new ImpostorInstanceData(0)).toThrow(RangeError);
    expect(() => new ImpostorInstanceData(2.5)).toThrow(RangeError);
    const data = new ImpostorInstanceData(2);
    expect(() => data.write(2, values)).toThrow(RangeError);
    expect(() => data.collapse(-1)).toThrow(RangeError);
  });
});

describe('droppedNormalLevels', () => {
  it('halves the frames down to 64 px and no further', () => {
    expect(droppedNormalLevels(32)).toBe(0);
    expect(droppedNormalLevels(64)).toBe(0);
    expect(droppedNormalLevels(128)).toBe(1);
    expect(droppedNormalLevels(256)).toBe(2);
  });
});

describe('loadImpostorAtlas', () => {
  const info: ImpostorAtlasInfo = {
    grid: 9,
    frameSize: 128,
    pivot: [0, 0, 0],
    radius: 0.05,
    albedoFile: 'fish/x/impostor_albedo.ktx2',
    normalFile: 'fish/x/impostor_normal.ktx2',
  };

  function texture(mips: number, size = 2 ** (mips - 1)): CompressedTexture {
    const levels = Array.from({ length: mips }, (_, level) => ({
      data: new Uint8Array(4),
      width: Math.max(1, size >> level),
      height: Math.max(1, size >> level),
    }));
    const t = new CompressedTexture(levels, size, size);
    t.generateMipmaps = true;
    return t;
  }

  it('loads both atlases from the asset root, filtered on their own mips', async () => {
    const albedo = texture(5);
    const normal = texture(2, 1152);
    const loadAsync = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('albedo.ktx2') ? albedo : normal),
    );
    const ktx2 = { loadAsync } as unknown as Ktx2Textures;
    const atlas = await loadImpostorAtlas(ktx2, '/assets/', info);
    expect(loadAsync.mock.calls.map(([url]) => url).sort()).toEqual([
      '/assets/fish/x/impostor_albedo.ktx2',
      '/assets/fish/x/impostor_normal.ktx2',
    ]);
    expect(atlas.albedo).toBe(albedo);
    expect(atlas.albedo.minFilter).toBe(LinearMipmapLinearFilter);
    expect(atlas.normal.minFilter).toBe(LinearFilter);
    expect(atlas.albedo.generateMipmaps).toBe(false);
  });

  it('uploads the normal atlas of 128 px frames from its second level, at 64 px frames', async () => {
    const albedo = texture(11, 1152);
    const normal = texture(11, 1152);
    const top = normal.mipmaps[1];
    const ktx2 = {
      loadAsync: (url: string) => Promise.resolve(url.endsWith('albedo.ktx2') ? albedo : normal),
    } as unknown as Ktx2Textures;
    const atlas = await loadImpostorAtlas(ktx2, '/assets/', info);
    expect(atlas.albedo.image).toEqual({ width: 1152, height: 1152 });
    expect(atlas.albedo.mipmaps).toHaveLength(11);
    expect(atlas.normal.image).toEqual({ width: 576, height: 576 });
    expect(atlas.normal.mipmaps).toHaveLength(10);
    expect(atlas.normal.mipmaps[0]).toBe(top);
    expect(atlas.normal.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it('shrinks a normal atlas shared by overlapping loads of its URL only once', async () => {
    const normal = texture(11, 1152);
    const top = normal.mipmaps[1];
    const ktx2 = {
      loadAsync: (url: string) =>
        Promise.resolve(url.endsWith('albedo.ktx2') ? texture(11, 1152) : normal),
    } as unknown as Ktx2Textures;
    const [first, second] = await Promise.all([
      loadImpostorAtlas(ktx2, '/assets/', info),
      loadImpostorAtlas(ktx2, '/assets/', info),
    ]);
    for (const atlas of [first, second]) {
      expect(atlas.normal).toBe(normal);
      expect(atlas.normal.image).toEqual({ width: 576, height: 576 });
      expect(atlas.normal.mipmaps).toHaveLength(10);
      expect(atlas.normal.mipmaps[0]).toBe(top);
    }
  });

  it('shrinks 256 px frames by two levels, and a second load leaves them there', async () => {
    const normal = texture(12, 2304);
    const ktx2 = {
      loadAsync: (url: string) =>
        Promise.resolve(url.endsWith('albedo.ktx2') ? texture(12, 2304) : normal),
    } as unknown as Ktx2Textures;
    const wide = { ...info, frameSize: 256 };
    await loadImpostorAtlas(ktx2, '/assets/', wide);
    const atlas = await loadImpostorAtlas(ktx2, '/assets/', wide);
    expect(atlas.normal.image).toEqual({ width: 576, height: 576 });
    expect(atlas.normal.mipmaps).toHaveLength(10);
  });

  it('rejects a normal atlas whose size is not grid * frameSize, and frees both', async () => {
    const albedo = texture(11, 1152);
    const normal = texture(11, 1024);
    const disposed = [vi.spyOn(albedo, 'dispose'), vi.spyOn(normal, 'dispose')];
    const ktx2 = {
      loadAsync: (url: string) => Promise.resolve(url.endsWith('albedo.ktx2') ? albedo : normal),
    } as unknown as Ktx2Textures;
    await expect(loadImpostorAtlas(ktx2, '/assets/', info)).rejects.toThrow(
      /impostor_normal\.ktx2 is 1024 px wide, but grid \* frameSize is 1152/,
    );
    for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps every level of an atlas already at 64 px frames', async () => {
    const normal = texture(10, 576);
    const ktx2 = {
      loadAsync: (url: string) =>
        Promise.resolve(url.endsWith('albedo.ktx2') ? texture(10, 576) : normal),
    } as unknown as Ktx2Textures;
    const atlas = await loadImpostorAtlas(ktx2, '/assets/', { ...info, frameSize: 64 });
    expect(atlas.normal.image).toEqual({ width: 576, height: 576 });
    expect(atlas.normal.mipmaps).toHaveLength(10);
  });

  it('rejects a normal atlas without the level it would shrink to, and frees both', async () => {
    const albedo = texture(5);
    const normal = texture(1, 1152);
    const disposed = [vi.spyOn(albedo, 'dispose'), vi.spyOn(normal, 'dispose')];
    const ktx2 = {
      loadAsync: (url: string) => Promise.resolve(url.endsWith('albedo.ktx2') ? albedo : normal),
    } as unknown as Ktx2Textures;
    await expect(loadImpostorAtlas(ktx2, '/assets/', info)).rejects.toThrow(
      /impostor_normal\.ktx2 has 1 mip levels/,
    );
    for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the atlas that loaded when the other fails, and says which failed', async () => {
    const albedo = texture(5);
    const dispose = vi.spyOn(albedo, 'dispose');
    const cause = new Error('404');
    const ktx2 = {
      loadAsync: (url: string) =>
        url.endsWith('albedo.ktx2') ? Promise.resolve(albedo) : Promise.reject(cause),
    } as unknown as Ktx2Textures;
    const failure = loadImpostorAtlas(ktx2, '/assets/', info);
    await expect(failure).rejects.toThrow(/impostor_normal\.ktx2/);
    await expect(failure).rejects.toHaveProperty('cause', cause);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
