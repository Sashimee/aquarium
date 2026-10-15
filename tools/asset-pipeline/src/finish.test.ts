import { describe, expect, it } from 'vitest';
import {
  addPores,
  packArm,
  spotImage,
  tintImage,
  upscaleTo,
  type Ramp,
  type SpotSpec,
  type TintSpec,
} from './finish.ts';
import type { Rgba } from './textures.ts';

function solid(size: number, rgb: [number, number, number]): Rgba {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { width: size, height: size, data };
}

function gradient(size: number): Rgba {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round((i % size) * (255 / (size - 1)));
    data.set([v, v, v, 255], i * 4);
  }
  return { width: size, height: size, data };
}

const flatNormal = (size: number): Rgba => solid(size, [128, 128, 255]);

const ramp: Ramp = { dark: [10, 0, 0], mid: [100, 50, 0], light: [200, 100, 50] };
const tint: TintSpec = { ramps: [ramp, ramp], mottleCells: 16, seed: 1 };

describe('tintImage', () => {
  it('maps dark pixels to the dark stop and bright pixels to the light stop', () => {
    const out = tintImage(gradient(64), tint);
    expect([...out.data.slice(0, 4)]).toEqual([10, 0, 0, 255]);
    const last = (64 - 1) * 4;
    expect([...out.data.slice(last, last + 4)]).toEqual([200, 100, 50, 255]);
  });

  it('stretches contrast over the lit pixels only when ignoreBelow is set', () => {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const v = i % size < 32 ? 0 : 128 + (i % size);
      data.set([v, v, v, 255], i * 4);
    }
    const image: Rgba = { width: size, height: size, data };
    const plain = tintImage(image, tint);
    const stretched = tintImage(image, { ...tint, ignoreBelow: 0.1 });
    const at = (img: Rgba, x: number): number => img.data[x * 4]!;
    expect(at(stretched, 33)).toBeLessThan(at(plain, 33));
    expect(at(stretched, 63)).toBe(200);
  });

  it('rejects an image with no pixel above ignoreBelow', () => {
    expect(() => tintImage(solid(8, [0, 0, 0]), { ...tint, ignoreBelow: 0.5 })).toThrow(
      'ignoreBelow',
    );
  });

  it('is deterministic', () => {
    const a = tintImage(gradient(64), { ...tint, ramps: [ramp, { ...ramp, mid: [0, 200, 0] }] });
    const b = tintImage(gradient(64), { ...tint, ramps: [ramp, { ...ramp, mid: [0, 200, 0] }] });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('does not collapse a flat image', () => {
    const out = tintImage(solid(32, [90, 90, 90]), tint);
    expect(out.data[3]).toBe(255);
  });
});

describe('spotImage', () => {
  const spec: SpotSpec = { cell: 16, radius: 0.4, density: 1, colour: [200, 190, 150], seed: 3 };

  it('paints some pixels towards the spot colour and leaves others alone', () => {
    const base = solid(64, [20, 20, 20]);
    const out = spotImage(base, spec);
    let spotted = 0;
    let untouched = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i]! > 100) spotted++;
      if (out.data[i] === 20) untouched++;
    }
    expect(spotted).toBeGreaterThan(0);
    expect(untouched).toBeGreaterThan(0);
  });

  it('paints nothing at zero density and keeps alpha', () => {
    const base = solid(32, [20, 20, 20]);
    const out = spotImage(base, { ...spec, density: -1 });
    expect(out.data).toEqual(base.data);
    expect(
      spotImage(base, spec)
        .data.filter((_, i) => i % 4 === 3)
        .every((a) => a === 255),
    ).toBe(true);
  });

  it('is deterministic', () => {
    const base = solid(32, [40, 30, 20]);
    expect(spotImage(base, spec).data).toEqual(spotImage(base, spec).data);
  });
});

describe('addPores', () => {
  const spec = { cell: 16, strength: 3, darken: 0.5, seed: 3 };

  it('keeps normals unit length and tilts them somewhere', () => {
    const { normal } = addPores(solid(128, [200, 200, 200]), flatNormal(128), spec);
    let tilted = 0;
    for (let i = 0; i < normal.data.length; i += 4) {
      const x = (normal.data[i]! / 255) * 2 - 1;
      const y = (normal.data[i + 1]! / 255) * 2 - 1;
      const z = (normal.data[i + 2]! / 255) * 2 - 1;
      expect(Math.hypot(x, y, z)).toBeGreaterThan(0.97);
      expect(Math.hypot(x, y, z)).toBeLessThan(1.03);
      if (normal.data[i] !== 128 || normal.data[i + 1] !== 128) tilted++;
    }
    expect(tilted).toBeGreaterThan(0);
  });

  it('darkens the colour inside pores but never brightens it', () => {
    const source = solid(128, [200, 200, 200]);
    const { baseColor } = addPores(source, flatNormal(128), spec);
    let darker = 0;
    for (let i = 0; i < baseColor.data.length; i += 4) {
      expect(baseColor.data[i]!).toBeLessThanOrEqual(200);
      if (baseColor.data[i]! < 190) darker++;
    }
    expect(darker).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = addPores(solid(64, [200, 200, 200]), flatNormal(64), spec);
    const b = addPores(solid(64, [200, 200, 200]), flatNormal(64), spec);
    expect(Buffer.from(a.normal.data).equals(Buffer.from(b.normal.data))).toBe(true);
  });

  it('rejects maps of different sizes', () => {
    expect(() => addPores(solid(64, [0, 0, 0]), flatNormal(32), spec)).toThrow(/square/);
  });
});

describe('packArm', () => {
  it('puts occlusion in red, roughness in green and zero metalness in blue', () => {
    const arm = packArm(solid(4, [10, 99, 99]), solid(4, [77, 1, 1]));
    expect([...arm.data.slice(0, 4)]).toEqual([10, 77, 0, 255]);
  });

  it('rejects mismatched sizes', () => {
    expect(() => packArm(solid(4, [0, 0, 0]), solid(8, [0, 0, 0]))).toThrow(/roughness/);
  });
});

describe('upscaleTo', () => {
  it('returns the same image when it already has the size', async () => {
    const image = solid(8, [1, 2, 3]);
    expect(await upscaleTo(image, 8)).toBe(image);
  });

  it('resizes to the requested square', async () => {
    const out = await upscaleTo(solid(8, [1, 2, 3]), 32);
    expect([out.width, out.height]).toEqual([32, 32]);
    expect(out.data.length).toBe(32 * 32 * 4);
  });
});
